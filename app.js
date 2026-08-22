(() => {
  const cfg = window.YURCHAK_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabasePublishableKey);
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const auth = $('#auth'), shell = $('#shell'), main = $('#main'), toastEl = $('#toast');
  let user = null, meetings = [], tasks = [], view = 'meetings', currentMeeting = null, pollers = new Set();

  init();

  async function init(){
    bindStatic();
    const { data } = await sb.auth.getSession();
    if(data.session) await enter(data.session.user); else showAuth();
    sb.auth.onAuthStateChange(async (_event, session) => {
      if(session?.user && !user) await enter(session.user);
      if(!session && user){ user=null; showAuth(); }
    });
  }

  function bindStatic(){
    $('#authForm').addEventListener('submit', signIn);
    $('#signup').addEventListener('click', signUp);
    $('#logout').addEventListener('click', () => sb.auth.signOut());
    $('#closeModal').addEventListener('click', closeModal);
    $('#modal').addEventListener('click', e => { if(e.target.id === 'modal') closeModal(); });
    $('#video').addEventListener('change', e => showFile(e.target.files?.[0]));
    $('#uploadForm').addEventListener('submit', uploadMeeting);
    $$('[data-view]').forEach(b => b.addEventListener('click', () => navigate(b.dataset.view)));
  }

  function showAuth(){ auth.hidden=false; shell.hidden=true; }
  async function enter(u){
    user=u; auth.hidden=true; shell.hidden=false; $('#userEmail').textContent=u.email || '';
    await loadData(); navigate('meetings'); resumePending();
  }

  async function signIn(e){
    e.preventDefault(); setAuthError('');
    const email=$('#email').value.trim(), password=$('#password').value;
    const { error }=await sb.auth.signInWithPassword({email,password});
    if(error) setAuthError(localError(error.message));
  }
  async function signUp(){
    setAuthError('');
    const email=$('#email').value.trim(), password=$('#password').value;
    if(!email || password.length<6) return setAuthError('Введи email и пароль минимум из 6 символов.');
    const { data, error }=await sb.auth.signUp({email,password});
    if(error) return setAuthError(localError(error.message));
    if(data.session) return;
    setAuthError('Аккаунт создан. Проверь почту и подтверди email, затем войди.');
  }
  function setAuthError(msg){ const el=$('#authError'); el.textContent=msg; el.hidden=!msg; }

  async function loadData(){
    const [m,t]=await Promise.all([
      sb.from('meetings').select('*').order('meeting_date',{ascending:false}).order('created_at',{ascending:false}),
      sb.from('tasks').select('*').order('created_at',{ascending:false})
    ]);
    if(m.error) toast('Не удалось загрузить созвоны'); else meetings=m.data||[];
    if(t.error) toast('Не удалось загрузить задачи'); else tasks=t.data||[];
    updateBadge();
  }

  function navigate(to,id=null){
    view=to; currentMeeting=id;
    $$('[data-view]').forEach(b=>b.classList.toggle('active',b.dataset.view===to));
    if(to==='meetings') renderMeetings();
    if(to==='tasks') renderTasks();
    if(to==='meeting') renderMeeting(id);
    scrollTo({top:0,behavior:'smooth'});
  }

  function renderMeetings(query=''){
    const q=query.toLowerCase().trim();
    const filtered=meetings.filter(m=>!q || `${m.title} ${JSON.stringify(m.summary||[])} ${JSON.stringify(m.topics||[])}`.toLowerCase().includes(q));
    main.innerHTML=`
      <div class="page-head"><div><div class="eyebrow">ЮРЧАК</div><h1>Созвоны</h1><p>Запись → транскрипция → итоги → задачи.</p></div><button id="newMeeting" class="primary">+ Загрузить запись</button></div>
      <section class="upload-card"><div><div class="eyebrow">БЫСТРЫЙ СТАРТ</div><h2>Добавь видео созвона</h2><p>Сервис сам расшифрует разговор, разделит его по темам и соберёт задачи. Видео после обработки не хранится.</p></div><button id="uploadHero" class="primary">Выбрать видео</button></section>
      <div class="toolbar"><h2>Все созвоны</h2><input id="search" class="search" placeholder="Поиск по созвонам" value="${esc(query)}"></div>
      <div class="list">${filtered.length?filtered.map(meetingCard).join(''):`<div class="empty"><strong>Пока нет созвонов</strong>Загрузи первую запись — она появится здесь.</div>`}</div>`;
    $('#newMeeting').onclick=openModal; $('#uploadHero').onclick=openModal;
    $('#search').oninput=e=>renderMeetings(e.target.value);
    $$('[data-open-meeting]').forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.openMeeting));
  }

  function meetingCard(m){
    const d=dateParts(m.meeting_date); const status=statusMeta(m.status);
    return `<article class="meeting"><div class="date"><strong>${d.day}</strong><small>${d.month}</small></div><div><h3>${esc(m.title)}</h3><div class="meta"><span class="pill ${status.cls}">${status.text}</span>${m.duration?`<span>${esc(m.duration)}</span>`:''}${m.status==='error'&&m.error_message?`<span>${esc(m.error_message.slice(0,80))}</span>`:''}</div></div><button class="secondary" data-open-meeting="${m.id}">${m.status==='ready'?'Открыть':'Подробнее'}</button></article>`;
  }

  function renderMeeting(id){
    const m=meetings.find(x=>x.id===id); if(!m) return navigate('meetings');
    const mtasks=tasks.filter(t=>t.meeting_id===id); const status=statusMeta(m.status);
    if(m.status!=='ready'){
      main.innerHTML=`<button class="back" id="back">← Ко всем созвонам</button><div class="detail-head"><div><div class="eyebrow">${formatDate(m.meeting_date)}</div><h1>${esc(m.title)}</h1><span class="pill ${status.cls}">${status.text}</span></div></div><div class="card"><h2>${m.status==='error'?'Не удалось обработать запись':'Запись обрабатывается'}</h2><p style="color:var(--muted);font-size:12px;line-height:1.6">${m.status==='error'?esc(m.error_message||'Попробуй загрузить запись ещё раз.'):'Можно закрыть страницу. Когда обработка закончится, результат сохранится в этом созвоне.'}</p>${m.status==='error'?`<button class="secondary" id="deleteMeeting">Удалить созвон</button>`:''}</div>`;
      $('#back').onclick=()=>navigate('meetings'); if($('#deleteMeeting')) $('#deleteMeeting').onclick=()=>deleteMeeting(id); return;
    }
    main.innerHTML=`
      <button class="back" id="back">← Ко всем созвонам</button>
      <div class="detail-head"><div><div class="eyebrow">${formatDate(m.meeting_date)}</div><h1>${esc(m.title)}</h1><div class="meta">${m.duration?`<span>${esc(m.duration)}</span>`:''}<span class="pill ready">Готово</span></div></div><button id="deleteMeeting" class="secondary">Удалить</button></div>
      <div class="grid"><div>
        <section class="card"><h2>Коротко</h2><ul class="summary">${(m.summary||[]).map(x=>`<li>${esc(x)}</li>`).join('')||'<li>Итог не сформирован.</li>'}</ul></section>
        <section class="card"><h2>Обсуждение по темам</h2>${(m.topics||[]).map(topicHtml).join('')||'<p style="font-size:12px;color:var(--muted)">Темы не определены.</p>'}</section>
        <section class="card"><h2>Транскрипция</h2><div class="transcript">${(m.transcript||[]).map(x=>`<div class="line"><span class="time">${esc(x.timestamp)}</span><span class="speaker">${esc(x.speaker)}</span><span class="speech">${esc(x.text)}</span></div>`).join('')||'<p style="font-size:12px;color:var(--muted)">Транскрипция пуста.</p>'}</div></section>
      </div><aside class="card"><h2>Задачи</h2><div class="tasks">${mtasks.length?mtasks.map(taskMini).join(''):'<div class="empty" style="padding:25px 12px">Задач нет</div>'}</div></aside></div>`;
    $('#back').onclick=()=>navigate('meetings'); $('#deleteMeeting').onclick=()=>deleteMeeting(id); bindStatuses();
  }

  function topicHtml(t){
    return `<div class="topic"><div class="topic-head"><h3>${esc(t.title||'Тема')}</h3><span class="time">${esc(t.start||'')} ${t.end?`– ${esc(t.end)}`:''}</span></div>${Array.isArray(t.summary)&&t.summary.length?`<ul>${t.summary.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}${Array.isArray(t.decisions)?t.decisions.map(x=>`<div class="decision"><b>Решение:</b> ${esc(x)}</div>`).join(''):''}</div>`;
  }
  function taskMini(t){
    return `<div class="task"><strong>${esc(t.text)}</strong><div class="meta"><span>${esc(t.assignee||'Без исполнителя')}</span>${t.deadline?`<span>до ${formatDate(t.deadline)}</span>`:''}${t.source_timestamp?`<span>${esc(t.source_timestamp)}</span>`:''}</div>${statusSelect(t)}</div>`;
  }

  function renderTasks(){
    main.innerHTML=`<div class="page-head"><div><div class="eyebrow">ЮРЧАК</div><h1>Задачи</h1><p>Все action items из созвонов.</p></div></div><div class="list">${tasks.length?tasks.map(t=>{const m=meetings.find(x=>x.id===t.meeting_id);return `<div class="task-row"><div><strong>${esc(t.text)}</strong>${m?`<button class="source" data-source="${m.id}">${esc(m.title)}${t.source_timestamp?` · ${esc(t.source_timestamp)}`:''}</button>`:''}</div><span>${esc(t.assignee||'Без исполнителя')}</span>${statusSelect(t)}</div>`}).join(''):`<div class="empty"><strong>Задач пока нет</strong>После обработки созвонов они появятся здесь.</div>`}</div>`;
    bindStatuses(); $$('[data-source]').forEach(b=>b.onclick=()=>navigate('meeting',b.dataset.source));
  }

  function statusSelect(t){ return `<select class="status" data-task="${t.id}"><option value="todo" ${t.status==='todo'?'selected':''}>Новая</option><option value="doing" ${t.status==='doing'?'selected':''}>В работе</option><option value="done" ${t.status==='done'?'selected':''}>Готово</option></select>`; }
  function bindStatuses(){ $$('[data-task]').forEach(s=>s.onchange=async()=>{ const {error}=await sb.from('tasks').update({status:s.value}).eq('id',s.dataset.task); if(error)return toast('Не удалось изменить статус'); const t=tasks.find(x=>x.id===s.dataset.task); if(t)t.status=s.value; updateBadge(); }); }
  function updateBadge(){ const n=tasks.filter(t=>t.status!=='done').length; const b=$('#taskCount'); b.textContent=n; b.hidden=!n; }

  function openModal(){
    $('#uploadForm').reset(); const now=new Date(); $('#meetingDate').value=now.toISOString().slice(0,10); $('#meetingTitle').value=`Созвон ${now.toLocaleDateString('ru-RU',{day:'numeric',month:'long'})}`; showFile(null); $('#modal').hidden=false;
  }
  function closeModal(){ $('#modal').hidden=true; }
  function showFile(file){ $('#fileName').textContent=file?file.name:'Выбрать видео'; $('#fileMeta').textContent=file?prettyBytes(file.size):'MP4, MOV, WEBM, M4A, MP3 · до 2 ГБ'; }

  async function uploadMeeting(e){
    e.preventDefault(); const file=$('#video').files?.[0]; if(!file)return toast('Выбери запись созвона'); if(file.size>2*1024*1024*1024)return toast('Файл должен быть меньше 2 ГБ');
    const btn=$('#uploadBtn'); btn.disabled=true; btn.textContent='Загружаем…'; let meeting;
    try{
      const mime=file.type||mimeFromName(file.name);
      const {data,error}=await sb.from('meetings').insert({title:$('#meetingTitle').value.trim(),meeting_date:$('#meetingDate').value,status:'uploading',original_filename:file.name,file_mime_type:mime,created_by:user.id}).select().single();
      if(error)throw error; meeting=data; meetings.unshift(meeting); closeModal(); renderMeetings();
      const session=await pipeline('create_upload',{meetingId:meeting.id,fileName:file.name,fileSize:file.size,mimeType:mime});
      const uploaded=await uploadToGemini(session.uploadUrl,file);
      if(!uploaded?.name||!uploaded?.uri)throw new Error('Не удалось получить данные загруженного видео.');
      const {error:updateError}=await sb.from('meetings').update({status:'preparing',gemini_file_name:uploaded.name,gemini_file_uri:uploaded.uri}).eq('id',meeting.id); if(updateError)throw updateError;
      Object.assign(meeting,{status:'preparing',gemini_file_name:uploaded.name,gemini_file_uri:uploaded.uri}); renderMeetings(); processMeeting(meeting.id);
    }catch(err){ console.error(err); if(meeting) await markError(meeting.id,err.message||String(err)); toast(localError(err.message||String(err))); }
    finally{ btn.disabled=false; btn.textContent='Загрузить и разобрать'; }
  }

  function uploadToGemini(url,file){
    return new Promise((resolve,reject)=>{ const xhr=new XMLHttpRequest(); xhr.open('POST',url); xhr.setRequestHeader('X-Goog-Upload-Offset','0'); xhr.setRequestHeader('X-Goog-Upload-Command','upload, finalize'); if(file.type)xhr.setRequestHeader('Content-Type',file.type); xhr.onerror=()=>reject(new Error('Загрузка видео прервалась')); xhr.onload=()=>{ if(xhr.status<200||xhr.status>=300)return reject(new Error(`Видео не загрузилось (${xhr.status})`)); try{resolve(JSON.parse(xhr.responseText).file)}catch{reject(new Error('Не удалось прочитать ответ загрузки'))} }; xhr.send(file); });
  }

  async function processMeeting(id){
    if(pollers.has(id))return; pollers.add(id);
    try{
      let m=meetings.find(x=>x.id===id); if(!m)return;
      if(m.status==='preparing'){
        let active=false; for(let i=0;i<180;i++){const r=await pipeline('file_status',{meetingId:id}); if(r.state==='ACTIVE'){active=true;break} if(r.state==='FAILED')throw new Error('Gemini не смог подготовить видео'); await sleep(5000);} if(!active)throw new Error('Видео слишком долго подготавливается');
        const r=await pipeline('start_analysis',{meetingId:id}); Object.assign(m,{status:'analyzing',interaction_id:r.interactionId}); if(view==='meetings')renderMeetings();
      }
      for(let i=0;i<720;i++){ const r=await pipeline('analysis_status',{meetingId:id}); if(r.status==='completed'){await loadData(); if(view==='meetings')renderMeetings(); if(view==='meeting'&&currentMeeting===id)renderMeeting(id); toast('Созвон готов ✓'); return;} if(r.status==='failed')throw new Error(r.error||'AI не смог обработать созвон'); await sleep(5000); }
      throw new Error('Разбор занимает слишком много времени');
    }catch(err){console.error(err); await markError(id,err.message||String(err)); toast(localError(err.message||String(err)));}
    finally{pollers.delete(id)}
  }
  function resumePending(){ meetings.filter(m=>['preparing','analyzing'].includes(m.status)).forEach(m=>processMeeting(m.id)); }
  async function pipeline(action,payload={}){ const {data,error}=await sb.functions.invoke('video-pipeline',{body:{action,...payload}}); if(error)throw new Error(error.message||'Ошибка сервера'); if(!data?.ok)throw new Error(data?.error||'Ошибка обработки'); return data; }
  async function markError(id,msg){ await sb.from('meetings').update({status:'error',error_message:msg}).eq('id',id); const m=meetings.find(x=>x.id===id); if(m)Object.assign(m,{status:'error',error_message:msg}); if(view==='meetings')renderMeetings(); }
  async function deleteMeeting(id){ if(!confirm('Удалить этот созвон и его задачи?'))return; const {error}=await sb.from('meetings').delete().eq('id',id); if(error)return toast('Не удалось удалить созвон'); meetings=meetings.filter(m=>m.id!==id); tasks=tasks.filter(t=>t.meeting_id!==id); updateBadge(); navigate('meetings'); }

  function statusMeta(s){return {ready:{text:'Готово',cls:'ready'},error:{text:'Ошибка',cls:'error'},uploading:{text:'Загрузка',cls:'processing'},preparing:{text:'Подготовка',cls:'processing'},analyzing:{text:'AI разбирает',cls:'processing'}}[s]||{text:s,cls:''}}
  function dateParts(v){const d=new Date(`${v}T12:00:00`);return{day:String(d.getDate()).padStart(2,'0'),month:d.toLocaleDateString('ru-RU',{month:'short'}).replace('.','')}}
  function formatDate(v){if(!v)return'';return new Date(`${v}T12:00:00`).toLocaleDateString('ru-RU',{day:'numeric',month:'short',year:'numeric'})}
  function prettyBytes(n){const u=['Б','КБ','МБ','ГБ'];let i=0;while(n>=1024&&i<3){n/=1024;i++}return `${n.toFixed(i>1?1:0)} ${u[i]}`}
  function mimeFromName(n){n=n.toLowerCase();if(n.endsWith('.mov'))return'video/quicktime';if(n.endsWith('.webm'))return'video/webm';if(n.endsWith('.m4a'))return'audio/mp4';if(n.endsWith('.mp3'))return'audio/mpeg';if(n.endsWith('.wav'))return'audio/wav';return'video/mp4'}
  function esc(v=''){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
  function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
  function localError(msg=''){if(/Invalid login credentials/i.test(msg))return'Неверный email или пароль.';if(/Email not confirmed/i.test(msg))return'Сначала подтверди email в письме.';if(/User already registered/i.test(msg))return'Такой аккаунт уже существует.';if(/Failed to fetch|NetworkError/i.test(msg))return'Нет связи с сервером. Проверь интернет.';return msg}
  let tt; function toast(msg){clearTimeout(tt);toastEl.textContent=msg;toastEl.hidden=false;tt=setTimeout(()=>toastEl.hidden=true,5000)}
})();
