(() => {
  'use strict';

  const cfg = window.YURCHAK_CONFIG || {};
  let activeCallId = sessionStorage.getItem('yurchak-active-call-id') || '';
  let sb = null;

  function client() {
    if (!sb && window.supabase && cfg.supabaseUrl && cfg.supabasePublishableKey) {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    }
    return sb;
  }

  document.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    const source = e.target.closest('[data-source]');
    const id = open?.dataset?.open || source?.dataset?.source;
    if (id) {
      activeCallId = id;
      sessionStorage.setItem('yurchak-active-call-id', id);
    }
  }, true);

  function inject() {
    const callView = document.getElementById('callView');
    if (!callView || callView.hidden || !callView.querySelector('.report-header')) return;
    if (callView.querySelector('.call-ai-panel')) return;
    if (!activeCallId) return;

    const panel = document.createElement('section');
    panel.className = 'call-ai-panel';
    panel.innerHTML = `
      <div class="call-ai-head"><h2>Запитати AI</h2></div>
      <form class="call-ai-form">
        <input class="call-ai-input" type="text" maxlength="1200" placeholder="Наприклад: випиши всі правки, які треба внести на сайт" autocomplete="off">
        <button class="btn primary call-ai-send" type="submit">Запитати</button>
      </form>
      <div class="call-ai-thread" hidden></div>`;

    const anchor = callView.querySelector('.main-conclusion') || callView.querySelector('.meeting-outline');
    if (anchor?.parentNode) anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    else callView.appendChild(panel);

    panel.querySelector('.call-ai-form').addEventListener('submit', e => ask(e, panel));
  }

  async function ask(e, panel) {
    e.preventDefault();
    const input = panel.querySelector('.call-ai-input');
    const button = panel.querySelector('.call-ai-send');
    const thread = panel.querySelector('.call-ai-thread');
    const question = String(input.value || '').trim();
    if (!question || !activeCallId) return;

    thread.hidden = false;
    thread.insertAdjacentHTML('beforeend', `<div class="call-ai-question">${esc(question)}</div>`);
    const answerEl = document.createElement('div');
    answerEl.className = 'call-ai-answer loading';
    answerEl.textContent = '...';
    thread.appendChild(answerEl);
    input.value = '';
    button.disabled = true;

    try {
      const api = client();
      const { data: { session } } = await api.auth.getSession();
      if (!session) throw new Error('Сесія завершилась.');
      const r = await fetch(`${cfg.supabaseUrl}/functions/v1/call-qa-v1`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: cfg.supabasePublishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ callId: activeCallId, question })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || 'AI не зміг відповісти.');
      answerEl.classList.remove('loading');
      answerEl.textContent = data.answer;
    } catch (err) {
      answerEl.classList.remove('loading');
      answerEl.classList.add('error');
      answerEl.textContent = err?.message || 'Не вдалося отримати відповідь.';
    } finally {
      button.disabled = false;
      input.focus();
    }
  }

  function esc(v='') {
    return String(v).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  }

  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  inject();
})();
