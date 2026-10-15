// Webhook бота: /start, /start <код> и код, отправленный обычным сообщением.
// Telegram вызывает эту функцию сам, поэтому деплоим с --no-verify-jwt.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// Код привязки: 16 символов из букв и цифр
const CODE_PATTERN = /^[a-zA-Z0-9]{16}$/;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const update = await req.json().catch(() => null);
  const message = update?.message;
  const text: string = (message?.text ?? "").trim();

  if (!text) return new Response("ok");

  const chatId: number = message.chat.id;

  if (text.startsWith("/help")) {
    await sendMessage(
      chatId,
      "Как подключить уведомления:\n\n1. Откройте Sweetly и зайдите в «Настройки».\n2. Нажмите «Telegram».\n3. Отправьте мне код, который там появится, или нажмите «Открыть Telegram».",
    );

    return new Response("ok");
  }

  // Код можно прислать как /start <код>, либо просто сообщением
  let payload: string | undefined;

  if (text.startsWith("/start")) {
    payload = text.split(/\s+/)[1];
  } else if (CODE_PATTERN.test(text)) {
    payload = text;
  } else {
    await sendMessage(
      chatId,
      "Привет! Я Sweetly ❤️\n\nЧтобы получать уведомления от партнёра, откройте приложение, зайдите в «Настройки» и нажмите «Telegram». Там будет код, его можно отправить мне сообщением.",
    );

    return new Response("ok");
  }

  // Обычный /start без кода
  if (!payload) {
    await sendMessage(
      chatId,
      "Привет! Я Sweetly ❤️\n\nОткройте приложение, зайдите в «Настройки» и нажмите «Telegram», чтобы я начал присылать уведомления от партнёра.",
    );

    return new Response("ok");
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: codeRow } = await admin
    .from("telegram_link_codes")
    .select("user_id, expires_at")
    .eq("code", payload)
    .maybeSingle();

  if (!codeRow || new Date(codeRow.expires_at) < new Date()) {
    await sendMessage(
      chatId,
      "Код не подошёл или устарел. Откройте приложение, зайдите в «Настройки» и нажмите «Telegram» ещё раз.",
    );

    return new Response("ok");
  }

  const { error } = await admin.from("telegram_links").upsert(
    {
      telegram_id: message.from.id,
      telegram_username: message.from.username ?? null,
      user_id: codeRow.user_id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_id" },
  );

  if (error) {
    await sendMessage(chatId, "Не получилось привязать аккаунт. Попробуйте ещё раз.");

    return new Response("ok");
  }

  await admin.from("telegram_link_codes").delete().eq("code", payload);

  await sendMessage(chatId, "Готово! Теперь я буду присылать уведомления от партнёра ❤️");

  return new Response("ok");
});
