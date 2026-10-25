// Вызывается из Mini App (пользователь уже вошёл через Telegram).
// Создаёт одноразовый код и присылает его в чат с ботом.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  try {
    const userClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: authError } = await userClient.auth.getUser();

    if (authError || !userData.user) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: link, error: linkError } = await admin
      .from("telegram_links")
      .select("telegram_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (linkError) throw linkError;
    if (!link) return json({ error: "not linked" }, 400);

    // 8 символов без похожих (0, O, 1, I)
    const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    const bytes = crypto.getRandomValues(new Uint8Array(8));

    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");

    // Старые коды этого пользователя больше не действуют
    const { error: deleteError } = await admin
      .from("web_login_codes")
      .delete()
      .eq("user_id", userData.user.id);

    if (deleteError) throw deleteError;

    const { error: insertError } = await admin.from("web_login_codes").insert({
      code,
      user_id: userData.user.id,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    if (insertError) throw insertError;

    const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: link.telegram_id,
        text: `Код для входа в Sweetly: ${code}\n\nДействует 10 минут. Никому его не сообщайте.`,
      }),
    });
    const telegramResult = await telegramResponse.json();

    if (!telegramResponse.ok || telegramResult.ok !== true) {
      console.error("Telegram sendMessage failed:", telegramResult);
      return json({ error: "telegram delivery failed" }, 502);
    }

    // Код возвращаем Mini App, чтобы он подставился в ссылку браузера
    return json({ sent: true, code });
  } catch (error) {
    console.error("request-web-login failed:", error);
    return json({ error: "internal error" }, 500);
  }
});