import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: true, autoRefreshToken: true },
});

// Вход через Telegram: отправляем initData на сервер, сервер проверяет подпись,
// затем клиент входит в Supabase уже обычным способом. Пароль не вводится.
export async function signInWithTelegram(): Promise<void> {
  const tg = (window as any).Telegram?.WebApp;
  const initData: string | undefined = tg?.initData;

  if (!initData) {
    throw new Error("Откройте приложение из Telegram");
  }

  tg.ready();
  tg.expand();

  const response = await fetch(`${supabaseUrl}/functions/v1/telegram-auth`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: supabaseAnonKey,
    },
    body: JSON.stringify({ initData }),
  });

  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error ?? "Ошибка входа");
  }

  if (!result.linked || typeof result.token_hash !== "string") {
    throw new Error("Сначала привяжите Telegram к аккаунту Sweetly");
  }

  const { error } = await supabase.auth.verifyOtp({
    token_hash: result.token_hash,
    type: "magiclink",
  });

  if (error) throw error;
}