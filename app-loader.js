(async()=>{
  try{
    const r=await fetch(`app.js?v=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error(`Не вдалося завантажити застосунок: HTTP ${r.status}`);
    let code=await r.text();
    code=code.replace("doneTasks=tasks.filter(t=>t.status==='done';","doneTasks=tasks.filter(t=>t.status==='done');");
    (0,eval)(code);
  }catch(e){
    console.error(e);
    document.body.innerHTML=`<div style="min-height:100vh;display:grid;place-items:center;background:#f6faff;font-family:Inter,Arial,sans-serif;color:#13233e;padding:24px"><div style="max-width:520px;background:white;border:1px solid #dce8f8;border-radius:20px;padding:28px"><h2 style="margin-top:0">Не вдалося запустити сайт</h2><p style="color:#73839b;line-height:1.55">${String(e?.message||e)}</p><button onclick="location.reload()" style="border:0;border-radius:11px;background:#1d68f5;color:white;padding:11px 16px;font-weight:700">Оновити сторінку</button></div></div>`;
  }
})();
