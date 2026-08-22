(() => {
  const cfg = window.YURCHAK_CONFIG || {};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const MAX_FILE = 2 * 1024 * 1024 * 1024;
  const CHUNK_SECONDS = 70 * 60;
  const LIST_FIELDS = 'id,title,meeting_date,duration,status,summary,topics,original_filename,file_mime_type,error_message,created_by,created_at,updated_at,processing_stage,progress,media_duration_seconds,processed_size_bytes,completed_at';
  const TASK_FIELDS = 'id,meeting_id,assignee,text,deadline,status,source_timestamp,source_excerpt,created_at,updated_at';

  let sb = null, user = null, meetings = [], tasks = [];
  let view = 'overview', currentMeetingId = null, meetingFilter = 'all', taskFilter = 'open';
  const detailCache = new Map(), polls = new Set(), localProgress = new Map();
  let mediaLibPromise = null;

  const el = {
    setup: $('#setupScreen'), auth: $('#authScreen'), app: $('#app'),
    overview: $('#overviewView'), meetings: $('#meetingsView'), meeting: $('#meetingView'), tasks: $('#tasksView'),
    modal: $('#uploadModal'), form: $('#uploadForm'), file: $('#videoInput'), toast: $('#toast'), badge: $('#openTaskBadge')
  };

  init();

  async function init() {
    bindStatic();
    if (!cfg.supabaseUrl || !cfg.supabasePublishableKey) { el.setup.hidden = false; return; }
    sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, { auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true} });
    const {data} = await sb.auth.getSession();
    if (data.session?.user) await enter(data.session.user); else el.auth.hidden = false;
    sb.auth.onAuthStateChange(async (_e, session) => {
      if (session?.user && session.user.id !== user?.id) await enter(session.user);
      if (!session && user) leave();
    });
    addEventListener('online', resumePending);
  }

  function bindStatic() {
    $('#authForm').addEventListener('submit', login);
    $('#signUpButton').addEventListener('click', signup);
    $('#logoutButton').addEventListener('click', () => sb?.auth.signOut());
    $('#mobileMenuButton').addEventListener('click', () => $('.sidebar').classList.toggle('open'));
    $$('.nav-item').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
    $$('[data-close-modal]').forEach(b => b.addEventListener('click', closeModal));
    el.modal.addEventListener('click', e => { if (e.target === el.modal) closeModal(); });
    el.form.addEventListener('submit', uploadMeeting);
    el.file.addEventListener('change', () => showFile(el.file.files?.[0]));
    const drop = $('#fileDrop');
    ['dragenter','dragover'].forEach(t => drop.addEventListener(t,e=>{e.preventDefault();drop.classList.add('dragging')}));
    ['dragleave','drop'].forEach(t => drop.addEventListener(t,e=>{e.preventDefault();drop.classList.remove('dragging')}));
    drop.addEventListener('drop', e => { const f=e.dataTransfer.files?.[0]; if(!f)return; const dt=new DataTransfer();dt.items.add(f);el.file.files=dt.files;showFile(f); });
  }

  async function login(e) {
    e.preventDefault(); authError(''); const fd=new FormData(e.currentTarget);
    const {error}=await sb.auth.signInWithPassword({email:String(fd.get('email')).trim(),password:fd.get('password')});
    if(error) authError(authMessage(error.message));
  }

  async function signup() {
    const form=$('#authForm'); if(!form.reportValidity())return; authError('');
    const fd=new FormData(form), email=String(fd.get('email')).trim(), password=String(fd.get('password'));
    const {data,error}=await sb.auth.signUp({email,password});
    if(error)return authError(authMessage(error.message));
    if(data.session)return;
    const signIn=await sb.auth.signInWithPassword({email,password});
    if(signIn.error)authError('Акаунт створено. Спробуй натиснути «Увійти».');
  }

  async function enter(u) {
    user=u; el.auth.hidden=true;el.setup.hidden=true;el.app.hidden=false;$('#userEmail').textContent=u.email||'';
    await loadData(); await repairInterrupted(); navigate(view); resumePending();
  }
  function leave(){user=null;meetings=[];tasks=[];detailCache.clear();polls.clear();el.app.hidden=true;el.auth.hidden=false;}

  async function loadData() {
    const [mr,tr]=await Promise.all([
      sb.from('meetings').select(LIST_FIELDS).order('meeting_date',{ascending:false}).order('created_at',{ascending:false}).limit(300),
      sb.from('tasks').select(TASK_FIELDS).order('created_at',{ascending:false}).limit(3000)
    ]);
    if(mr.error||tr.error){toast('Не вдалося завантажити дані.');return;}
    meetings=mr.data||[];tasks=tr.data||[];updateBadge();
  }

  async function repairInterrupted(){
    const cutoff=Date.now()-30*60*1000;
    for(const m of meetings.filter(x=>x.status==='uploading'&&new Date(x.updated_at||x.created_at).getTime()<cutoff)){
      const msg='Завантаження було перервано. Видали цей запис і завантаж файл ще раз.';
      await sb.from('meetings').update({status:'error',processing_stage:'interrupted',error_message:msg}).eq('id',m.id);
      Object.assign(m,{status:'error',processing_stage:'interrupted',error_message:msg});
    }
  }

  function navigate(to,id=null){
    view=to;if(id)currentMeetingId=id;
    el.overview.hidden=to!=='overview';el.meetings.hidden=to!=='meetings';el.meeting.hidden=to!=='meeting';el.tasks.hidden=to!=='tasks';
    $$('.nav-item').forEach(b=>b.classList.toggle('active',b.dataset.view===(to==='meeting'?'meetings':to)));
    $('.sidebar').classList.remove('open');
    if(to==='overview')renderOverview();if(to==='meetings')renderMeetings();if(to==='tasks')renderTasks();if(to==='meeting')renderMeeting(id);
    scrollTo({top:0,behavior:'smooth'});
  }

  function renderOverview(){
    const ready=meetings.filter(m=>m.status==='ready'), processing=meetings.filter(m=>['uploading','preparing','queued','analyzing'].includes(m.status));
    const openTasks=tasks.filter(t=>t.status!=='done'), doneTasks=tasks.filter(t=>t.status==='done';
    const recent=meetings.slice(0,5), urgent=openTasks.slice(0,6);
    el.overview.innerHTML=`
      <section class="hero"><div class="hero-copy"><div class="eyebrow">РОБОЧИЙ ПРОСТІР ЮРЧАК</div><h1>Усі рішення після дзвінка — в одному місці</h1><p>Завантаж запис Zoom, а сервіс збере транскрипцію, теми, рішення та конкретні завдання для команди.</p></div><div class="hero-actions"><button class="btn btn-primary" data-upload>＋ Додати запис</button><button class="btn btn-secondary" data-go="meetings">Усі дзвінки</button></div></section>
      <div class="stats-grid">
        ${stat('Дзвінків',meetings.length,`${ready.length} готово`)}
        ${stat('В обробці',processing.length,processing.length?'можна закрити вкладку':'черги немає')}
        ${stat('Відкритих задач',openTasks.length,`${doneTasks.length} виконано`)}
        ${stat('Останній дзвінок',meetings[0]?shortDate(meetings[0].meeting_date):'—',meetings[0]?meetings[0].title:'ще немає')}
      </div>
      <div class="overview-grid">
        <section class="panel"><div class="panel-head"><h2>Останні дзвінки</h2><button data-go="meetings">Дивитися всі →</button></div><div class="meeting-list">${recent.length?recent.map(meetingRow).join(''):'<div class="empty"><strong>Поки порожньо</strong>Завантаж перший запис дзвінка.</div>'}</div></section>
        <section class="panel"><div class="panel-head"><h2>Актуальні завдання</h2><button data-go="tasks">Усі завдання →</button></div><div class="task-list">${urgent.length?urgent.map(taskCompact).join(''):'<div class="empty"><strong>Немає відкритих задач</strong></div>'}</div></section>
      </div>`;
    $$('[data-upload]',el.overview).forEach(b=>b.onclick=openModal);$$('[data-go]',el.overview).forEach(b=>b.onclick=()=>navigate(b.dataset.go));bindMeetingOpen(el.overview);bindStatus(el.overview);
  }
  function stat(label,value,small){return`<article class="stat-card"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(small)}</small></article>`;}

  function renderMeetings(query=''){
    const q=query.trim().toLowerCase();
    const filtered=meetings.filter(m=>(meetingFilter==='all'||(meetingFilter==='processing'?['uploading','preparing','queued','analyzing'].includes(m.status):m.status===meetingFilter))&&(!q||meetingSearchText(m).includes(q)));
    el.meetings.innerHTML=`<div class="page-head"><div><div class="eyebrow">АРХІВ</div><h1>Дзвінки</h1><p>Готові розбори та записи, які ще обробляються.</p></div><button class="btn btn-primary" data-upload>＋ Завантажити запис</button></div>
      <div class="toolbar"><div class="toolbar-left"><button class="filter ${meetingFilter==='all'?'active':''}" data-mf="all">Усі</button><button class="filter ${meetingFilter==='ready'?'active':''}" data-mf="ready">Готові</button><button class="filter ${meetingFilter==='processing'?'active':''}" data-mf="processing">В обробці</button><button class="filter ${meetingFilter==='error'?'active':''}" data-mf="error">Помилки</button></div><input id="meetingSearch" class="search" placeholder="Пошук за темами та рішеннями" value="${esc(query)}"></div>
      <div class="meeting-list">${filtered.length?filtered.map(meetingRow).join(''):`<div class="empty"><strong>Нічого не знайдено</strong>Зміни фільтр або пошуковий запит.</div>`}</div>`;
    $('[data-upload]',el.meetings).onclick=openModal;$$('[data-mf]',el.meetings).forEach(b=>b.onclick=()=>{meetingFilter=b.dataset.mf;renderMeetings($('#meetingSearch')?.value||'')});$('#meetingSearch').oninput=e=>renderMeetings(e.target.value);bindMeetingOpen(el.meetings);
  }

  function meetingRow(m){
    const d=dateParts(m.meeting_date), ready=m.status==='ready', open=tasks.filter(t=>t.meeting_id===m.id&&t.status!=='done').length;
    return`<article class="meeting-row"><div class="date-box"><strong>${d.day}</strong><span>${d.month}</span></div><div><h3>${esc(m.title)}</h3><div class="meta"><span>${formatDate(m.meeting_date)}</span>${m.duration?`<span>${esc(m.duration)}</span>`:''}${ready?`<span>${(m.topics||[]).length} тем</span><span>${open} задач</span>`:statusPill(m)}</div></div>${ready?`<button class="btn btn-secondary" data-open="${m.id}">Відкрити</button>`:m.status==='error'?`<button class="btn btn-secondary" data-open="${m.id}">Деталі</button>`:progressBox(m)}</article>`;
  }
  function bindMeetingOpen(root){$$('[data-open]',root).forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.open));}
  function statusPill(m){const meta=statusMeta(m);return`<span class="pill ${meta.cls}"><span class="dot"></span>${esc(meta.text)}</span>`;}
  function progressBox(m){const lp=localProgress.get(m.id),p=Math.max(3,Math.min(99,lp?.pct??Number(m.progress||5))),txt=lp?.text||stageText(m);return`<div class="progress-box"><div class="progress-label"><span>${esc(txt)}</span><b>${Math.round(p)}%</b></div><div class="progress-track"><div class="progress-fill" style="width:${p}%"></div></div></div>`;}
  function statusMeta(m){if(m.status==='ready')return{cls:'ready',text:'Готово'};if(m.status==='error')return{cls:'error',text:'Помилка'};if(m.status==='queued')return{cls:'warn',text:'У черзі'};return{cls:'processing',text:stageText(m)};}
  function stageText(m){const p=localProgress.get(m.id);if(p?.text)return p.text;return({extracting_audio:'Дістаємо звук',uploading_audio:'Завантажуємо аудіо',gemini_preparing:'Готуємо аудіо',queued:'Очікуємо ліміт',rate_limited:'Очікуємо ліміт Gemini',transcribing:'Транскрибуємо й аналізуємо',merging:'Збираємо підсумок',interrupted:'Завантаження перервано',uploading:'Підготовка',preparing:'Підготовка аудіо',analyzing:'ШІ аналізує'})[m.processing_stage||m.status]||'Обробка';}

  async function renderMeeting(id){
    const m=meetings.find(x=>x.id===id);if(!m)return navigate('meetings');const mtasks=tasks.filter(t=>t.meeting_id===id);
    if(m.status!=='ready'){
      el.meeting.innerHTML=`<button class="back" data-back>← До дзвінків</button><div class="detail-head"><div><div class="eyebrow">${formatDate(m.meeting_date)}</div><h1>${esc(m.title)}</h1>${statusPill(m)}</div></div><section class="card"><h2>${m.status==='error'?'Не вдалося обробити запис':'Запис обробляється'}</h2><p style="color:var(--muted);font-size:11px;line-height:1.6">${m.status==='error'?esc(m.error_message||'Невідома помилка.'):'Можна закрити вкладку. Коли аналіз завершиться, результат залишиться тут.'}</p>${m.status!=='error'?progressBox(m):''}<div style="margin-top:15px;display:flex;gap:8px"><button class="btn btn-danger" data-delete>Видалити</button>${m.status==='error'?'<button class="btn btn-primary" data-new>Завантажити запис заново</button>':''}</div></section>`;
      $('[data-back]',el.meeting).onclick=()=>navigate('meetings');$('[data-delete]',el.meeting).onclick=()=>deleteMeeting(id);if($('[data-new]',el.meeting))$('[data-new]',el.meeting).onclick=openModal;return;
    }
    const details=await getDetails(id);if(!details)return;
    const decisions=(details.topics||[]).reduce((a,t)=>a+(t.decisions||[]).length,0);
    el.meeting.innerHTML=`<button class="back" data-back>← До дзвінків</button><div class="detail-head"><div><div class="eyebrow">${formatDate(m.meeting_date)}</div><h1>${esc(m.title)}</h1><div class="meta"><span class="pill ready"><span class="dot"></span>Готово</span>${m.completed_at?`<span>оброблено ${formatDateTime(m.completed_at)}</span>`:''}</div></div><div class="detail-actions"><button class="btn btn-danger" data-delete>Видалити</button></div></div>
      <div class="detail-stats">${detailStat('Тривалість',m.duration||'—')}${detailStat('Тем',String((details.topics||[]).length))}${detailStat('Рішень',String(decisions))}${detailStat('Завдань',String(mtasks.length))}</div>
      <div class="detail-grid"><div>
        <section class="card"><div class="eyebrow">КОРОТКО</div><h2>Що важливо</h2><ul class="summary-list">${(details.summary||[]).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>Короткий підсумок не сформовано.</li>'}</ul></section>
        <section class="card"><h2>Обговорення за темами</h2>${(details.topics||[]).map(topicHtml).join('')||'<p>Тем не визначено.</p>'}</section>
        <section class="card"><details id="transcriptDetails"><summary class="transcript-summary">Показати повну транскрипцію</summary><div id="transcriptBox" class="transcript"></div></details></section>
      </div><aside class="card sticky"><div class="panel-head"><h2>Завдання</h2><span class="pill processing">${mtasks.filter(t=>t.status!=='done').length} відкрито</span></div>${mtasks.length?mtasks.map(taskCompact).join(''):'<div class="empty"><strong>Завдань немає</strong></div>'}</aside></div>`;
    $('[data-back]',el.meeting).onclick=()=>navigate('meetings');$('[data-delete]',el.meeting).onclick=()=>deleteMeeting(id);bindStatus(el.meeting);$('#transcriptDetails').addEventListener('toggle',e=>{if(e.currentTarget.open)renderTranscript(details.transcript||[])},{once:true});
  }
  function detailStat(label,value){return`<div class="detail-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong></div>`;}
  function topicHtml(t){return`<div class="topic"><div class="topic-head"><h3>${esc(t.title||'Тема')}</h3><span class="topic-time">${esc(t.start||'')}${t.end?` — ${esc(t.end)}`:''}</span></div>${(t.summary||[]).length?`<ul>${t.summary.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${(t.decisions||[]).map(x=>`<div class="decision"><strong>Рішення:</strong> ${esc(x)}</div>`).join('')}</div>`;}
  async function getDetails(id){if(detailCache.has(id))return detailCache.get(id);el.meeting.innerHTML='<div class="empty"><strong>Відкриваємо дзвінок…</strong></div>';const{data,error}=await sb.from('meetings').select('id,summary,topics,transcript').eq('id',id).single();if(error){toast('Не вдалося відкрити дзвінок.');return null;}detailCache.set(id,data);return data;}
  function renderTranscript(lines){const box=$('#transcriptBox');box.innerHTML=lines.length?lines.map(x=>`<div class="transcript-line"><time>${esc(x.timestamp||'')}</time><strong>${esc(x.speaker||'Учасник')}</strong><p>${esc(x.text||'')}</p></div>`).join(''):'<div class="empty">Транскрипція порожня.</div>';}

  function renderTasks(){
    const shown=tasks.filter(t=>taskFilter==='all'||(taskFilter==='open'?t.status!=='done':t.status==='done'));
    el.tasks.innerHTML=`<div class="page-head"><div><div class="eyebrow">ACTION ITEMS</div><h1>Завдання</h1><p>Усе, що команда має зробити після дзвінків.</p></div></div><div class="toolbar"><div class="filters"><button class="filter ${taskFilter==='open'?'active':''}" data-tf="open">Відкриті</button><button class="filter ${taskFilter==='done'?'active':''}" data-tf="done">Виконані</button><button class="filter ${taskFilter==='all'?'active':''}" data-tf="all">Усі</button></div></div><div class="task-list">${shown.length?shown.map(taskRow).join(''):'<div class="empty"><strong>Завдань немає</strong></div>'}</div>`;
    $$('[data-tf]',el.tasks).forEach(b=>b.onclick=()=>{taskFilter=b.dataset.tf;renderTasks()});bindStatus(el.tasks);$$('[data-source]',el.tasks).forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.source));
  }
  function taskCompact(t){const m=meetings.find(x=>x.id===t.meeting_id);return`<div class="task-card"><strong>${esc(t.text)}</strong><div class="meta"><span>${esc(t.assignee||'Без виконавця')}</span>${t.deadline?`<span>до ${formatDate(t.deadline)}</span>`:''}${t.source_timestamp?`<span>${esc(t.source_timestamp)}</span>`:''}</div>${t.source_excerpt?`<p class="source-excerpt">«${esc(t.source_excerpt)}»</p>`:''}${statusSelect(t)}${m?`<button class="task-source" data-source="${m.id}">${esc(m.title)}</button>`:''}</div>`;}
  function taskRow(t){const m=meetings.find(x=>x.id===t.meeting_id);return`<article class="task-row"><div><strong>${esc(t.text)}</strong>${m?`<button class="task-source" data-source="${m.id}">${esc(m.title)}${t.source_timestamp?` · ${esc(t.source_timestamp)}`:''}</button>`:''}${t.source_excerpt?`<p class="source-excerpt">«${esc(t.source_excerpt)}»</p>`:''}</div><div>${esc(t.assignee||'Без виконавця')}${t.deadline?`<div class="meta">до ${formatDate(t.deadline)}</div>`:''}</div>${statusSelect(t)}</article>`;}
  function statusSelect(t){return`<select class="status-select" data-status="${t.id}"><option value="todo" ${t.status==='todo'?'selected':''}>Нове</option><option value="doing" ${t.status==='doing'?'selected':''}>У роботі</option><option value="done" ${t.status==='done'?'selected':''}>Готово</option></select>`;}
  function bindStatus(root){$$('[data-status]',root).forEach(s=>s.onchange=async()=>{const old=tasks.find(t=>t.id===s.dataset.status)?.status;const{error}=await sb.from('tasks').update({status:s.value}).eq('id',s.dataset.status);if(error){s.value=old||'todo';return toast('Не вдалося змінити статус.');}const t=tasks.find(x=>x.id===s.dataset.status);if(t)t.status=s.value;updateBadge();if(view==='tasks')renderTasks();});$$('[data-source]',root).forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.source));}
  function updateBadge(){const n=tasks.filter(t=>t.status!=='done').length;el.badge.textContent=n;el.badge.hidden=!n;}

  function openModal(){el.form.reset();const now=new Date();el.form.elements.meetingDate.value=localDate(now);el.form.elements.title.value=`Дзвінок ${now.toLocaleDateString('uk-UA',{day:'numeric',month:'long'})}`;showFile(null);el.modal.hidden=false;}
  function closeModal(){el.modal.hidden=true;}
  function showFile(f){$('#fileDropTitle').textContent=f?f.name:'Обрати відео або аудіо';$('#fileDropText').textContent=f?`${prettyBytes(f.size)} · ${f.type||'медіа'}`:'MP4, MOV, WEBM, M4A, MP3, WAV · до 2 ГБ';}

  async function uploadMeeting(e){
    e.preventDefault();const file=el.file.files?.[0];if(!file)return toast('Обери файл запису.');if(file.size>MAX_FILE)return toast('Файл більший за 2 ГБ.');
    const btn=$('#uploadSubmit');btn.disabled=true;let meeting=null;
    try{
      const fd=new FormData(e.currentTarget),mime=normalizeInputMime(file.type||mimeFromName(file.name));
      btn.textContent='Перевіряємо запис…';
      const{data,error}=await sb.from('meetings').insert({title:String(fd.get('title')).trim(),meeting_date:fd.get('meetingDate'),status:'uploading',processing_stage:'extracting_audio',progress:3,original_filename:file.name,file_mime_type:mime,created_by:user.id}).select(LIST_FIELDS).single();
      if(error)throw error;meeting=data;meetings.unshift(meeting);closeModal();navigate('meetings');
      const media=await prepareMedia(file,meeting.id,btn);
      await patchServer(meeting.id,{media_duration_seconds:Math.round(media.duration),processed_size_bytes:media.parts.reduce((a,p)=>a+p.blob.size,0),processing_stage:'uploading_audio',progress:25});
      const uploaded=[];let doneBytes=0,total=media.parts.reduce((a,p)=>a+p.blob.size,0);
      for(let i=0;i<media.parts.length;i++){
        const p=media.parts[i];btn.textContent=`Завантажуємо аудіо ${i+1}/${media.parts.length}…`;
        const f=await uploadPart(p,loaded=>setProgress(meeting.id,25+35*((doneBytes+loaded)/Math.max(1,total)),`Завантажуємо аудіо ${i+1}/${media.parts.length}`));doneBytes+=p.blob.size;
        uploaded.push({name:f.name,uri:f.uri,mime_type:f.mimeType||p.mimeType,start_seconds:p.start,end_seconds:p.end,size_bytes:p.blob.size});
      }
      localProgress.delete(meeting.id);
      await pipeline('register_files',{meetingId:meeting.id,files:uploaded,durationSeconds:media.duration});
      patch(meeting.id,{status:'preparing',processing_stage:'gemini_preparing',progress:62});renderMeetings();processMeeting(meeting.id);toast('Запис прийнято. Починаємо аналіз.');
    }catch(err){console.error(err);if(meeting)await markError(meeting.id,friendlyError(err));toast(friendlyError(err));}
    finally{btn.disabled=false;btn.textContent='Завантажити та проаналізувати';}
  }

  async function prepareMedia(file,id,btn){
    const mime=normalizeInputMime(file.type||mimeFromName(file.name));
    if(mime.startsWith('audio/')&&!['audio/m4a','audio/mp4'].includes(mime)){
      const duration=await browserDuration(file).catch(()=>estimateDuration(file));
      if(duration<=CHUNK_SECONDS)return{duration,parts:[{blob:file,name:file.name,mimeType:mime,start:0,end:duration}],audioOnly:true};
    }
    const M=await mediaLib();const info=await inspectMedia(M,file);if(!info.audio)throw new Error('У файлі немає аудіодоріжки.');
    return await extractAudio(M,file,info.duration,id,btn);
  }
  async function mediaLib(){if(!mediaLibPromise)mediaLibPromise=import('https://cdn.jsdelivr.net/npm/mediabunny@1.55.1/+esm');return mediaLibPromise;}
  async function inspectMedia(M,file){const input=new M.Input({formats:M.ALL_FORMATS,source:new M.BlobSource(file)});if(!(await input.canRead()))throw new Error('Браузер не може прочитати цей формат запису.');const audio=await input.getPrimaryAudioTrack();let duration=await input.getDurationFromMetadata();if(!duration||!Number.isFinite(duration))duration=await input.computeDuration();return{audio:!!audio,duration:Number(duration||0)};}
  async function extractAudio(M,file,duration,id,btn){
    const count=Math.max(1,Math.ceil(duration/CHUNK_SECONDS)),parts=[];
    for(let i=0;i<count;i++){
      const start=i*CHUNK_SECONDS,end=Math.min(duration,(i+1)*CHUNK_SECONDS);btn.textContent=`Дістаємо аудіо ${i+1}/${count}…`;
      setProgress(id,5+18*(i/count),`Дістаємо аудіо ${i+1}/${count}`);
      let out;
      try{out=await convertChunk(M,file,start,end,p=>setProgress(id,5+18*((i+p)/count),`Дістаємо аудіо ${i+1}/${count}`),'aac');}
      catch(e){console.warn('AAC conversion failed',e);out=await convertChunk(M,file,start,end,p=>setProgress(id,5+18*((i+p)/count),`Оптимізуємо аудіо ${i+1}/${count}`),'wav');}
      parts.push({blob:out.blob,name:`${baseName(file.name)}-${i+1}.${out.ext}`,mimeType:out.mime,start,end});
    }
    return{duration,parts,audioOnly:true};
  }
  async function convertChunk(M,file,start,end,onProgress,kind){
    const input=new M.Input({formats:M.ALL_FORMATS,source:new M.BlobSource(file)}),target=new M.BufferTarget();
    const format=kind==='aac'?new M.AdtsOutputFormat():new M.WavOutputFormat();
    const output=new M.Output({format,target});
    const audio=kind==='aac'?{codec:'aac',numberOfChannels:1,sampleRate:16000}:{sampleRate:16000,numberOfChannels:1};
    const conversion=await M.Conversion.init({input,output,tracks:'primary',video:{discard:true},audio,trim:{start,end},showWarnings:false});
    if(!conversion.isValid)throw new Error('Не вдалося перетворити аудіодоріжку.');conversion.onProgress=p=>onProgress(Number(p||0));await conversion.execute();
    if(!target.buffer)throw new Error('Не вдалося створити аудіофайл.');return{blob:new Blob([target.buffer],{type:kind==='aac'?'audio/aac':'audio/wav'}),mime:kind==='aac'?'audio/aac':'audio/wav',ext:kind==='aac'?'aac':'wav'};
  }

  async function uploadPart(part,onProgress){let last;for(let a=1;a<=3;a++){try{const session=await pipeline('create_upload',{fileName:part.name,fileSize:part.blob.size,mimeType:part.mimeType});const f=await xhrUpload(session.uploadUrl,part.blob,session.mimeType||part.mimeType,onProgress);return{...f,mimeType:session.mimeType||part.mimeType};}catch(e){last=e;if(a<3)await sleep(1200*Math.pow(2,a-1));}}throw last||new Error('Не вдалося завантажити аудіо.');}
  function xhrUpload(url,blob,mime,onProgress){return new Promise((resolve,reject)=>{const x=new XMLHttpRequest();x.open('POST',url);x.timeout=15*60*1000;x.setRequestHeader('X-Goog-Upload-Offset','0');x.setRequestHeader('X-Goog-Upload-Command','upload, finalize');x.setRequestHeader('Content-Type',mime);x.upload.onprogress=e=>{if(e.lengthComputable)onProgress(e.loaded)};x.onerror=()=>reject(new Error('З’єднання обірвалося під час завантаження аудіо.'));x.ontimeout=()=>reject(new Error('Завантаження аудіо перевищило час очікування.'));x.onload=()=>{if(x.status<200||x.status>=300)return reject(new Error(`Gemini відхилив аудіофайл: HTTP ${x.status}`));try{const f=JSON.parse(x.responseText).file;if(!f?.name||!f?.uri)throw 0;resolve(f)}catch{reject(new Error('Gemini не повернув дані завантаженого файлу.'))}};x.send(blob);});}

  async function processMeeting(id){if(polls.has(id))return;polls.add(id);try{let failures=0;for(let cycle=0;cycle<720;cycle++){
    let m=meetings.find(x=>x.id===id);if(!m)return;
    try{
      if(m.status==='preparing'){
        const f=await pipeline('files_status',{meetingId:id});failures=0;if(f.state==='FAILED')throw new Fatal(f.error||'Gemini не зміг підготувати аудіо.');if(f.state!=='ACTIVE'){patch(id,{processing_stage:'gemini_preparing',progress:62});await sleep(8000);continue;}patch(id,{status:'queued',processing_stage:'queued',progress:68});
      }
      m=meetings.find(x=>x.id===id);
      if(m.status==='queued'||m.status==='preparing'){
        const s=await pipeline('start_analysis',{meetingId:id});failures=0;if(s.status==='queued'){patch(id,{status:'queued',processing_stage:'rate_limited',progress:70});await sleep((s.retryAfter||70)*1000);continue;}patch(id,{status:'analyzing',processing_stage:'transcribing',progress:74});
      }
      const r=await pipeline('analysis_status',{meetingId:id});failures=0;
      if(r.status==='completed'){await loadData();detailCache.delete(id);toast('Аналіз готовий ✓');if(view==='overview')renderOverview();if(view==='meetings')renderMeetings();if(view==='meeting'&&currentMeetingId===id)renderMeeting(id);return;}
      if(r.status==='failed')throw new Fatal(r.error||'Gemini не зміг завершити аналіз.');
      patch(id,{status:r.status==='queued'?'queued':'analyzing',processing_stage:r.status==='queued'?'rate_limited':'transcribing',progress:r.progress||meetings.find(x=>x.id===id)?.progress||74});renderActiveView();await sleep((r.retryAfter||10)*1000);
    }catch(e){if(e instanceof Fatal)throw e;failures++;console.warn(e);if(failures>=7){toast('Зв’язок нестабільний. Сервіс продовжить перевірку при наступному відкритті.');return;}await sleep(Math.min(45000,2500*Math.pow(2,Math.min(failures,4))));}
  }}catch(e){await markError(id,friendlyError(e));toast(friendlyError(e));}finally{polls.delete(id);}}
  class Fatal extends Error{}
  function resumePending(){if(!navigator.onLine)return;meetings.filter(m=>['preparing','queued','analyzing'].includes(m.status)).forEach(m=>processMeeting(m.id));}
  function renderActiveView(){if(view==='overview')renderOverview();if(view==='meetings')renderMeetings($('#meetingSearch')?.value||'');if(view==='meeting')renderMeeting(currentMeetingId);}
  async function pipeline(action,payload={}){const{data,error}=await sb.functions.invoke('video-pipeline',{body:{action,...payload}});if(error)throw new Error(error.message||'Помилка серверної функції.');if(!data?.ok)throw new Error(data?.error||'Не вдалося виконати дію.');return data;}

  async function deleteMeeting(id){if(!confirm('Видалити дзвінок, транскрипцію та всі його завдання?'))return;await pipeline('cancel',{meetingId:id}).catch(()=>{});const{error}=await sb.from('meetings').delete().eq('id',id);if(error)return toast('Не вдалося видалити дзвінок.');meetings=meetings.filter(m=>m.id!==id);tasks=tasks.filter(t=>t.meeting_id!==id);detailCache.delete(id);localProgress.delete(id);updateBadge();navigate('meetings');}
  async function markError(id,msg){await sb.from('meetings').update({status:'error',processing_stage:'error',error_message:msg,progress:0}).eq('id',id);patch(id,{status:'error',processing_stage:'error',error_message:msg,progress:0});renderActiveView();}
  async function patchServer(id,p){const{error}=await sb.from('meetings').update(p).eq('id',id);if(error)throw error;patch(id,p);}
  function patch(id,p){const m=meetings.find(x=>x.id===id);if(m)Object.assign(m,p);}
  function setProgress(id,pct,text){localProgress.set(id,{pct,text});patch(id,{progress:Math.round(pct)});if(view==='meetings')renderMeetings($('#meetingSearch')?.value||'');if(view==='overview')renderOverview();}

  function authError(msg){const e=$('#authError');e.textContent=msg;e.hidden=!msg;}
  function authMessage(msg){if(/invalid login/i.test(msg))return'Неправильний email або пароль.';if(/email not confirmed/i.test(msg))return'Email ще не підтверджено.';if(/already registered/i.test(msg))return'Цей email уже зареєстрований.';return msg;}
  function friendlyError(e){const m=e?.message||String(e);if(/non-2xx/i.test(m))return'Сервер обробки повернув помилку. Онови сторінку та спробуй ще раз.';if(/Failed to fetch|NetworkError|Load failed/i.test(m))return'Немає зв’язку із сервером. Перевір інтернет.';return m;}
  function meetingSearchText(m){return[m.title,...(m.summary||[]),...(m.topics||[]).flatMap(t=>[t.title,...(t.summary||[]),...(t.decisions||[])])].join(' ').toLowerCase();}
  function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
  function formatDate(v){if(!v)return'';return new Date(`${v}T12:00:00`).toLocaleDateString('uk-UA',{day:'numeric',month:'short',year:'numeric'});}
  function shortDate(v){if(!v)return'—';return new Date(`${v}T12:00:00`).toLocaleDateString('uk-UA',{day:'numeric',month:'short'});}
  function formatDateTime(v){if(!v)return'';return new Date(v).toLocaleString('uk-UA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'});}
  function dateParts(v){const d=new Date(`${v}T12:00:00`);return{day:String(d.getDate()).padStart(2,'0'),month:d.toLocaleDateString('uk-UA',{month:'short'}).replace('.','')};}
  function localDate(d){return`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
  function prettyBytes(n){const u=['Б','КБ','МБ','ГБ'];let i=0,x=Number(n||0);while(x>=1024&&i<u.length-1){x/=1024;i++;}return`${x.toFixed(i>1?1:0)} ${u[i]}`;}
  function baseName(n){return n.replace(/\.[^.]+$/,'').replace(/[^a-zA-Z0-9а-яА-ЯіІїЇєЄ_-]+/g,'-').slice(0,70)||'audio';}
  function normalizeInputMime(v){const m=String(v||'').toLowerCase().split(';')[0];return({'video/quicktime':'video/mov','audio/x-m4a':'audio/m4a','audio/mp4':'audio/m4a'}[m]||m||'video/mp4');}
  function mimeFromName(n){const x=n.toLowerCase();if(x.endsWith('.m4a'))return'audio/m4a';if(x.endsWith('.mp3'))return'audio/mpeg';if(x.endsWith('.wav'))return'audio/wav';if(x.endsWith('.mov'))return'video/quicktime';if(x.endsWith('.webm'))return'video/webm';return'video/mp4';}
  function browserDuration(file){return new Promise((res,rej)=>{const tag=document.createElement(file.type.startsWith('audio/')?'audio':'video'),url=URL.createObjectURL(file);tag.preload='metadata';tag.onloadedmetadata=()=>{const d=tag.duration;URL.revokeObjectURL(url);Number.isFinite(d)?res(d):rej(new Error('Немає тривалості'));};tag.onerror=()=>{URL.revokeObjectURL(url);rej(new Error('Формат не читається'));};tag.src=url;});}
  function estimateDuration(file){return Math.max(1,Math.round(file.size*8/128000));}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms));}
  let toastTimer;function toast(msg){clearTimeout(toastTimer);el.toast.textContent=msg;el.toast.hidden=false;toastTimer=setTimeout(()=>el.toast.hidden=true,6500);}
})();
