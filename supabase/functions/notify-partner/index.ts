// Два действия:
//  action "link"   — привязывает Telegram (из initData Mini App) к аккаунту приложения
//  kind "miss" / "mood" — отправляет партнёру сообщение от бота
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

// Проверка initData Mini App (та же схема, что в telegram-auth)
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

async function sendToTelegram(chatId: number, text: string): Promise<boolean> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });

  const result = await response.json().catch(() => ({ ok: false }));
  return result.ok === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const token = req.headers.get("Authorization")?.replace("Bearer ", "");

    if (!token) return json({ error: "not authorized" }, 401);

    const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(token);

    if (userError || !userData.user) return json({ error: "not authorized" }, 401);

    const uid = userData.user.id;
    const body = await req.json().catch(() => ({}));

    // ----- создать код привязки для бота -----
    if (body.action === "create_link_code") {
      const code = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

      const { error } = await admin.from("telegram_link_codes").insert({
        code,
        user_id: uid,
        expires_at: expiresAt,
      });

      if (error) throw error;

      return json({ code });
    }

    // ----- проверить, привязан ли Telegram -----
    if (body.action === "link_status") {
      const { data } = await admin
        .from("telegram_links")
        .select("telegram_id")
        .eq("user_id", uid)
        .maybeSingle();

      return json({ linked: data !== null });
    }

    // ----- привязка Telegram к аккаунту -----
    if (body.action === "link") {
      const tg = await verifyInitData(String(body.initData ?? ""));

      if (!tg) return json({ error: "invalid initData" }, 401);

      const { error } = await admin.from("telegram_links").upsert(
        { telegram_id: tg.id, user_id: uid, updated_at: new Date().toISOString() },
        { onConflict: "telegram_id" },
      );

      if (error) throw error;

      return json({ linked: true });
    }

    // ----- уведомление партнёра -----
    const { data: member } = await admin
      .from("couple_members")
      .select("couple_id")
      .eq("user_id", uid)
      .maybeSingle();

    if (!member) return json({ sent: false, reason: "no couple" });

    const { data: members } = await admin
      .from("couple_members")
      .select("user_id")
      .eq("couple_id", member.couple_id);

    const partnerId = members?.find((item) => item.user_id !== uid)?.user_id;

    if (!partnerId) return json({ sent: false, reason: "no partner" });

    const { data: link } = await admin
      .from("telegram_links")
      .select("telegram_id")
      .eq("user_id", partnerId)
      .maybeSingle();

    if (!link) return json({ sent: false, reason: "partner not linked" });

    const { data: me } = await admin.from("profiles").select("name").eq("id", uid).maybeSingle();

    const name = me?.name || "Партнёр";

    let text: string;

    if (body.kind === "miss") {
      text = `💕 ${name} скучает по тебе`;
    } else if (body.kind === "mood") {
      // Принимаем только короткий эмодзи, чтобы в сообщение нельзя было подставить произвольный текст
      const mood = String(body.mood ?? "");
      if (mood.length === 0 || mood.length > 8) return json({ error: "bad mood" }, 400);
      text = `${name} сейчас в настроении ${mood}`;
    } else {
      return json({ error: "unknown kind" }, 400);
    }

    const sent = await sendToTelegram(link.telegram_id, text);

    return json({ sent });
  } catch (error) {
    return json({ error: String(error) }, 500);
  }
});