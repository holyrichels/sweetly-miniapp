// Supabase Edge Function: проверяет initData из Telegram Mini App
// и выдаёт пользователю вход в Supabase.
//
// Секреты (задаются в Supabase, НЕ в коде):
//   supabase secrets set TELEGRAM_BOT_TOKEN=...      (новый токен бота)
//   supabase secrets set TG_AUTH_SECRET=...           (любая длинная случайная строка)
// SUPABASE_URL и SUPABASE_SERVICE_ROLE_KEY Supabase подставляет сам.

import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const TG_AUTH_SECRET = Deno.env.get("TG_AUTH_SECRET")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_AGE_SECONDS = 60 * 60 * 24; // initData считается свежим сутки

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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

// Проверка подписи по официальной схеме Telegram:
// secret = HMAC_SHA256("WebAppData", bot_token)
// hash   = HMAC_SHA256(secret, отсортированные пары key=value через \n)
async function verifyInitData(initData: string) {
  const params = new URLSearchParams(initData);
  const receivedHash = params.get("hash");
  if (!receivedHash) return null;

  params.delete("hash");
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = await hmac(encoder.encode("WebAppData"), BOT_TOKEN);
  const expectedHash = toHex(await hmac(secretKey, dataCheckString));

  if (expectedHash !== receivedHash) return null;

  const authDate = Number(params.get("auth_date") ?? 0);
  if (Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

  const userRaw = params.get("user");
  if (!userRaw) return null;

  return JSON.parse(userRaw) as {
    id: number;
    first_name?: string;
    last_name?: string;
    username?: string;
  };
}

// Пароль для Supabase-аккаунта выводится из telegram id и секрета,
// поэтому клиент его не хранит, а получает каждый раз после проверки.
async function passwordFor(telegramId: number): Promise<string> {
  return toHex(await hmac(encoder.encode(TG_AUTH_SECRET), `tg:${telegramId}`));
}

Deno.serve(async (req) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };

  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const { initData } = await req.json();
    const tgUser = await verifyInitData(String(initData ?? ""));

    if (!tgUser) {
      return new Response(JSON.stringify({ error: "invalid initData" }), {
        status: 401,
        headers: { ...cors, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const email = `tg${tgUser.id}@telegram.user`;
    const password = await passwordFor(tgUser.id);

    // Создаём аккаунт, если его ещё нет, иначе обновляем пароль под текущий секрет
    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        telegram_id: tgUser.id,
        first_name: tgUser.first_name ?? "",
      },
    });

    if (createError) {
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      const existing = list?.users.find((u) => u.email === email);
      if (!existing) throw createError;
      await admin.auth.admin.updateUserById(existing.id, { password });
    } else if (!created?.user) {
      throw new Error("user not created");
    }

    return new Response(JSON.stringify({ email, password }), {
      headers: { ...cors, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: String(error) }), {
      status: 500,
      headers: { ...cors, "Content-Type": "application/json" },
    });
  }
});