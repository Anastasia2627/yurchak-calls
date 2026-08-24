(() => {
  'use strict';

  const cfg = window.YURCHAK_CONFIG || {};
  let activeCallId = sessionStorage.getItem('yurchak-active-call-id') || '';
  let sb = null;

  const style = document.createElement('style');
  style.textContent = '.call-ai-panel{margin:24px 0;background:#fff;border:1px solid #d9e6fb;border-radius:22px;padding:24px}.call-ai-head{margin-bottom:14px}.call-ai-head h2{margin:0;font-size:20px}.call-ai-form{display:grid;grid-template-columns:1fr auto;gap:10px}.call-ai-input{border:1px solid #cfe0fb;border-radius:13px;padding:13px 15px;background:#f9fbff;color:#10213d;outline:none;font:inherit}.call-ai-input:focus{border-color:#2268f2}.call-ai-thread{display:grid;gap:14px;margin-top:16px}.call-ai-turn{display:grid;gap:10px}.call-ai-question{justify-self:end;max-width:78%;background:#2268f2;color:#fff;border-radius:14px;padding:10px 13px;font-size:13px;line-height:1.5}.call-ai-answer{max-width:92%;background:#f3f7fe;border-radius:14px;padding:13px 15px;color:#1d3455;font-size:13px;line-height:1.65;white-space:pre-wrap}.call-ai-answer.error{background:#fff1f1;color:#c84646}.call-ai-answer.loading{min-width:54px}@media(max-width:700px){.call-ai-form{grid-template-columns:1fr}.call-ai-send{width:100%}.call-ai-question,.call-ai-answer{max-width:100%}}';
  document.head.appendChild(style);

  function client() {
    if (!sb && window.supabase && cfg.supabaseUrl && cfg.supabasePublishableKey) {
      sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
      });
    }
    return sb;
  }

  function rememberCall(id) {
    activeCallId = id || '';
    if (activeCallId) sessionStorage.setItem('yurchak-active-call-id', activeCallId);
  }

  document.addEventListener('click', e => {
    const open = e.target.closest('[data-open]');
    const source = e.target.closest('[data-source]');
    const id = open?.dataset?.open || source?.dataset?.source;
    if (id) rememberCall(id);
  }, true);

  async function resolveCurrentCallId() {
    const api = client();
    if (!api) return '';

    if (activeCallId) {
      const { data } = await api.from('calls_v2').select('id').eq('id', activeCallId).maybeSingle();
      if (data?.id) return data.id;
    }

    const title = document.querySelector('#callView .report-header h1')?.textContent?.trim() || '';
    if (!title) return '';

    const { data, error } = await api
      .from('calls_v2')
      .select('id,title,duration_seconds,status,updated_at')
      .eq('title', title)
      .eq('status', 'ready')
      .order('updated_at', { ascending: false })
      .limit(20);
    if (error || !data?.length) return '';

    let chosen = data[0];
    const metaText = [...document.querySelectorAll('#callView .report-meta span')]
      .map(x => x.textContent || '')
      .find(x => /хв/.test(x));
    const minutes = Number((metaText || '').match(/(\d+)/)?.[1] || 0);

    if (minutes && data.length > 1) {
      chosen = [...data].sort((a, b) => {
        const da = Math.abs(Number(a.duration_seconds || 0) - minutes * 60);
        const db = Math.abs(Number(b.duration_seconds || 0) - minutes * 60);
        return da - db;
      })[0];
    }

    rememberCall(chosen.id);
    return chosen.id;
  }

  function inject() {
    const callView = document.getElementById('callView');
    if (!callView || callView.hidden || !callView.querySelector('.report-header')) return;
    if (callView.querySelector('.call-ai-panel')) return;

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
    if (!question) return;

    thread.querySelectorAll('.call-ai-turn.failed').forEach(el => el.remove());
    thread.hidden = false;

    const turn = document.createElement('div');
    turn.className = 'call-ai-turn';
    turn.innerHTML = `<div class="call-ai-question">${esc(question)}</div>`;
    const answerEl = document.createElement('div');
    answerEl.className = 'call-ai-answer loading';
    answerEl.textContent = '...';
    turn.appendChild(answerEl);
    thread.appendChild(turn);

    while (thread.querySelectorAll('.call-ai-turn').length > 6) {
      thread.querySelector('.call-ai-turn')?.remove();
    }

    input.value = '';
    button.disabled = true;

    try {
      const api = client();
      const callId = await resolveCurrentCallId();
      if (!callId) throw new Error('Не вдалося визначити дзвінок.');
      const { data: { session } } = await api.auth.getSession();
      if (!session) throw new Error('Сесія завершилась.');
      const r = await fetch(`${cfg.supabaseUrl}/functions/v1/call-qa-v1`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          apikey: cfg.supabasePublishableKey,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ callId, question })
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data?.ok) throw new Error(data?.error || 'AI не зміг відповісти.');
      answerEl.classList.remove('loading');
      answerEl.textContent = data.answer;
    } catch (err) {
      turn.classList.add('failed');
      answerEl.classList.remove('loading');
      answerEl.classList.add('error');
      answerEl.textContent = err?.message || 'Не вдалося отримати відповідь.';
    } finally {
      button.disabled = false;
      input.focus();
    }
  }

  function esc(v='') {
    return String(v).replace(/[&<>'\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));
  }

  const observer = new MutationObserver(inject);
  observer.observe(document.body, { childList: true, subtree: true });
  inject();
})();
