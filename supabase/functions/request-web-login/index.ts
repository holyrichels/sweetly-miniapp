// Вызывается из Mini App (пользователь уже вошёл через Telegram).
// Создаёт одноразовый код и присылает его в чат с ботом.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const encoder = new TextEncoder();

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

async function hashSecret(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(SERVICE_ROLE_KEY),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(value));

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  let stage = "authenticate_user";

  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "unauthorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    stage = "verify_user";
    const { data: userData, error: authError } = await admin.auth.getUser(token);

    if (authError || !userData.user) return json({ error: "unauthorized" }, 401);

    stage = "lookup_telegram_link";
    const { data: link, error: linkError } = await admin
      .from("telegram_links")
      .select("telegram_id")
      .eq("user_id", userData.user.id)
      .maybeSingle();

    if (linkError) throw linkError;
    if (!link) return json({ error: "not linked" }, 400);

    stage = "generate_code";
    // 8 символов без похожих (0, O, 1, I)
    const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

    const bytes = crypto.getRandomValues(new Uint8Array(8));

    const code = Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
    const codeHash = await hashSecret(`web-login-code:${code}`);

    stage = "store_code";
    const { data: issued, error: issueError } = await admin.rpc(
      "issue_web_login_code",
      { p_user_id: userData.user.id, p_code_hash: codeHash },
    );

    if (issueError) throw issueError;
    if (!issued) {
      return json(
        { error: "code request rate limited", retry_after_seconds: 30 },
        429,
      );
    }

    stage = "send_telegram_message";
    const telegramResponse = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: link.telegram_id,
        text: `Код для входа в Sweetly: ${code}\n\nДействует 10 минут. Никому его не сообщайте.`,
      }),
    });
    const telegramResult = await telegramResponse.json().catch(() => null);

    if (!telegramResponse.ok || telegramResult.ok !== true) {
      const { error: revokeError } = await admin.rpc(
        "revoke_web_login_code",
        { p_code_hash: codeHash },
      );
      if (revokeError) {
        console.error("Could not revoke undelivered web login code:", revokeError);
      }
      console.error("Telegram sendMessage failed:", telegramResult);
      return json({ error: "telegram delivery failed" }, 502);
    }

    // Код возвращаем Mini App, чтобы он подставился в ссылку браузера
    return json({ sent: true, code });
  } catch (error) {
    console.error(`request-web-login failed at ${stage}:`, error);
    return json({ error: "internal error", stage }, 500);
  }
});