(() => {
  'use strict';

  const cfg = window.YURCHAK_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const BUCKET = 'call-media-v2';
  const CALLS = 'calls_v2';
  const TASKS = 'call_tasks_v2';
  const PIPELINE = 'call-pipeline-v2';
  const MAX_FILE = 500 * 1024 * 1024;
  const RAW_PART_SIZE = 44 * 1024 * 1024;
  const LIST_FIELDS = 'id,title,call_date,status,stage,progress,original_filename,mime_type,file_size_bytes,storage_path,storage_parts,duration_seconds,summary,topics,main_conclusion,participants,analysis_context,error_message,created_by,created_at,updated_at,completed_at';
  const TASK_FIELDS = 'id,call_id,assignee,text,deadline,status,source_timestamp,source_excerpt,assignee_confidence,assignment_basis,created_at,updated_at';

  let sb = null;
  let user = null;
  let calls = [];
  let tasks = [];
  let view = 'overview';
  let currentCallId = null;
  let callFilter = 'all';
  let taskFilter = 'open';
  const running = new Set();
  const detailCache = new Map();
  let toastTimer = null;

  const el = {
    boot: $('#bootScreen'), auth: $('#authScreen'), app: $('#app'),
    overview: $('#overviewView'), calls: $('#callsView'), call: $('#callView'), tasks: $('#tasksView'),
    modal: $('#uploadModal'), form: $('#uploadForm'), file: $('#mediaInput'), toast: $('#toast')
  };

  init();

  async function init() {
    bindStatic();
    if (!cfg.supabaseUrl || !cfg.supabasePublishableKey || !window.supabase) return fatal('Не вдалося підключити Supabase.');
    if (!window.tus) return fatal('Не завантажився модуль надійного завантаження файлів. Онови сторінку.');
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    const { data } = await sb.auth.getSession();
    el.boot.hidden = true;
    if (data.session?.user) await enter(data.session.user); else el.auth.hidden = false;
    sb.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user && session.user.id !== user?.id) await enter(session.user);
      if (!session && user) leave();
    });
    addEventListener('online', resumePending);
  }

  function bindStatic() {
    $('#authForm').addEventListener('submit', login);
    $('#signupButton').addEventListener('click', signup);
    $('#logoutButton').addEventListener('click', () => sb?.auth.signOut());
    $('#menuButton').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
    $$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
    $$('[data-close-modal]').forEach(b => b.addEventListener('click', closeModal));
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeModal(); });
    el.file.addEventListener('change', () => showFile(el.file.files?.[0]));
    el.form.addEventListener('submit', submitUpload);
    const drop = $('#fileDrop');
    ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('dragging'); }));
    ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.remove('dragging'); }));
    drop.addEventListener('drop', e => {
      const f = e.dataTransfer.files?.[0]; if (!f) return;
      const dt = new DataTransfer(); dt.items.add(f); el.file.files = dt.files; showFile(f);
    });
  }

  async function login(e) {
    e.preventDefault(); authError(''); const fd = new FormData(e.currentTarget);
    const { error } = await sb.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: String(fd.get('password')) });
    if (error) authError(authMessage(error.message));
  }

  async function signup() {
    const form = $('#authForm'); if (!form.reportValidity()) return; authError('');
    const fd = new FormData(form), email = String(fd.get('email')).trim(), password = String(fd.get('password'));
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) return authError(authMessage(error.message));
    if (!data.session) { const r = await sb.auth.signInWithPassword({ email, password }); if (r.error) authError('Акаунт створено. Натисни «Увійти».'); }
  }

  async function enter(u) {
    user = u; el.auth.hidden = true; el.app.hidden = false; $('#userEmail').textContent = u.email || '';
    await loadData(); navigate(view); await recoverUploadedFiles(); resumePending();
  }
  function leave() { user = null; calls = []; tasks = []; detailCache.clear(); running.clear(); el.app.hidden = true; el.auth.hidden = false; }

  async function loadData() {
    const [cr, tr] = await Promise.all([
      sb.from(CALLS).select(LIST_FIELDS).order('call_date', { ascending: false }).order('created_at', { ascending: false }).limit(300),
      sb.from(TASKS).select(TASK_FIELDS).order('created_at', { ascending: false }).limit(3000)
    ]);
    if (cr.error || tr.error) return toast('Не вдалося завантажити дані.');
    calls = cr.data || []; tasks = tr.data || []; updateBadge();
  }

  function navigate(to, id = null) {
    view = to; if (id) currentCallId = id;
    el.overview.hidden = to !== 'overview'; el.calls.hidden = to !== 'calls'; el.call.hidden = to !== 'call'; el.tasks.hidden = to !== 'tasks';
    $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === (to === 'call' ? 'calls' : to)));
    $('#sidebar').classList.remove('open');
    if (to === 'overview') renderOverview();
    if (to === 'calls') renderCalls();
    if (to === 'tasks') renderTasks();
    if (to === 'call') renderCall(id);
    scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderOverview() {
    const ready = calls.filter(c => c.status === 'ready'), processing = calls.filter(c => ['uploading', 'transcribing', 'analyzing'].includes(c.status));
    const open = tasks.filter(t => t.status !== 'done'), done = tasks.filter(t => t.status === 'done');
    el.overview.innerHTML = `<section class="hero"><div><span class="eyebrow">РОБОЧИЙ ПРОСТІР ЮРЧАК</span><h1>Після дзвінка команда одразу знає, що вирішили й що робити далі</h1><p>Завантаж запис Zoom. Сервіс збере транскрипцію, висновки, теми, рішення та конкретні завдання.</p></div><div class="hero-actions"><button class="btn primary" data-upload>＋ Додати запис</button><button class="btn secondary" data-go="calls">Усі дзвінки</button></div></section>
    <div class="stats-grid">${stat('Дзвінків', calls.length, `${ready.length} готово`)}${stat('В обробці', processing.length, processing.length ? 'аналіз триває' : 'черги немає')}${stat('Відкритих задач', open.length, `${done.length} виконано`)}${stat('Останній дзвінок', calls[0] ? shortDate(calls[0].call_date) : '—', calls[0]?.title || 'ще немає')}</div>
    <div class="overview-grid"><section class="panel"><div class="panel-head"><h2>Останні дзвінки</h2><button data-go="calls">Дивитися всі →</button></div><div class="call-list">${calls.slice(0, 5).length ? calls.slice(0, 5).map(callRow).join('') : empty('Поки порожньо', 'Завантаж перший запис дзвінка.')}</div></section><section class="panel"><div class="panel-head"><h2>Актуальні завдання</h2><button data-go="tasks">Усі завдання →</button></div><div class="task-list">${open.slice(0, 6).length ? open.slice(0, 6).map(taskMini).join('') : empty('Немає відкритих задач', '')}</div></section></div>`;
    $$('[data-upload]', el.overview).forEach(b => b.onclick = openModal); $$('[data-go]', el.overview).forEach(b => b.onclick = () => navigate(b.dataset.go)); bindCallOpen(el.overview); bindTaskControls(el.overview);
  }
  function stat(label, value, small) { return `<article class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(small)}</small></article>`; }

  function renderCalls(query = '') {
    const q = query.trim().toLowerCase();
    const filtered = calls.filter(c => (callFilter === 'all' || (callFilter === 'processing' ? ['uploading', 'transcribing', 'analyzing'].includes(c.status) : c.status === callFilter)) && (!q || callText(c).includes(q)));
    el.calls.innerHTML = `<div class="page-head"><div><span class="eyebrow">АРХІВ</span><h1>Дзвінки</h1><p>Готові звіти та записи, які ще обробляються.</p></div><button class="btn primary" data-upload>＋ Завантажити запис</button></div>
    <div class="toolbar"><div class="filters"><button class="filter ${callFilter === 'all' ? 'active' : ''}" data-cf="all">Усі</button><button class="filter ${callFilter === 'ready' ? 'active' : ''}" data-cf="ready">Готові</button><button class="filter ${callFilter === 'processing' ? 'active' : ''}" data-cf="processing">В обробці</button><button class="filter ${callFilter === 'error' ? 'active' : ''}" data-cf="error">Помилки</button></div><input id="callSearch" class="search" placeholder="Пошук за темами та рішеннями" value="${esc(query)}"></div>
    <div class="call-list">${filtered.length ? filtered.map(callRow).join('') : empty('Нічого не знайдено', 'Зміни фільтр або пошук.')}</div>`;
    $('[data-upload]', el.calls).onclick = openModal; $$('[data-cf]', el.calls).forEach(b => b.onclick = () => { callFilter = b.dataset.cf; renderCalls($('#callSearch')?.value || ''); }); $('#callSearch').oninput = e => renderCalls(e.target.value); bindCallOpen(el.calls);
  }

  function callRow(c) {
    const d = dateParts(c.call_date), ready = c.status === 'ready', open = tasks.filter(t => t.call_id === c.id && t.status !== 'done').length;
    return `<article class="call-row"><div class="date-box"><strong>${d.day}</strong><small>${d.month}</small></div><div><h3>${esc(c.title)}</h3><div class="meta"><span>${formatDate(c.call_date)}</span>${c.duration_seconds ? `<span>${duration(c.duration_seconds)}</span>` : ''}${ready ? `<span>${(c.topics || []).length} тем</span><span>${open} задач</span>` : statusPill(c)}</div></div>${ready || c.status === 'error' ? `<button class="btn secondary" data-open="${c.id}">${ready ? 'Відкрити' : 'Деталі'}</button>` : progressBox(c)}</article>`;
  }
  function bindCallOpen(root) { $$('[data-open]', root).forEach(b => b.onclick = () => navigate('call', b.dataset.open)); }
  function statusPill(c) { const s = statusInfo(c); return `<span class="pill ${s.cls}"><span class="dot"></span>${esc(s.text)}</span>`; }
  function statusInfo(c) { if (c.status === 'ready') return { cls: 'ready', text: 'Готово' }; if (c.status === 'error') return { cls: 'error', text: 'Помилка' }; if (c.stage === 'rate_limited') return { cls: 'wait', text: 'Чекаємо ліміт' }; return { cls: 'processing', text: stageText(c) }; }
  function stageText(c) { return ({ uploading: 'Завантажуємо запис частинами', transcribing: 'Робимо транскрипцію', analyzing: 'Аналізуємо контекст і рішення', rate_limited: 'Чекаємо ліміт AI', done: 'Готово', error: 'Помилка' })[c.stage || c.status] || 'Обробляємо'; }
  function progressBox(c) { const p = Math.max(2, Math.min(99, Number(c.progress || 2))); return `<div class="progress-box"><div class="progress-head"><span>${esc(stageText(c))}</span><b>${p}%</b></div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div></div>`; }

  async function renderCall(id) {
    el.call.innerHTML = `<div class="report-loading"><span class="spinner"></span>Оновлюємо звіт…</div>`;
    const [cr, tr] = await Promise.all([
      sb.from(CALLS).select(LIST_FIELDS + ',transcript').eq('id', id).single(),
      sb.from(TASKS).select(TASK_FIELDS).eq('call_id', id).order('created_at', { ascending: true })
    ]);
    if (cr.error || !cr.data) return navigate('calls');
    const c = cr.data, ci = calls.findIndex(x => x.id === id); if (ci >= 0) calls[ci] = c; else calls.unshift(c);
    tasks = tasks.filter(t => t.call_id !== id).concat(tr.data || []); updateBadge(); currentCallId = id;
    if (c.status !== 'ready') return renderCallState(c);
    detailCache.set(id, c);
    const ctasks = tr.data || [], participants = normalizeParticipants(c.participants), groups = taskGroups(ctasks, participants);
    const mainConclusion = cleanDisplay(c.main_conclusion) || cleanDisplay((c.summary || [])[0]) || 'Головний висновок ще не сформовано.';
    el.call.innerHTML = `<button class="back" data-back>← До дзвінків</button>
      <header class="report-header"><div><span class="eyebrow">${formatDate(c.call_date)}</span><h1>${esc(c.title)}</h1><div class="report-meta"><span>${duration(c.duration_seconds)}</span><span>${(c.topics || []).length} тем</span><span>${ctasks.length} задач</span>${statusPill(c)}</div>${participants.length ? `<div class="participant-chips">${participants.map(p => `<span>${esc(p.name)}${p.role ? `<small>${esc(p.role)}</small>` : ''}</span>`).join('')}</div>` : ''}</div><div class="report-actions"><button class="btn secondary" data-reanalyze>Оновити аналіз</button><button class="btn danger" data-delete>Видалити</button></div></header>
      <section class="report-top-grid"><article class="report-card summary-card"><span class="eyebrow">ЗА 30 СЕКУНД</span><h2>Коротко</h2><ul class="summary-list">${(c.summary || []).filter(validDisplay).map(x => `<li>${esc(x)}</li>`).join('') || '<li>Підсумок відсутній.</li>'}</ul></article><article class="report-card report-numbers"><div><span>Теми</span><strong>${(c.topics || []).length}</strong></div><div><span>Завдання</span><strong>${ctasks.length}</strong></div><div><span>Виконавці</span><strong>${groups.filter(g => g.name !== 'Без виконавця').length}</strong></div><div><span>Тривалість</span><strong>${durationCompact(c.duration_seconds)}</strong></div></article></section>
      <section class="main-conclusion"><span>ГОЛОВНИЙ ВИСНОВОК</span><p>${esc(mainConclusion)}</p></section>
      <section class="report-section"><div class="section-head"><div><span class="eyebrow">СТРУКТУРА РОЗМОВИ</span><h2>Теми, висновки та рішення</h2></div><span>${(c.topics || []).length} блоків</span></div><div class="topic-accordions">${(c.topics || []).filter(t => validDisplay(t?.title)).map((t, i) => topicAccordion(t, i)).join('') || empty('Теми не визначені', '')}</div></section>
      <section class="report-section"><div class="section-head"><div><span class="eyebrow">ACTION ITEMS</span><h2>Завдання за відповідальними</h2></div><span>${ctasks.filter(t => t.status !== 'done').length} відкритих</span></div><div class="assignee-grid">${groups.length ? groups.map(g => assigneeCard(g, participants)).join('') : empty('Завдань немає', '')}</div></section>
      <section class="report-section transcript-section"><button id="transcriptToggle" class="transcript-toggle">Показати повну транскрипцію <span>↓</span></button><div id="transcriptBox" class="transcript" hidden></div></section>`;
    $('[data-back]', el.call).onclick = () => navigate('calls'); $('[data-delete]', el.call).onclick = () => deleteCall(id); $('[data-reanalyze]', el.call).onclick = () => reanalyzeCall(id);
    bindTaskControls(el.call, participants);
    $('#transcriptToggle').onclick = () => toggleTranscript(c.transcript || []);
  }

  function renderCallState(c) {
    el.call.innerHTML = `<button class="back" data-back>← До дзвінків</button><div class="detail-head"><div><span class="eyebrow">${formatDate(c.call_date)}</span><h1>${esc(c.title)}</h1>${statusPill(c)}</div></div><section class="card state-card"><h2>${c.status === 'error' ? 'Не вдалося обробити запис' : 'Запис обробляється'}</h2><p>${c.status === 'error' ? esc(c.error_message || 'Невідома помилка.') : 'Транскрипція та контекстний аналіз можуть зайняти кілька хвилин. Вкладку можна залишити відкритою або повернутися пізніше.'}</p>${c.status !== 'error' ? progressBox(c) : ''}<div class="state-actions"><button class="btn danger" data-delete>Видалити</button>${c.status === 'error' ? '<button class="btn primary" data-retry>Повторити обробку</button><button class="btn secondary" data-replace>Завантажити запис заново</button>' : ''}</div></section>`;
    $('[data-back]', el.call).onclick = () => navigate('calls'); $('[data-delete]', el.call).onclick = () => deleteCall(c.id); if ($('[data-retry]', el.call)) $('[data-retry]', el.call).onclick = () => retryCall(c.id); if ($('[data-replace]', el.call)) $('[data-replace]', el.call).onclick = () => replaceCall(c.id);
  }

  function topicAccordion(t, i) {
    const points = (t.points || []).filter(validDisplay), decisions = (t.decisions || []).filter(validDisplay);
    return `<details class="topic-accordion" ${i === 0 ? 'open' : ''}><summary><span class="topic-index">${String(i + 1).padStart(2, '0')}</span><div><strong>${esc(t.title)}</strong><small>${points[0] ? esc(points[0]) : decisions[0] ? esc(decisions[0]) : 'Деталі обговорення'}</small></div><time>${esc(t.start || '')}${t.end ? ` — ${esc(t.end)}` : ''}</time><i>＋</i></summary><div class="topic-content">${points.length ? `<div class="topic-points"><h4>Що обговорили</h4><ul>${points.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>` : ''}${decisions.length ? `<div class="topic-decisions"><h4>Рішення</h4>${decisions.map(x => `<p>${esc(x)}</p>`).join('')}</div>` : ''}</div></details>`;
  }

  function taskGroups(items, participants) {
    const map = new Map();
    for (const t of items) { const name = cleanDisplay(t.assignee) || 'Без виконавця'; if (!map.has(name)) map.set(name, []); map.get(name).push(t); }
    const order = [...map.entries()].sort((a, b) => (a[0] === 'Без виконавця') - (b[0] === 'Без виконавця') || a[0].localeCompare(b[0], 'uk'));
    return order.map(([name, list]) => ({ name, tasks: list, role: participants.find(p => p.name === name)?.role || '' }));
  }

  function assigneeCard(group, participants) {
    const initial = group.name === 'Без виконавця' ? '?' : group.name.trim().charAt(0).toUpperCase();
    return `<article class="assignee-card"><header><div class="assignee-avatar">${esc(initial)}</div><div><h3>${esc(group.name)}</h3>${group.role ? `<span>${esc(group.role)}</span>` : `<span>${group.tasks.length} ${pluralTasks(group.tasks.length)}</span>`}</div><b>${group.tasks.filter(t => t.status !== 'done').length}</b></header><div class="assignee-task-list">${group.tasks.map(t => taskReportItem(t, participants)).join('')}</div></article>`;
  }

  function taskReportItem(t, participants) {
    return `<div class="report-task ${t.status === 'done' ? 'done' : ''}"><div class="task-copy"><strong>${esc(t.text)}</strong><div class="task-evidence">${t.source_timestamp ? `<span>${esc(t.source_timestamp)}</span>` : ''}${t.deadline ? `<span>до ${formatDate(t.deadline)}</span>` : ''}${t.source_excerpt ? `<small>«${esc(t.source_excerpt)}»</small>` : ''}</div></div><div class="task-controls">${assigneeSelect(t, participants)}${statusSelect(t)}</div></div>`;
  }

  function assigneeSelect(t, participants) {
    const names = uniqueStrings([...(participants || []).map(p => p.name), ...tasks.map(x => x.assignee).filter(Boolean)]);
    return `<select class="assignee-select" data-assignee="${t.id}" title="Виконавець"><option value="" ${!t.assignee ? 'selected' : ''}>Без виконавця</option>${names.map(n => `<option value="${esc(n)}" ${t.assignee === n ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  }

  function renderTasks() {
    const shown = tasks.filter(t => taskFilter === 'all' || (taskFilter === 'open' ? t.status !== 'done' : t.status === 'done'));
    el.tasks.innerHTML = `<div class="page-head"><div><span class="eyebrow">ACTION ITEMS</span><h1>Завдання</h1><p>Усе, що команда має зробити після дзвінків.</p></div></div><div class="toolbar"><div class="filters"><button class="filter ${taskFilter === 'open' ? 'active' : ''}" data-tf="open">Відкриті</button><button class="filter ${taskFilter === 'done' ? 'active' : ''}" data-tf="done">Виконані</button><button class="filter ${taskFilter === 'all' ? 'active' : ''}" data-tf="all">Усі</button></div></div><div class="task-list">${shown.length ? shown.map(taskRow).join('') : empty('Завдань немає', '')}</div>`;
    $$('[data-tf]', el.tasks).forEach(b => b.onclick = () => { taskFilter = b.dataset.tf; renderTasks(); }); bindTaskControls(el.tasks); $$('[data-source]', el.tasks).forEach(b => b.onclick = () => navigate('call', b.dataset.source));
  }

  function taskMini(t) { const c = calls.find(x => x.id === t.call_id); return `<div class="task-card"><strong>${esc(t.text)}</strong><div class="meta"><span>${esc(t.assignee || 'Без виконавця')}</span>${t.deadline ? `<span>до ${formatDate(t.deadline)}</span>` : ''}${t.source_timestamp ? `<span>${esc(t.source_timestamp)}</span>` : ''}</div>${statusSelect(t)}${c ? `<button class="task-source" data-source="${c.id}">${esc(c.title)}</button>` : ''}</div>`; }
  function taskRow(t) { const c = calls.find(x => x.id === t.call_id); return `<article class="task-row"><div><strong>${esc(t.text)}</strong>${c ? `<button class="task-source" data-source="${c.id}">${esc(c.title)}${t.source_timestamp ? ` · ${esc(t.source_timestamp)}` : ''}</button>` : ''}${t.source_excerpt ? `<p class="source-excerpt">«${esc(t.source_excerpt)}»</p>` : ''}</div><div>${esc(t.assignee || 'Без виконавця')}${t.deadline ? `<div class="meta">до ${formatDate(t.deadline)}</div>` : ''}</div>${statusSelect(t)}</article>`; }
  function statusSelect(t) { return `<select class="status-select" data-status="${t.id}"><option value="todo" ${t.status === 'todo' ? 'selected' : ''}>Нове</option><option value="doing" ${t.status === 'doing' ? 'selected' : ''}>У роботі</option><option value="done" ${t.status === 'done' ? 'selected' : ''}>Готово</option></select>`; }

  function bindTaskControls(root, participants = []) {
    $$('[data-status]', root).forEach(s => s.onchange = async () => {
      const t = tasks.find(x => x.id === s.dataset.status), old = t?.status; const r = await sb.from(TASKS).update({ status: s.value }).eq('id', s.dataset.status); if (r.error) { s.value = old || 'todo'; return toast('Не вдалося змінити статус.'); } if (t) t.status = s.value; updateBadge(); if (view === 'tasks') renderTasks();
    });
    $$('[data-assignee]', root).forEach(s => s.onchange = async () => {
      const t = tasks.find(x => x.id === s.dataset.assignee), old = t?.assignee || ''; const value = s.value || null;
      const r = await sb.from(TASKS).update({ assignee: value, assignee_confidence: value ? 100 : 0, assignment_basis: value ? 'manual' : null }).eq('id', s.dataset.assignee);
      if (r.error) { s.value = old; return toast('Не вдалося змінити виконавця.'); }
      if (t) { t.assignee = value; t.assignee_confidence = value ? 100 : 0; t.assignment_basis = value ? 'manual' : null; }
      if (view === 'call') renderCall(currentCallId); else if (view === 'tasks') renderTasks();
    });
    $$('[data-source]', root).forEach(b => b.onclick = () => navigate('call', b.dataset.source));
  }
  function updateBadge() { const n = tasks.filter(t => t.status !== 'done').length; $('#taskBadge').textContent = n; $('#taskBadge').hidden = !n; }

  function toggleTranscript(lines) {
    const box = $('#transcriptBox'), button = $('#transcriptToggle'); box.hidden = !box.hidden; button.innerHTML = box.hidden ? 'Показати повну транскрипцію <span>↓</span>' : 'Сховати транскрипцію <span>↑</span>';
    if (!box.hidden && !box.dataset.ready) { box.innerHTML = lines.map(s => `<div class="transcript-row"><time>${esc(s.timestamp || '')}</time><p>${esc(s.text || '')}</p></div>`).join('') || '<div class="empty">Транскрипція порожня.</div>'; box.dataset.ready = '1'; }
  }

  function openModal() { el.form.reset(); const now = new Date(); el.form.elements.callDate.value = localDate(now); el.form.elements.title.value = `Дзвінок ${now.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' })}`; showFile(null); setUploadUi(false, 0, ''); el.modal.hidden = false; }
  function closeModal() { if ($('#uploadButton').disabled) return; el.modal.hidden = true; }
  function showFile(file) { $('#fileTitle').textContent = file ? file.name : 'Обрати відео або аудіо'; $('#fileMeta').textContent = file ? `${prettyBytes(file.size)} · ${file.type || 'медіа'}${file.size > RAW_PART_SIZE ? ` · ${Math.ceil(file.size / RAW_PART_SIZE)} частини` : ''}` : 'MP4, MOV, WEBM, M4A, MP3, WAV · до 500 МБ'; }
  function setUploadUi(active, pct, stage) { $('#uploadProgress').hidden = !active; $('#uploadPercent').textContent = `${Math.round(pct)}%`; $('#uploadBar').style.width = `${Math.max(0, Math.min(100, pct))}%`; $('#uploadStage').textContent = stage || 'Завантажуємо…'; }

  async function submitUpload(e) {
    e.preventDefault(); const file = el.file.files?.[0]; if (!file) return toast('Обери запис дзвінка.'); if (file.size > MAX_FILE) return toast('У безкоштовній версії один запис має бути до 500 МБ.'); if (!supported(file)) return toast('Підтримуються MP4, MOV, WEBM, M4A, MP3, WAV та OGG.');
    const button = $('#uploadButton'); button.disabled = true; let call = null;
    try {
      const fd = new FormData(e.currentTarget); const { data, error } = await sb.from(CALLS).insert({ title: String(fd.get('title')).trim(), call_date: fd.get('callDate'), status: 'uploading', stage: 'uploading', progress: 1, original_filename: file.name, mime_type: normalizeMime(file), file_size_bytes: file.size, storage_parts: [], created_by: user.id }).select(LIST_FIELDS).single(); if (error) throw error;
      call = data; calls.unshift(call); const totalParts = Math.ceil(file.size / RAW_PART_SIZE), parts = []; let uploadedBytes = 0; setUploadUi(true, 1, `Завантажуємо частину 1/${totalParts}…`);
      for (let i = 0; i < totalParts; i++) {
        const start = i * RAW_PART_SIZE, end = Math.min(file.size, start + RAW_PART_SIZE), blob = file.slice(start, end, 'application/octet-stream'), path = `${user.id}/${call.id}/part-${String(i).padStart(3, '0')}.bin`;
        await uploadTusPart(blob, path, file.lastModified, p => { const totalProgress = (uploadedBytes + p * blob.size) / file.size, pct = Math.max(1, Math.min(24, totalProgress * 24)); setUploadUi(true, pct, `Завантажуємо частину ${i + 1}/${totalParts}…`); patchLocal(call.id, { progress: Math.round(pct) }); });
        uploadedBytes += blob.size; parts.push({ index: i, path, size: blob.size }); await patchServer(call.id, { storage_parts: [...parts], progress: Math.max(1, Math.round(uploadedBytes / file.size * 24)) });
      }
      await patchServer(call.id, { status: 'transcribing', stage: 'transcribing', progress: 25 }); setUploadUi(true, 25, 'Робимо транскрипцію…'); await runPipeline(call.id); setUploadUi(true, 100, 'Готово'); await loadData(); el.modal.hidden = true; navigate('call', call.id); toast('Дзвінок проаналізовано ✓');
    } catch (err) { console.error(err); if (call) await markError(call.id, friendly(err)); toast(friendly(err)); }
    finally { button.disabled = false; setTimeout(() => setUploadUi(false, 0, ''), 400); }
  }

  function uploadTusPart(blob, path, sourceLastModified, onProgress) {
    return new Promise(async (resolve, reject) => {
      const { data: { session } } = await sb.auth.getSession(); if (!session) return reject(new Error('Сесія завершилась. Увійди ще раз.'));
      const projectRef = (cfg.supabaseUrl.match(/^https:\/\/([^.]+)/) || [])[1]; if (!projectRef) return reject(new Error('Не вдалося визначити Supabase project ref.'));
      const upload = new tus.Upload(blob, { endpoint: `https://${projectRef}.storage.supabase.co/storage/v1/upload/resumable`, retryDelays: [0, 3000, 5000, 10000, 20000], headers: { authorization: `Bearer ${session.access_token}`, 'x-upsert': 'false' }, uploadDataDuringCreation: true, removeFingerprintOnSuccess: true, chunkSize: 6 * 1024 * 1024, fingerprint: () => Promise.resolve(`yurchak-part-${path}-${blob.size}-${sourceLastModified}`), metadata: { bucketName: BUCKET, objectName: path, contentType: 'application/octet-stream', cacheControl: '3600' }, onError: error => reject(new Error(`Не вдалося завантажити частину запису: ${error.message || error}`)), onProgress: (sent, total) => onProgress(total ? sent / total : 0), onSuccess: () => resolve() });
      try { const previous = await upload.findPreviousUploads(); if (previous.length) upload.resumeFromPreviousUpload(previous[0]); upload.start(); } catch (error) { reject(error); }
    });
  }

  async function runPipeline(id) {
    if (running.has(id)) return; running.add(id);
    try {
      let c = calls.find(x => x.id === id); if (!c) return;
      if (c.status === 'transcribing') { for (;;) { const r = await api('transcribe', { callId: id }); if (r.status === 'rate_limited') { patchLocal(id, { stage: 'rate_limited', progress: 30 }); renderActive(); await sleep((r.retryAfter || 20) * 1000); continue; } break; } await refreshCall(id); }
      for (let guard = 0; guard < 100; guard++) {
        c = calls.find(x => x.id === id); if (!c || c.status === 'ready' || c.status === 'error') break;
        const r = await api('analyze_next', { callId: id });
        if (r.status === 'rate_limited') { patchLocal(id, { stage: 'rate_limited', progress: r.progress || c.progress }); renderActive(); await sleep((r.retryAfter || 35) * 1000); continue; }
        if (r.status === 'ready_to_finalize') { const f = await api('finalize', { callId: id }); if (f.status === 'completed') { await loadData(); detailCache.delete(id); renderActive(); return; } if (f.status === 'needs_analysis') { await sleep(2000); continue; } }
        else { patchLocal(id, { status: 'analyzing', stage: 'analyzing', progress: r.progress || 70 }); renderActive(); await sleep(4500); }
      }
      await refreshCall(id);
    } finally { running.delete(id); }
  }

  async function api(action, payload) {
    const { data: { session } } = await sb.auth.getSession(); if (!session) throw new Error('Сесія завершилась. Увійди ще раз.');
    const r = await fetch(`${cfg.supabaseUrl}/functions/v1/${PIPELINE}`, { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, apikey: cfg.supabasePublishableKey, 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...payload }) }); let data = null; try { data = await r.json(); } catch {}
    if (!r.ok || !data?.ok) throw new Error(data?.error || `Сервер повернув HTTP ${r.status}`); return data;
  }

  async function refreshCall(id) { const r = await sb.from(CALLS).select(LIST_FIELDS).eq('id', id).single(); if (r.data) { const i = calls.findIndex(x => x.id === id); if (i >= 0) calls[i] = r.data; else calls.unshift(r.data); renderActive(); } }
  async function patchServer(id, patch) { const r = await sb.from(CALLS).update(patch).eq('id', id).select(LIST_FIELDS).single(); if (r.error) throw r.error; const i = calls.findIndex(x => x.id === id); if (i >= 0) calls[i] = r.data; }
  function patchLocal(id, patch) { const c = calls.find(x => x.id === id); if (c) Object.assign(c, patch); }
  async function markError(id, message) { const fresh = await sb.from(CALLS).select('status').eq('id', id).single(); if (fresh.data?.status === 'ready') return; await sb.from(CALLS).update({ status: 'error', stage: 'error', progress: 0, error_message: String(message).slice(0, 1000) }).eq('id', id); patchLocal(id, { status: 'error', stage: 'error', progress: 0, error_message: message }); renderActive(); }

  function uploadedSize(c) { return Array.isArray(c.storage_parts) ? c.storage_parts.reduce((sum, p) => sum + Math.max(0, Number(p?.size || 0)), 0) : 0; }
  function uploadComplete(c) { return Number(c.file_size_bytes || 0) > 0 && uploadedSize(c) === Number(c.file_size_bytes); }
  async function recoverUploadedFiles() { for (const c of calls.filter(x => x.created_by === user.id && x.status === 'uploading')) { try { if (uploadComplete(c)) { await patchServer(c.id, { status: 'transcribing', stage: 'transcribing', progress: 25, error_message: null }); await runPipeline(c.id); } else if ((c.storage_parts || []).length) await markError(c.id, 'Завантаження було перервано. Натисни «Завантажити запис заново».'); } catch (e) { console.warn(e); } } }
  async function resumePending() { if (!navigator.onLine) return; for (const c of calls.filter(x => ['transcribing', 'analyzing'].includes(x.status))) { try { await runPipeline(c.id); } catch (e) { console.warn(e); } } }

  async function retryCall(id) {
    const r = await sb.from(CALLS).select('status,storage_path,storage_parts,file_size_bytes,transcript_text').eq('id', id).single(); if (r.error) return toast('Не вдалося перевірити стан дзвінка.');
    if (r.data.status === 'ready') { await loadData(); return renderCall(id); }
    const complete = Number(r.data.file_size_bytes || 0) > 0 && Array.isArray(r.data.storage_parts) && r.data.storage_parts.reduce((s, p) => s + Number(p?.size || 0), 0) === Number(r.data.file_size_bytes);
    if (String(r.data.transcript_text || '').trim()) { await patchServer(id, { status: 'analyzing', stage: 'analyzing', progress: 55, analysis_chunks: [], analysis_context: {}, participants: [], main_conclusion: null, error_message: null }); await runPipeline(id); }
    else if (complete || r.data.storage_path) { await patchServer(id, { status: 'transcribing', stage: 'transcribing', progress: 25, error_message: null }); await runPipeline(id); }
    else toast('Файл завантажився не повністю. Обери «Завантажити запис заново».');
  }

  async function reanalyzeCall(id) {
    if (!confirm('Оновити AI-аналіз із уже готової транскрипції? Відео повторно завантажувати не потрібно.')) return;
    await patchServer(id, { status: 'analyzing', stage: 'analyzing', progress: 55, analysis_chunks: [], analysis_context: {}, participants: [], main_conclusion: null, error_message: null }); detailCache.delete(id); renderCall(id); await runPipeline(id);
  }

  async function replaceCall(id) { await api('cancel', { callId: id }).catch(() => {}); await sb.from(CALLS).delete().eq('id', id); calls = calls.filter(x => x.id !== id); tasks = tasks.filter(t => t.call_id !== id); detailCache.delete(id); updateBadge(); navigate('calls'); openModal(); }
  async function deleteCall(id) { if (!confirm('Видалити дзвінок, транскрипцію та всі його завдання?')) return; await api('cancel', { callId: id }).catch(() => {}); const r = await sb.from(CALLS).delete().eq('id', id); if (r.error) return toast('Не вдалося видалити дзвінок.'); calls = calls.filter(x => x.id !== id); tasks = tasks.filter(t => t.call_id !== id); detailCache.delete(id); updateBadge(); navigate('calls'); }
  function renderActive() { if (view === 'overview') renderOverview(); if (view === 'calls') renderCalls($('#callSearch')?.value || ''); if (view === 'call') renderCall(currentCallId); if (view === 'tasks') renderTasks(); }

  function normalizeParticipants(v) { return Array.isArray(v) ? v.map(p => ({ name: cleanDisplay(p?.name), role: cleanDisplay(p?.role) })).filter(p => p.name && validDisplay(p.name)) : []; }
  function supported(file) { return /^(video\/(mp4|quicktime|webm)|audio\/(mp4|x-m4a|mpeg|wav|webm|ogg))$/i.test(file.type) || /\.(mp4|mov|webm|m4a|mp3|wav|ogg)$/i.test(file.name); }
  function normalizeMime(file) { const t = String(file.type || '').toLowerCase(); if (t) return t === 'audio/x-m4a' ? 'audio/mp4' : t; const n = file.name.toLowerCase(); if (n.endsWith('.mov')) return 'video/quicktime'; if (n.endsWith('.webm')) return 'video/webm'; if (n.endsWith('.m4a')) return 'audio/mp4'; if (n.endsWith('.mp3')) return 'audio/mpeg'; if (n.endsWith('.wav')) return 'audio/wav'; if (n.endsWith('.ogg')) return 'audio/ogg'; return 'video/mp4'; }
  function callText(c) { return [c.title, c.main_conclusion, ...(c.summary || []), ...(c.topics || []).flatMap(t => [t.title, ...(t.points || []), ...(t.decisions || [])])].join(' ').toLowerCase(); }
  function empty(title, text) { return `<div class="empty"><strong>${esc(title)}</strong>${text ? `<span>${esc(text)}</span>` : ''}</div>`; }
  function authError(msg) { const box = $('#authError'); box.textContent = msg; box.hidden = !msg; }
  function authMessage(msg) { if (/invalid login/i.test(msg)) return 'Невірний email або пароль.'; if (/already registered/i.test(msg)) return 'Цей email уже зареєстрований.'; return msg; }
  function fatal(msg) { el.boot.innerHTML = `<div class="auth-panel"><h2>Не вдалося запустити сайт</h2><p>${esc(msg)}</p></div>`; }
  function toast(msg) { clearTimeout(toastTimer); el.toast.textContent = msg; el.toast.hidden = false; toastTimer = setTimeout(() => el.toast.hidden = true, 6500); }
  function friendly(err) { const msg = err?.message || String(err); if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return 'Немає зв’язку з сервером. Перевір інтернет і спробуй ще раз.'; if (/Maximum size exceeded|413/i.test(msg)) return 'Одна з частин запису перевищила ліміт сховища. Онови сторінку й спробуй ще раз.'; return msg; }
  function cleanDisplay(v) { return String(v ?? '').replace(/\s+/g, ' ').trim(); }
  function validDisplay(v) { const s = cleanDisplay(v); return !!s && !/(we need|need to parse|the speaker|maybe for|last topic|json|schema|prompt|transcript fragment|model returned|коротка цитата|виконавець або)/i.test(s) && !/^\.{2,}$/.test(s); }
  function uniqueStrings(xs) { return [...new Set(xs.map(cleanDisplay).filter(Boolean))]; }
  function pluralTasks(n) { return n === 1 ? 'задача' : (n >= 2 && n <= 4 ? 'задачі' : 'задач'); }
  function esc(v = '') { return String(v).replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c])); }
  function formatDate(v) { if (!v) return ''; return new Date(`${v}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' }); }
  function shortDate(v) { if (!v) return '—'; return new Date(`${v}T12:00:00`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short' }); }
  function dateParts(v) { const d = new Date(`${v}T12:00:00`); return { day: String(d.getDate()).padStart(2, '0'), month: d.toLocaleDateString('uk-UA', { month: 'short' }).replace('.', '') }; }
  function localDate(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
  function duration(sec) { const s = Math.max(0, Math.round(Number(sec || 0))), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h} год ${m} хв` : `${m} хв`; }
  function durationCompact(sec) { const s = Math.max(0, Math.round(Number(sec || 0))), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} хв`; }
  function prettyBytes(bytes) { const u = ['Б', 'КБ', 'МБ', 'ГБ']; let n = Number(bytes || 0), i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i > 1 ? 1 : 0)} ${u[i]}`; }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();