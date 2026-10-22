// Вызывается из Mini App (пользователь уже вошёл через Telegram).
// Создаёт 6-значный код и присылает его в чат с ботом.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData } = await userClient.auth.getUser();

  const user = userData.user;

  if (!user) return json({ error: "unauthorized" }, 401);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: link } = await admin
    .from("telegram_links")
    .select("telegram_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!link) return json({ error: "not linked" }, 400);

  // 8 символов без похожих (0, O, 1, I)
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

  const bytes = crypto.getRandomValues(new Uint8Array(8));

  const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");

  // Старые коды этого пользователя больше не действуют
  await admin.from("web_login_codes").delete().eq("user_id", user.id);

  await admin.from("web_login_codes").insert({
    code,
    user_id: user.id,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
  });

  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: link.telegram_id,
      text: `Код для входа в Sweetly: ${code}\n\nДействует 10 минут. Никому его не сообщайте.`,
    }),
  });

  // Код возвращаем Mini App, чтобы он подставился в ссылку браузера
  return json({ sent: true, code });
});