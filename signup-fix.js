(() => {
  const btn = document.getElementById('signUpButton');
  const form = document.getElementById('authForm');
  const errorBox = document.getElementById('authError');
  const cfg = window.YURCHAK_CONFIG || {};
  if (!btn || !form || !window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) return;

  const client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });

  const show = (msg) => {
    errorBox.textContent = msg || '';
    errorBox.hidden = !msg;
  };

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    show('');
    if (!form.reportValidity()) return;

    const fd = new FormData(form);
    const email = String(fd.get('email') || '').trim().toLowerCase();
    const password = String(fd.get('password') || '');
    btn.disabled = true;
    btn.textContent = 'Создаём аккаунт…';

    try {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error && !/already registered|user already exists/i.test(error.message || '')) throw error;

      if (data?.session) {
        location.reload();
        return;
      }

      const { error: signInError } = await client.auth.signInWithPassword({ email, password });
      if (signInError) throw signInError;
      location.reload();
    } catch (err) {
      const msg = String(err?.message || err || 'Ошибка регистрации');
      if (/invalid login credentials/i.test(msg)) show('Аккаунт уже существует. Проверь пароль и нажми «Войти».');
      else show(msg);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Первый вход? Создать аккаунт';
    }
  }, true);
})();
