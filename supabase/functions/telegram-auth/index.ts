// Вход через Telegram только для уже привязанного аккаунта.
// Если Telegram не привязан, создавать новый пустой аккаунт не нужно:
// приложение покажет обычный экран входа, а привязка произойдёт после входа по почте.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_AGE_SECONDS = 60 * 60 * 24;
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

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: BufferSource, message: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(message));
}

async function verifyInitData(initData: string): Promise<{ id: number } | null> {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  if (toHex(await hmac(secretKey, dataCheckString)) !== receivedHash) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  return JSON.parse(userRaw) as { id: number };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = await req.json();
    const tgUser = await verifyInitData(String(body.initData ?? ""));

    if (!tgUser?.id) return json({ error: "invalid telegram data" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: link } = await admin
      .from("telegram_links")
      .select("user_id")
      .eq("telegram_id", tgUser.id)
      .maybeSingle();

    // Telegram ещё не привязан к аккаунту приложения: вход не выдаём
    if (!link) return json({ linked: false });

    const { data: userData, error: userError } = await admin.auth.admin.getUserById(link.user_id);

    if (userError || !userData.user?.email) throw userError ?? new Error("user not found");

    // Одноразовая ссылка входа для привязанного аккаунта, пароль не нужен
    const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: userData.user.email,
    });

    if (linkError || !linkData.properties?.hashed_token) throw linkError ?? new Error("no token");

    return json({
      linked: true,
      token_hash: linkData.properties.hashed_token,
      type: "magiclink",
    });
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});