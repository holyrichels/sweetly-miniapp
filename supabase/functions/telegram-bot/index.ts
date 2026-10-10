// Webhook бота: отвечает на /start, чтобы бот мог писать пользователю.
// Telegram вызывает эту функцию сам, поэтому деплоим с --no-verify-jwt.
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

async function sendMessage(chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");

  const update = await req.json().catch(() => null);
  const message = update?.message;

  if (message?.text?.startsWith("/start")) {
    await sendMessage(
      message.chat.id,
      "Привет! Я Sweetly ❤️\n\nТеперь я буду присылать тебе сообщение, когда партнёр скучает или меняет настроение. Открой приложение кнопкой «Открыть» внизу, чтобы я тебя узнал.",
    );
  }

  return new Response("ok");
});