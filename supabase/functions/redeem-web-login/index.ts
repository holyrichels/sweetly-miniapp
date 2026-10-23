declare const Deno: {
  env: { get(name: string): string | undefined };
  serve(handler: (req: Request) => Response | Promise<Response>): void;
};

// Вызывается из браузера: проверяет одноразовый код и отдаёт токен входа.
// Деплоим с --no-verify-jwt: вход ещё не выполнен.
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method" }, 405);

  const body = await req.json().catch(() => ({}));

  const value = String(body.code ?? "").trim().toUpperCase();

  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(value)) return json({ error: "bad code" }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: row } = await admin
    .from("web_login_codes")
    .select("code, user_id, expires_at, used")
    .eq("code", value)
    .maybeSingle();

  if (!row || row.used || new Date(row.expires_at) < new Date()) {
    return json({ error: "invalid" }, 400);
  }

  // Код одноразовый: помечаем сразу, до выдачи токена
  await admin.from("web_login_codes").update({ used: true }).eq("code", value);

  const { data: userData } = await admin.auth.admin.getUserById(row.user_id);

  const email = userData?.user?.email;

  if (!email) return json({ error: "no email" }, 400);

  const { data: linkData, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });

  if (error || !linkData?.properties?.hashed_token) return json({ error: "link failed" }, 500);

  return json({ token_hash: linkData.properties.hashed_token });
});