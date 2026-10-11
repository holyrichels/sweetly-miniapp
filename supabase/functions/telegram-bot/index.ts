// Webhook бота: /start и /start <код привязки>.
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

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const update = await req.json().catch(() => null);
  const message = update?.message;
  const text: string = message?.text ?? "";

  if (!text.startsWith("/start")) return new Response("ok");

  const chatId: number = message.chat.id;
  const payload = text.split(" ")[1]?.trim();

  // Обычный /start без кода
  if (!payload) {
    await sendMessage(
      chatId,
      "Привет! Я Sweetly ❤️\n\nОткрой приложение, зайди в «Настройки» и нажми «Telegram», чтобы я начал присылать уведомления от партнёра.",
    );
    return new Response("ok");
  }

  // /start с кодом привязки из приложения
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
      "Ссылка устарела. Открой приложение, зайди в «Настройки» и нажми «Telegram» ещё раз.",
    );
    return new Response("ok");
  }

  const { error } = await admin.from("telegram_links").upsert(
    {
      telegram_id: message.from.id,
      user_id: codeRow.user_id,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "telegram_id" },
  );

  if (error) {
    await sendMessage(chatId, "Не получилось привязать аккаунт. Попробуй ещё раз.");
    return new Response("ok");
  }

  await admin.from("telegram_link_codes").delete().eq("code", payload);

  await sendMessage(
    chatId,
    "Готово! Теперь я буду присылать уведомления от партнёра ❤️",
  );

  return new Response("ok");
});