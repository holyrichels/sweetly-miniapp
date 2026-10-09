import { signInWithTelegram, supabase } from "./auth";

const app = document.getElementById("app")!;

async function start() {
  try {
    await signInWithTelegram();

    const { data } = await supabase.auth.getUser();
    const name = data.user?.user_metadata?.first_name ?? "";

    // Здесь будет основной интерфейс (главная, комната, настроение, чат, профиль).
    // Пока показываем только факт успешного входа.
    app.innerHTML = `<p class="status">Вы вошли${name ? `, ${name}` : ""} ✅</p>`;
  } catch (error) {
    app.innerHTML = `<p class="status">Не удалось войти: ${(error as Error).message}</p>`;
  }
}

start();