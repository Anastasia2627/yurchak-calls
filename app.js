(() => {
  const cfg = window.YURCHAK_CONFIG || {};
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => [...root.querySelectorAll(s)];
  const MAX_FILE = 2 * 1024 * 1024 * 1024;
  const AUDIO_CHUNK_SECONDS = 70 * 60;
  const SAFE_VIDEO_FALLBACK_SECONDS = 25 * 60;
  const LIST_FIELDS = 'id,title,meeting_date,duration,status,summary,topics,original_filename,file_mime_type,error_message,created_by,created_at,updated_at,processing_stage,progress,media_duration_seconds,processed_size_bytes,completed_at';
  const TASK_FIELDS = 'id,meeting_id,assignee,text,deadline,status,source_timestamp,source_excerpt,created_at,updated_at';

  let supabase = null, user = null, meetings = [], tasks = [];
  let currentView = 'meetings', currentMeetingId = null, taskFilter = 'open';
  const runningPolls = new Set(), detailCache = new Map(), localProgress = new Map();
  let mediaLibPromise = null;

  const els = {
    setup: $('#setupScreen'), auth: $('#authScreen'), app: $('#app'),
    meetingsView: $('#meetingsView'), meetingView: $('#meetingView'), tasksView: $('#tasksView'),
    uploadModal: $('#uploadModal'), uploadForm: $('#uploadForm'), videoInput: $('#videoInput'),
    toast: $('#toast'), openTaskBadge: $('#openTaskBadge'), userEmail: $('#userEmail')
  };

  init();

  async function init() {
    bindStaticEvents();
    if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) { els.setup.hidden = false; return; }
    supabase = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) await enterApp(data.session.user); else els.auth.hidden = false;
    supabase.auth.onAuthStateChange(async (_event, session) => {
      if (session?.user && session.user.id !== user?.id) await enterApp(session.user);
      if (!session?.user && user) leaveApp();
    });
    window.addEventListener('online', () => resumePendingMeetings());
  }

  function bindStaticEvents() {
    $('#authForm').addEventListener('submit', login);
    $('#signUpButton').addEventListener('click', signUp);
    $('#logoutButton').addEventListener('click', () => supabase?.auth.signOut());
    $('#mobileMenuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
    $$('.nav-button').forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
    $$('[data-close-modal]').forEach(btn => btn.addEventListener('click', closeUploadModal));
    els.uploadModal.addEventListener('click', e => { if (e.target === els.uploadModal) closeUploadModal(); });
    els.uploadForm.addEventListener('submit', submitUpload);
    els.videoInput.addEventListener('change', () => showSelectedFile(els.videoInput.files?.[0]));
    const drop = $('#fileDrop');
    ['dragenter','dragover'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.add('dragging'); }));
    ['dragleave','drop'].forEach(type => drop.addEventListener(type, e => { e.preventDefault(); drop.classList.remove('dragging'); }));
    drop.addEventListener('drop', e => {
      const file = e.dataTransfer.files?.[0]; if (!file) return;
      const dt = new DataTransfer(); dt.items.add(file); els.videoInput.files = dt.files; showSelectedFile(file);
    });
  }

  async function login(e) {
    e.preventDefault(); setAuthError('');
    const fd = new FormData(e.currentTarget);
    const { error } = await supabase.auth.signInWithPassword({ email: String(fd.get('email')).trim(), password: fd.get('password') });
    if (error) setAuthError(humanAuthError(error.message));
  }

  async function signUp() {
    setAuthError(''); const form = $('#authForm'); if (!form.reportValidity()) return;
    const fd = new FormData(form), email = String(fd.get('email')).trim().toLowerCase();
    const { data, error } = await supabase.auth.signUp({ email, password: fd.get('password') });
    if (error) return setAuthError(humanAuthError(error.message));
    if (!data.session) setAuthError('Аккаунт создан. Если включено подтверждение email — подтверди письмо и войди. Доступ к данным будет только у email из списка команды.');
  }

  async function enterApp(nextUser) {
    user = nextUser;
    const { data: member, error } = await supabase.from('team_members').select('email,role,active').eq('email', String(user.email || '').toLowerCase()).maybeSingle();
    if (error || !member?.active) {
      await supabase.auth.signOut(); user = null; els.app.hidden = true; els.auth.hidden = false;
      setAuthError('У этого email нет доступа к проекту. Попроси администратора добавить его в команду.'); return;
    }
    els.auth.hidden = true; els.setup.hidden = true; els.app.hidden = false; els.userEmail.textContent = user.email || '';
    await loadData(); await repairStaleUploads(); navigate(currentView); resumePendingMeetings();
  }

  function leaveApp() {
    user = null; meetings = []; tasks = []; currentMeetingId = null; detailCache.clear(); runningPolls.clear();
    els.app.hidden = true; els.auth.hidden = false;
  }

  async function loadData() {
    const [{ data: ms, error: me }, { data: ts, error: te }] = await Promise.all([
      supabase.from('meetings').select(LIST_FIELDS).order('meeting_date', { ascending:false }).order('created_at', { ascending:false }).limit(300),
      supabase.from('tasks').select(TASK_FIELDS).order('created_at', { ascending:false }).limit(3000)
    ]);
    if (me || te) { toast('Не удалось загрузить данные.'); return; }
    meetings = ms || []; tasks = ts || []; updateTaskBadge();
  }

  async function repairStaleUploads() {
    const cutoff = Date.now() - 30 * 60 * 1000;
    const stale = meetings.filter(m => m.status === 'uploading' && new Date(m.updated_at || m.created_at).getTime() < cutoff);
    for (const m of stale) {
      const msg = 'Загрузка была прервана до отправки аудио. Удали эту запись и загрузи файл заново.';
      await supabase.from('meetings').update({ status:'error', error_message:msg, processing_stage:'interrupted' }).eq('id', m.id);
      Object.assign(m, { status:'error', error_message:msg, processing_stage:'interrupted' });
    }
  }

  function navigate(view, meetingId = null) {
    currentView = view; if (meetingId) currentMeetingId = meetingId;
    els.meetingsView.hidden = view !== 'meetings'; els.meetingView.hidden = view !== 'meeting'; els.tasksView.hidden = view !== 'tasks';
    $$('.nav-button').forEach(b => b.classList.toggle('active', b.dataset.view === (view === 'meeting' ? 'meetings' : view)));
    $('.sidebar').classList.remove('open');
    if (view === 'meetings') renderMeetings();
    if (view === 'tasks') renderTasks();
    if (view === 'meeting') renderMeeting(meetingId);
    window.scrollTo({ top:0, behavior:'smooth' });
  }

  function renderMeetings(query = '') {
    const q = query.trim().toLowerCase();
    const filtered = meetings.filter(m => !q || searchableMeeting(m).includes(q));
    els.meetingsView.innerHTML = `
      <div class="page-head"><div><p class="kicker">ЮРЧАК</p><h1>Созвоны</h1><p>Запись → транскрипция → решения → задачи.</p></div><button class="primary-button" data-upload>＋ Загрузить запись</button></div>
      <article class="upload-card"><div><p class="kicker">НОВАЯ ЗАПИСЬ</p><h2>Видео → готовый разбор</h2><p>Загрузи Zoom-запись. В браузере мы отделим аудио, чтобы не тратить лимиты на видеокадры, а затем AI сделает разбор.</p></div><button class="primary-button" data-upload>Загрузить видео</button></article>
      <div class="toolbar"><h2 class="section-title">Все созвоны</h2><input id="meetingSearch" class="search-input" placeholder="Поиск по созвонам..." value="${esc(query)}"></div>
      <div class="meeting-list">${filtered.length ? filtered.map(meetingRow).join('') : emptyMeetings(q)}</div>`;
    $$('[data-upload]', els.meetingsView).forEach(b => b.onclick = openUploadModal);
    $('#meetingSearch')?.addEventListener('input', e => renderMeetings(e.target.value));
    $$('[data-open-meeting]', els.meetingsView).forEach(b => b.onclick = () => navigate('meeting', b.dataset.openMeeting));
  }

  function meetingRow(m) {
    const d = dateParts(m.meeting_date), ready = m.status === 'ready', p = effectiveProgress(m), open = tasks.filter(t => t.meeting_id === m.id && t.status !== 'done').length;
    return `<article class="meeting-row"><div class="date-box"><strong>${d.day}</strong><span>${d.month}</span></div><div class="meeting-info"><h3>${esc(m.title)}</h3><div class="meta"><span>${formatDate(m.meeting_date)}</span>${m.duration ? `<span>${esc(m.duration)}</span>` : ''}${ready ? `<span>${(m.topics||[]).length} тем</span><span>${open} задач</span>` : statusPill(m)}</div></div>${ready ? `<button class="secondary-button" data-open-meeting="${m.id}">Открыть</button>` : progressCell(m,p)}</article>`;
  }

  function effectiveProgress(m) { const lp = localProgress.get(m.id); return lp ? lp.pct : Number(m.progress || 0); }
  function stageText(m) {
    const lp = localProgress.get(m.id); if (lp?.text) return lp.text;
    const map = { extracting_audio:'Извлекаем звук', uploading_audio:'Загружаем аудио', gemini_preparing:'Готовим аудио', queued:'Ждём свободный лимит', rate_limited:'Лимит API — скоро повторим', transcribing:'Расшифровываем и разбираем', merging:'Собираем общий итог', retrying:'Повторяем неудачный фрагмент', interrupted:'Загрузка прервана' };
    return map[m.processing_stage] || ({uploading:'Подготавливаем',preparing:'Готовим аудио',queued:'В очереди',analyzing:'AI разбирает',error:'Ошибка'})[m.status] || 'Обработка';
  }
  function statusPill(m) { return `<span class="pill ${m.status === 'error' ? 'error' : 'processing'}">${m.status === 'error' ? '' : '<span class="spinner"></span>'}${esc(stageText(m))}</span>`; }
  function progressCell(m,pct) {
    if (m.status === 'error') return `<div class="progress-wrap"><button class="secondary-button" data-open-meeting="${m.id}">Подробнее</button></div>`;
    const p = Math.max(3, Math.min(99, Number(pct || 8)));
    return `<div class="progress-wrap"><div class="meta" style="justify-content:flex-end"><span class="spinner"></span>${esc(stageText(m))} · ${Math.round(p)}%</div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div></div>`;
  }
  function emptyMeetings(q) { return `<div class="empty"><strong>${q?'Ничего не найдено':'Здесь появятся созвоны'}</strong>${q?'Попробуй другой запрос.':'Загрузи первую запись созвона.'}</div>`; }
  function searchableMeeting(m) { return [m.title,...(m.summary||[]),...(m.topics||[]).flatMap(t=>[t.title,...(t.summary||[]),...(t.decisions||[])])].join(' ').toLowerCase(); }

  async function renderMeeting(id) {
    const m = meetings.find(x => x.id === id); if (!m) return navigate('meetings');
    const mtasks = tasks.filter(t => t.meeting_id === id);
    if (m.status !== 'ready') {
      els.meetingView.innerHTML = `<button class="back-button" data-back>← К созвонам</button><div class="detail-head"><div><p class="kicker">${formatDate(m.meeting_date)}</p><h1>${esc(m.title)}</h1>${statusPill(m)}</div></div><div class="card"><h2>${m.status==='error'?'Не удалось обработать запись':'Созвон обрабатывается'}</h2><p class="muted-copy">${m.status==='error'?esc(m.error_message||'Попробуй загрузить файл ещё раз.'):'Можно закрыть вкладку. Если AI уже запущен, обработка продолжится; при следующем входе сайт подхватит результат.'}</p><div class="progress-track"><div class="progress-fill" style="width:${Math.max(3,effectiveProgress(m))}%"></div></div>${m.status==='error'?'<button class="secondary-button" data-delete>Удалить</button>':''}</div>`;
      $('[data-back]', els.meetingView).onclick=()=>navigate('meetings'); if ($('[data-delete]',els.meetingView)) $('[data-delete]',els.meetingView).onclick=()=>deleteMeeting(id); return;
    }
    const details = await ensureMeetingDetails(id); if (!details) return;
    els.meetingView.innerHTML = `<button class="back-button" data-back>← К созвонам</button>
      <div class="detail-head"><div><p class="kicker">${formatDate(m.meeting_date)}</p><h1>${esc(m.title)}</h1><div class="meta">${m.duration?`<span>${esc(m.duration)}</span>`:''}<span class="pill ready">Готово</span></div></div><button class="secondary-button" data-delete>Удалить</button></div>
      <div class="detail-grid"><div class="detail-main">
        <article class="card"><p class="kicker">ЗА 30 СЕКУНД</p><h2>Коротко</h2><ul class="summary-list">${(details.summary||[]).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>Краткий итог не сформирован.</li>'}</ul></article>
        <article class="card"><h2>Обсуждение по темам</h2>${(details.topics||[]).map(topicHtml).join('')||'<p class="muted-copy">Темы не определены.</p>'}</article>
        <article class="card"><details id="transcriptDetails"><summary><strong>Полная транскрипция</strong><span class="muted-copy"> Загружается только когда нужна</span></summary><div id="transcriptBox" class="transcript"><p class="muted-copy">Нажми, чтобы открыть.</p></div></details></article>
      </div><aside class="card tasks-side"><h2>Задачи</h2><div>${mtasks.length?mtasks.map(taskMini).join(''):'<div class="empty small"><strong>Задач нет</strong></div>'}</div></aside></div>`;
    $('[data-back]', els.meetingView).onclick=()=>navigate('meetings'); $('[data-delete]',els.meetingView).onclick=()=>deleteMeeting(id); bindStatusSelects(els.meetingView);
    $('#transcriptDetails')?.addEventListener('toggle', e => { if (e.currentTarget.open) renderTranscript(details.transcript || []); }, { once:true });
  }

  async function ensureMeetingDetails(id) {
    if (detailCache.has(id)) return detailCache.get(id);
    els.meetingView.innerHTML = '<div class="empty"><span class="spinner"></span><strong>Открываем созвон…</strong></div>';
    const { data, error } = await supabase.from('meetings').select('id,summary,topics,transcript').eq('id', id).single();
    if (error) { toast('Не удалось открыть созвон.'); return null; }
    detailCache.set(id,data); return data;
  }
  function renderTranscript(lines) {
    const box=$('#transcriptBox'); if(!box)return;
    box.innerHTML = lines.length ? lines.map(x=>`<div class="transcript-line"><span class="timestamp">${esc(x.timestamp||'')}</span><strong>${esc(x.speaker||'Участник')}</strong><p>${esc(x.text||'')}</p></div>`).join('') : '<p class="muted-copy">Транскрипция пуста.</p>';
  }
  function topicHtml(t) { return `<section class="topic"><div class="topic-head"><h3>${esc(t.title||'Тема')}</h3><span>${esc(t.start||'')}${t.end?` – ${esc(t.end)}`:''}</span></div>${(t.summary||[]).length?`<ul>${t.summary.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${(t.decisions||[]).map(x=>`<div class="decision"><strong>Решение</strong>${esc(x)}</div>`).join('')}</section>`; }
  function taskMini(t) { return `<div class="task-card"><strong>${esc(t.text)}</strong><div class="meta"><span>${esc(t.assignee||'Без исполнителя')}</span>${t.deadline?`<span>до ${formatDate(t.deadline)}</span>`:''}${t.source_timestamp?`<span>${esc(t.source_timestamp)}</span>`:''}</div>${t.source_excerpt?`<p class="source-excerpt">«${esc(t.source_excerpt)}»</p>`:''}${statusSelect(t)}</div>`; }

  function renderTasks() {
    const shown = tasks.filter(t => taskFilter==='all' || (taskFilter==='open' ? t.status!=='done' : t.status==='done'));
    els.tasksView.innerHTML = `<div class="page-head"><div><p class="kicker">ЮРЧАК</p><h1>Задачи</h1><p>Action items, которые AI нашёл в созвонах.</p></div></div><div class="filters"><button class="filter-button ${taskFilter==='open'?'active':''}" data-filter="open">Открытые</button><button class="filter-button ${taskFilter==='done'?'active':''}" data-filter="done">Готовые</button><button class="filter-button ${taskFilter==='all'?'active':''}" data-filter="all">Все</button></div><div id="tasksList" class="tasks-list">${shown.length?shown.map(taskRow).join(''):'<div class="empty"><strong>Задач нет</strong></div>'}</div>`;
    $$('[data-filter]',els.tasksView).forEach(b=>b.onclick=()=>{taskFilter=b.dataset.filter;renderTasks();}); bindStatusSelects($('#tasksList'));
    $$('[data-source-meeting]',$('#tasksList')).forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.sourceMeeting));
  }
  function taskRow(t) { const m=meetings.find(x=>x.id===t.meeting_id); return `<article class="task-row"><div><strong>${esc(t.text)}</strong>${m?`<button class="source-link" data-source-meeting="${m.id}">${esc(m.title)}${t.source_timestamp?` · ${esc(t.source_timestamp)}`:''}</button>`:''}${t.source_excerpt?`<p class="source-excerpt">«${esc(t.source_excerpt)}»</p>`:''}</div><div>${esc(t.assignee||'Без исполнителя')}</div>${statusSelect(t)}</article>`; }
  function statusSelect(t) { return `<select class="status-select ${t.status==='done'?'done':''}" data-task-status="${t.id}"><option value="todo" ${t.status==='todo'?'selected':''}>Новая</option><option value="doing" ${t.status==='doing'?'selected':''}>В работе</option><option value="done" ${t.status==='done'?'selected':''}>Готово</option></select>`; }
  function bindStatusSelects(root) { $$('[data-task-status]',root).forEach(sel=>sel.onchange=async()=>{ const old=tasks.find(t=>t.id===sel.dataset.taskStatus)?.status; const {error}=await supabase.from('tasks').update({status:sel.value}).eq('id',sel.dataset.taskStatus); if(error){sel.value=old||'todo';return toast('Не удалось изменить статус.');} const t=tasks.find(x=>x.id===sel.dataset.taskStatus); if(t)t.status=sel.value;updateTaskBadge(); if(currentView==='tasks')renderTasks(); }); }
  function updateTaskBadge(){const n=tasks.filter(t=>t.status!=='done').length;els.openTaskBadge.textContent=n;els.openTaskBadge.hidden=!n;}

  function openUploadModal() {
    els.uploadForm.reset(); const now=new Date(); els.uploadForm.elements.meetingDate.value=localDate(now); els.uploadForm.elements.title.value=`Созвон ${now.toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}`; showSelectedFile(null); els.uploadModal.hidden=false;
  }
  function closeUploadModal(){els.uploadModal.hidden=true;}
  function showSelectedFile(file){$('#fileDropTitle').textContent=file?file.name:'Выбрать видео';$('#fileDropText').textContent=file?`${prettyBytes(file.size)} · ${file.type||'медиа'} · отправим только звук`:'MP4, MOV, WEBM, M4A, MP3 · до 2 ГБ';}

  async function submitUpload(e) {
    e.preventDefault(); const file=els.videoInput.files?.[0]; if(!file)return toast('Выбери запись созвона.');
    if(file.size>MAX_FILE)return toast('Файл больше 2 ГБ — Gemini Free такой файл не примет.');
    if(!isSupportedName(file))return toast('Поддерживаются MP4, MOV, WEBM, M4A, MP3 и WAV.');
    const submit=$('#uploadSubmit'); submit.disabled=true; let meeting=null;
    try {
      submit.textContent='Проверяем запись…'; const fd=new FormData(e.currentTarget); const originalMime=normalizeMime(file.type||mimeFromName(file.name));
      const {data,error}=await supabase.from('meetings').insert({title:String(fd.get('title')).trim(),meeting_date:fd.get('meetingDate'),status:'uploading',processing_stage:'extracting_audio',progress:3,original_filename:file.name,file_mime_type:originalMime,created_by:user.id}).select(LIST_FIELDS).single();
      if(error)throw error; meeting=data; meetings.unshift(meeting); closeUploadModal(); renderMeetings();

      const media=await prepareMedia(file, meeting.id, submit);
      await patchMeetingServer(meeting.id,{media_duration_seconds:Math.round(media.duration),processed_size_bytes:media.parts.reduce((a,p)=>a+p.blob.size,0),processing_stage:'uploading_audio',progress:25});
      const uploaded=[]; let uploadedBytes=0, totalBytes=media.parts.reduce((a,p)=>a+p.blob.size,0);
      for(let i=0;i<media.parts.length;i++){
        const part=media.parts[i]; submit.textContent=`Загружаем звук ${i+1}/${media.parts.length}…`;
        const result=await uploadPartWithRetry(part,(partLoaded)=>{ const pct=25+35*((uploadedBytes+partLoaded)/Math.max(1,totalBytes)); setLocalProgress(meeting.id,pct,`Загружаем звук ${i+1}/${media.parts.length}`); });
        uploadedBytes+=part.blob.size;
        uploaded.push({index:i,name:result.name,uri:result.uri,mime_type:result.mimeType||part.mimeType,start_seconds:part.start,end_seconds:part.end,size_bytes:part.blob.size});
      }
      localProgress.delete(meeting.id);
      await pipeline('register_files',{meetingId:meeting.id,files:uploaded,durationSeconds:media.duration,processedSizeBytes:totalBytes});
      patchMeeting(meeting.id,{status:'preparing',processing_stage:'gemini_preparing',progress:60,media_duration_seconds:Math.round(media.duration),processed_size_bytes:totalBytes});
      renderMeetings($('#meetingSearch')?.value||''); processMeeting(meeting.id);
      toast(media.usedAudioExtraction?'Видео не сохраняем — в AI ушёл только звук.':'Запись загружена. Начинаем разбор.');
    } catch(err) {
      console.error(err); if(meeting) await markMeetingError(meeting.id,readableError(err)); toast(readableError(err));
    } finally { submit.disabled=false; submit.textContent='Загрузить и разобрать'; }
  }

  async function prepareMedia(file, meetingId, submit) {
    const type=normalizeMime(file.type||mimeFromName(file.name));
    if(type.startsWith('audio/')){
      let info;
      try { info=await inspectMedia(file); }
      catch { info={duration:await browserMediaDuration(file).catch(()=>0),audio:true,video:false}; }
      const duration=Number(info.duration||0);
      if(type==='audio/m4a' || type==='audio/mp4' || duration>AUDIO_CHUNK_SECONDS) return extractAudioParts(file,duration||estimateAudioDuration(file),meetingId,submit);
      return {duration:duration||estimateAudioDuration(file),parts:[{blob:file,fileName:file.name,mimeType:type,start:0,end:duration||0}],usedAudioExtraction:false};
    }
    try {
      const info=await inspectMedia(file); if(!info.audio)throw new Error('В файле нет аудиодорожки.');
      return await extractAudioParts(file,info.duration,meetingId,submit);
    } catch(err) {
      console.warn('Audio extraction unavailable',err);
      const duration=await browserMediaDuration(file).catch(()=>0);
      if(duration && duration<=SAFE_VIDEO_FALLBACK_SECONDS){
        return {duration,parts:[{blob:file,fileName:file.name,mimeType:type,start:0,end:duration}],usedAudioExtraction:false};
      }
      throw new Error('Не удалось безопасно извлечь аудио из этого видео. Открой сайт в актуальном Chrome и попробуй снова либо экспортируй Zoom-запись как M4A/MP3.');
    }
  }

  async function mediaLib(){ if(!mediaLibPromise)mediaLibPromise=import('https://cdn.jsdelivr.net/npm/mediabunny@1.55.1/+esm'); return mediaLibPromise; }
  async function inspectMedia(file){ const M=await mediaLib(); const input=new M.Input({formats:M.ALL_FORMATS,source:new M.BlobSource(file)}); if(!(await input.canRead()))throw new Error('Формат записи не читается браузером.'); const audio=await input.getPrimaryAudioTrack(); const video=await input.getPrimaryVideoTrack(); let duration=await input.getDurationFromMetadata(); if(!duration||!Number.isFinite(duration))duration=await input.computeDuration(); return {duration:Number(duration||0),audio:!!audio,video:!!video}; }

  async function extractAudioParts(file,duration,meetingId,submit){
    const M=await mediaLib(); const total=Math.max(1,Math.ceil(duration/AUDIO_CHUNK_SECONDS)), parts=[];
    for(let i=0;i<total;i++){
      const start=i*AUDIO_CHUNK_SECONDS,end=Math.min(duration,(i+1)*AUDIO_CHUNK_SECONDS);
      submit.textContent=`Извлекаем звук ${i+1}/${total}…`; setLocalProgress(meetingId,5+18*(i/total),`Извлекаем звук ${i+1}/${total}`);
      let result;
      try { result=await convertAudioChunk(M,file,start,end,p=>setLocalProgress(meetingId,5+18*((i+p)/total),`Извлекаем звук ${i+1}/${total}`),false); }
      catch(first){ console.warn('AAC remux unavailable, using PCM WAV',first); result=await convertAudioChunk(M,file,start,end,p=>setLocalProgress(meetingId,5+18*((i+p)/total),`Оптимизируем звук ${i+1}/${total}`),true); }
      parts.push({blob:result.blob,fileName:`${baseName(file.name)}-audio-${String(i+1).padStart(2,'0')}.${result.extension}`,mimeType:result.mimeType,start,end});
      await sleep(0);
    }
    return {duration,parts,usedAudioExtraction:true};
  }

  async function convertAudioChunk(M,file,start,end,onProgress,useWavFallback){
    const input=new M.Input({formats:M.ALL_FORMATS,source:new M.BlobSource(file)}), target=new M.BufferTarget();
    const format=useWavFallback?new M.WavOutputFormat():new M.AdtsOutputFormat();
    const output=new M.Output({format,target});
    const conversion=await M.Conversion.init({input,output,video:{discard:true},audio:useWavFallback?{codec:'pcm-s16',numberOfChannels:1,sampleRate:16000,forceTranscode:true}:undefined,trim:{start,end},showWarnings:false});
    if(!conversion.isValid)throw new Error('Аудиодорожку нельзя преобразовать в браузере.'); conversion.onProgress=p=>onProgress(Number(p||0)); await conversion.execute();
    if(!target.buffer)throw new Error('Не удалось получить аудиофайл.');
    const mimeType=String(format.mimeType|| (useWavFallback?'audio/wav':'audio/aac'));
    const extension=String(format.fileExtension|| (useWavFallback?'.wav':'.aac')).replace(/^\./,'');
    return {blob:new Blob([target.buffer],{type:mimeType}),mimeType,extension};
  }

  async function uploadPartWithRetry(part,onProgress){
    let lastErr;
    for(let attempt=1;attempt<=3;attempt++){
      try{
        const s=await pipeline('create_upload',{fileName:part.fileName,fileSize:part.blob.size,mimeType:part.mimeType});
        const mime=s.mimeType||part.mimeType;
        const uploaded=await xhrUpload(s.uploadUrl,part.blob,mime,onProgress);
        return {...uploaded,mimeType:mime};
      }catch(err){lastErr=err;if(attempt<3)await sleep(1500*Math.pow(2,attempt-1));}
    }
    throw lastErr||new Error('Не удалось загрузить аудио.');
  }
  function xhrUpload(url,blob,mime,onProgress){ return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('POST',url,true);xhr.timeout=15*60*1000;xhr.setRequestHeader('X-Goog-Upload-Offset','0');xhr.setRequestHeader('X-Goog-Upload-Command','upload, finalize');xhr.setRequestHeader('Content-Type',mime);xhr.upload.onprogress=e=>{if(e.lengthComputable)onProgress(e.loaded)};xhr.onerror=()=>reject(new Error('Интернет оборвался во время загрузки.'));xhr.ontimeout=()=>reject(new Error('Загрузка заняла слишком много времени.'));xhr.onload=()=>{if(xhr.status<200||xhr.status>=300)return reject(new Error(`Gemini отклонил аудио (${xhr.status}).`));try{const f=JSON.parse(xhr.responseText).file;if(!f?.name||!f?.uri)throw 0;resolve(f)}catch{reject(new Error('Gemini не вернул данные файла.'))}};xhr.send(blob);}); }

  async function processMeeting(id){
    if(runningPolls.has(id))return; runningPolls.add(id);
    try{
      let transientFailures=0;
      for(let cycle=0;cycle<720;cycle++){
        let m=meetings.find(x=>x.id===id); if(!m)return;
        try{
          if(m.status==='preparing'){
            const f=await pipeline('files_status',{meetingId:id}); transientFailures=0;
            if(f.state==='FAILED')throw new PermanentError(f.error||'Не удалось подготовить аудио.');
            if(f.state!=='ACTIVE'){patchMeeting(id,{processing_stage:'gemini_preparing',progress:Math.max(60,m.progress||60)});await sleep((f.retryAfter||8)*1000);continue;}
            patchMeeting(id,{status:'queued',processing_stage:'queued',progress:68});
          }
          m=meetings.find(x=>x.id===id);
          if(['queued','preparing'].includes(m.status)){
            const s=await pipeline('start_analysis',{meetingId:id}); transientFailures=0;
            if(s.status==='queued'){patchMeeting(id,{status:'queued',processing_stage:'rate_limited',progress:70});await sleep((s.retryAfter||70)*1000);continue;}
            patchMeeting(id,{status:'analyzing',processing_stage:'transcribing',progress:74});
          }
          const r=await pipeline('analysis_status',{meetingId:id}); transientFailures=0;
          if(r.status==='completed'){await loadData();detailCache.delete(id);toast('Созвон готов ✓');if(currentView==='meetings')renderMeetings($('#meetingSearch')?.value||'');if(currentView==='meeting'&&currentMeetingId===id)renderMeeting(id);return;}
          if(r.status==='failed')throw new PermanentError(r.error||'AI не смог обработать созвон.');
          const patch={}; if(r.status==='queued'){patch.status='queued';patch.processing_stage=r.warning?'retrying':'rate_limited';}else{patch.status='analyzing';patch.processing_stage=r.stage||'transcribing';} if(r.progress)patch.progress=r.progress; patchMeeting(id,patch); if(currentView==='meetings')renderMeetings($('#meetingSearch')?.value||'');
          await sleep((r.retryAfter||10)*1000);
        }catch(err){
          if(err instanceof PermanentError)throw err;
          transientFailures++; console.warn('Transient pipeline error',err);
          if(transientFailures>=8){toast('Связь нестабильна. Разбор продолжится при следующем открытии сайта.');return;}
          await sleep(Math.min(60000,3000*Math.pow(2,Math.min(transientFailures,4))));
        }
      }
      toast('Разбор всё ещё идёт. Его можно проверить позже.');
    }catch(err){console.error(err);await markMeetingError(id,readableError(err));toast(readableError(err));}
    finally{runningPolls.delete(id);}
  }
  class PermanentError extends Error{}
  function resumePendingMeetings(){ if(!navigator.onLine)return; meetings.filter(m=>['preparing','queued','analyzing'].includes(m.status)).forEach(m=>processMeeting(m.id)); }
  async function pipeline(action,payload={}){ const {data,error}=await supabase.functions.invoke('video-pipeline',{body:{action,...payload}}); if(error)throw new Error(error.message||'Ошибка сервера.'); if(!data?.ok)throw new Error(data?.error||'Ошибка обработки.'); return data; }

  async function deleteMeeting(id){
    if(!confirm('Удалить созвон, транскрипцию и его задачи?'))return;
    await pipeline('cancel',{meetingId:id}).catch(()=>{}); const {error}=await supabase.from('meetings').delete().eq('id',id); if(error)return toast('Не удалось удалить созвон.');
    meetings=meetings.filter(m=>m.id!==id);tasks=tasks.filter(t=>t.meeting_id!==id);detailCache.delete(id);localProgress.delete(id);updateTaskBadge();navigate('meetings');
  }
  async function markMeetingError(id,msg){await supabase.from('meetings').update({status:'error',error_message:msg,processing_stage:'error'}).eq('id',id);patchMeeting(id,{status:'error',error_message:msg,processing_stage:'error'});if(currentView==='meetings')renderMeetings($('#meetingSearch')?.value||'');}
  async function patchMeetingServer(id,patch){const {error}=await supabase.from('meetings').update(patch).eq('id',id);if(error)throw error;patchMeeting(id,patch);}
  function patchMeeting(id,patch){const m=meetings.find(x=>x.id===id);if(m)Object.assign(m,patch);}
  function setLocalProgress(id,pct,text){localProgress.set(id,{pct,text});if(currentView==='meetings')renderMeetings($('#meetingSearch')?.value||'');}

  function setAuthError(msg){const b=$('#authError');b.textContent=msg;b.hidden=!msg;}
  function humanAuthError(msg){if(/invalid login/i.test(msg))return'Неверный email или пароль.';if(/already registered/i.test(msg))return'Этот email уже зарегистрирован.';return msg;}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function formatDate(v){if(!v)return'';return new Date(`${v}T12:00:00`).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'});}
  function dateParts(v){const d=new Date(`${v}T12:00:00`);return{day:String(d.getDate()).padStart(2,'0'),month:d.toLocaleDateString('ru-RU',{month:'short'}).replace('.','')};}
  function localDate(d){const y=d.getFullYear(),m=String(d.getMonth()+1).padStart(2,'0'),day=String(d.getDate()).padStart(2,'0');return`${y}-${m}-${day}`;}
  function prettyBytes(bytes){const u=['Б','КБ','МБ','ГБ'];let i=0,n=Number(bytes||0);while(n>=1024&&i<u.length-1){n/=1024;i++;}return`${n.toFixed(i>1?1:0)} ${u[i]}`;}
  function baseName(name){return name.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9а-яА-ЯёЁ_-]+/g,'-').slice(0,70)||'meeting';}
  function safePartName(name,i,type){return`${baseName(name)}-${type}-${String(i).padStart(2,'0')}.${type==='audio'?'m4a':'mp4'}`;}
  function mimeFromName(name){const x=name.toLowerCase();if(x.endsWith('.m4a'))return'audio/m4a';if(x.endsWith('.mp3'))return'audio/mpeg';if(x.endsWith('.wav'))return'audio/wav';if(x.endsWith('.mov'))return'video/quicktime';if(x.endsWith('.webm'))return'video/webm';return'video/mp4';}
  function normalizeMime(v){const m=String(v||'').toLowerCase().split(';')[0];return({'video/quicktime':'video/mov','audio/x-m4a':'audio/m4a','audio/mp4':'audio/m4a'}[m]||m||'video/mp4');}
  function isSupportedName(f){return/^(video|audio)\//.test(f.type)||/\.(mp4|mov|webm|m4a|mp3|wav)$/i.test(f.name);}
  function estimateAudioDuration(file){const br=128000;return Math.round(file.size*8/br);}
  function browserMediaDuration(file){return new Promise((resolve,reject)=>{const el=document.createElement(file.type.startsWith('audio/')?'audio':'video'),url=URL.createObjectURL(file);el.preload='metadata';el.onloadedmetadata=()=>{const d=el.duration;URL.revokeObjectURL(url);Number.isFinite(d)?resolve(d):reject(new Error('Нет длительности'));};el.onerror=()=>{URL.revokeObjectURL(url);reject(new Error('Не читается'));};el.src=url;});}
  function readableError(err){const msg=err?.message||String(err);if(/Failed to fetch|NetworkError|Load failed/i.test(msg))return'Не удалось связаться с сервером. Проверь интернет и повтори.';if(/429|quota|rate limit/i.test(msg))return'Сейчас достигнут лимит Gemini. Созвон сохранён — попробуем продолжить позже.';return msg;}
  let toastTimer;function toast(msg){clearTimeout(toastTimer);els.toast.textContent=msg;els.toast.hidden=false;toastTimer=setTimeout(()=>els.toast.hidden=true,6500);}
})();
