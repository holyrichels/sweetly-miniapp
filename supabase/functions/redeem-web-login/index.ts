declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

// Вызывается из браузера: атомарно погашает одноразовый код и выдаёт вход.
// Деплоим с --no-verify-jwt: пользователь ещё не авторизован.
import { createClient } from "npm:@supabase/supabase-js@2";

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

  const body = await req.json().catch(() => null);
  const value =
    body && typeof body === "object" && "code" in body
      ? String(body.code).trim().toUpperCase()
      : "";

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  try {
    const forwardedIps = req.headers.get("x-forwarded-for")?.split(",");
    const clientIp =
      req.headers.get("cf-connecting-ip")?.trim() ||
      forwardedIps?.[forwardedIps.length - 1]?.trim() ||
      "unknown";
    const clientHash = await hashSecret(`web-login-rate:${clientIp}`);
    const { data: allowed, error: rateLimitError } = await admin.rpc(
      "record_web_login_code_attempt",
      { p_client_hash: clientHash },
    );

    if (rateLimitError) {
      console.error("Could not record web login code attempt:", rateLimitError);
      return json({ error: "internal error", stage: "rate_limit" }, 500);
    }
    if (!allowed) return json({ error: "too many attempts" }, 429);

    if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value)) {
      return json({ error: "invalid code" }, 400);
    }

    const codeHash = await hashSecret(`web-login-code:${value}`);
    const { data: userId, error: consumeError } = await admin.rpc(
      "consume_web_login_code",
      { p_code_hash: codeHash },
    );

    if (consumeError) {
      console.error("Could not consume web login code:", consumeError);
      return json({ error: "internal error", stage: "consume_code" }, 500);
    }
    if (typeof userId !== "string") return json({ error: "invalid or expired code" }, 400);

    const { data: userData, error: userError } =
      await admin.auth.admin.getUserById(userId);

    if (userError || !userData.user?.email) {
      console.error("Could not find email for web login code user:", userError);
      return json({ error: "account has no email" }, 400);
    }

    const { data: linkData, error: linkError } =
      await admin.auth.admin.generateLink({
        type: "magiclink",
        email: userData.user.email,
      });

    if (linkError || !linkData.properties?.hashed_token) {
      console.error("Could not generate magic link for web login code:", linkError);
      return json({ error: "could not create login link" }, 500);
    }

    return json({ token_hash: linkData.properties.hashed_token });
  } catch (error) {
    console.error("redeem-web-login failed:", error);
    return json({ error: "internal error" }, 500);
  }
});
