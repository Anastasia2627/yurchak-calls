(() => {
  'use strict';

  const cfg = window.YURCHAK_CONFIG || {};
  let authMode = 'login';

  function buildAuth() {
    const panel = document.querySelector('.auth-panel');
    if (!panel || !window.supabase || !cfg.supabaseUrl || !cfg.supabasePublishableKey) return;

    panel.innerHTML = `
      <div class="auth-brand">
        <div class="brand-mark large">Y</div>
        <div><b>Юрчак</b><span>База дзвінків</span></div>
      </div>
      <div class="auth-switch">
        <button type="button" class="auth-tab active" data-auth-mode="login">Вхід</button>
        <button type="button" class="auth-tab" data-auth-mode="signup">Реєстрація</button>
      </div>
      <form id="simpleAuthForm" class="simple-auth-form" novalidate>
        <label>Email<input name="email" type="text" inputmode="email" autocomplete="email" placeholder="name@company.com"></label>
        <label>Пароль<input name="password" type="password" autocomplete="current-password" placeholder="••••••••"></label>
        <div id="authInlineError" class="auth-inline-error" hidden></div>
        <button id="simpleAuthSubmit" class="btn primary full" type="submit" disabled>Увійти</button>
      </form>`;

    const authClient = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const form = document.getElementById('simpleAuthForm');
    const submit = document.getElementById('simpleAuthSubmit');
    const errorBox = document.getElementById('authInlineError');
    const email = form.elements.email;
    const password = form.elements.password;

    const updateState = () => {
      submit.disabled = !String(email.value).trim() || !String(password.value);
      submit.textContent = authMode === 'login' ? 'Увійти' : 'Створити акаунт';
      password.autocomplete = authMode === 'login' ? 'current-password' : 'new-password';
      errorBox.hidden = true;
      errorBox.textContent = '';
    };

    panel.querySelectorAll('[data-auth-mode]').forEach(button => {
      button.addEventListener('click', () => {
        authMode = button.dataset.authMode;
        panel.querySelectorAll('[data-auth-mode]').forEach(x => x.classList.toggle('active', x === button));
        updateState();
      });
    });
    email.addEventListener('input', updateState);
    password.addEventListener('input', updateState);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      errorBox.hidden = true;
      const credentials = { email: String(email.value).trim(), password: String(password.value) };
      let result;

      if (authMode === 'login') {
        result = await authClient.auth.signInWithPassword(credentials);
      } else {
        result = await authClient.auth.signUp(credentials);
        if (!result.error && !result.data?.session) result = await authClient.auth.signInWithPassword(credentials);
      }

      if (result.error) {
        const msg = String(result.error.message || 'Помилка входу');
        errorBox.textContent = /invalid login/i.test(msg) ? 'Невірний email або пароль.' : /password/i.test(msg) && /6/i.test(msg) ? 'Пароль має бути від 6 символів.' : /already registered/i.test(msg) ? 'Цей email уже зареєстрований.' : 'Не вдалося виконати дію.';
        errorBox.hidden = false;
        updateState();
        errorBox.hidden = false;
        return;
      }

      location.reload();
    });

    updateState();
  }

  function trimRenderedCopy() {
    const heroTitle = document.querySelector('#overviewView .hero h1');
    if (heroTitle && heroTitle.textContent.trim() !== 'Огляд') heroTitle.textContent = 'Огляд';
    document.querySelectorAll('#overviewView .hero p,#callsView .page-head p,#tasksView .page-head p,.field-hint,.privacy-box,.auth-hint').forEach(el => el.remove());
  }

  function loadQa() {
    if (document.querySelector('script[data-call-qa]')) return;
    const s = document.createElement('script');
    s.src = 'qa-ui.js?v=3';
    s.dataset.callQa = '1';
    document.body.appendChild(s);
  }

  buildAuth();
  trimRenderedCopy();
  loadQa();
  const observer = new MutationObserver(trimRenderedCopy);
  observer.observe(document.body, { childList: true, subtree: true });
})();
