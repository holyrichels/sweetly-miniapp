// Ежедневная проверка: в день месячной годовщины присылаем сообщение обоим партнёрам.
// Вызывает планировщик (cron), доступ по секретному заголовку x-cron-secret.
import { createClient } from "npm:@supabase/supabase-js@2";

const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CRON_SECRET = Deno.env.get("CRON_SECRET")!;

function monthWord(count: number) {
  const last = count % 10;
  const lastTwo = count % 100;

  if (last === 1 && lastTwo !== 11) return "месяц";
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return "месяца";

  return "месяцев";
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
  if (req.headers.get("x-cron-secret") !== CRON_SECRET) {
    return new Response("forbidden", { status: 403 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const today = new Date();

  const { data: couples } = await admin.from("couples").select("id, relationship_date");

  let sent = 0;

  for (const couple of couples ?? []) {
    if (!couple.relationship_date) continue;

    const start = new Date(`${couple.relationship_date}T00:00:00`);

    // Годовщина — тот же день месяца, и отношения уже начались
    if (start > today || start.getDate() !== today.getDate()) continue;

    const months =
      (today.getFullYear() - start.getFullYear()) * 12 + (today.getMonth() - start.getMonth());

    if (months < 1) continue;

    const { data: members } = await admin
      .from("couple_members")
      .select("user_id")
      .eq("couple_id", couple.id);

    for (const member of members ?? []) {
      const { data: prefs } = await admin
        .from("profiles")
        .select("notify_dates")
        .eq("id", member.user_id)
        .maybeSingle();

      if (prefs?.notify_dates === false) continue;

      const { data: link } = await admin
        .from("telegram_links")
        .select("telegram_id")
        .eq("user_id", member.user_id)
        .maybeSingle();

      if (!link) continue;

      const ok = await sendToTelegram(
        link.telegram_id,
        `💞 Сегодня ${months} ${monthWord(months)} вместе. Поздравьте друг друга!`,
      );

      if (ok) sent += 1;
    }
  }

  return new Response(JSON.stringify({ sent }), {
    headers: { "Content-Type": "application/json" },
  });
});
