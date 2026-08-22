(async()=>{
  try{
    const r=await fetch(`app-groq.js?v=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error(`Не вдалося завантажити застосунок: HTTP ${r.status}`);
    let code=await r.text();

    // Avoid the optional AAC encoder package. PCM WAV at 16 kHz mono is
    // natively supported by Mediabunny and stays well below Groq's file limit
    // for our 6-minute chunks.
    code=code.replace(
      /async function mediaLib\(\)\{[\s\S]*?\n  \}\n  async function inspectMedia/,
      `async function mediaLib(){\n    if(!mediaLibPromise) mediaLibPromise=import('https://cdn.jsdelivr.net/npm/mediabunny@1.55.1/+esm');\n    return mediaLibPromise;\n  }\n  async function inspectMedia`
    );

    code=code.replace(
      /async function makeM4aChunk\(M,file,start,end,onProgress\)\{[\s\S]*?\n  \}\n\n  async function transcribePart/,
      `async function makeM4aChunk(M,file,start,end,onProgress){\n    const input=new M.Input({formats:M.ALL_FORMATS,source:new M.BlobSource(file)}),target=new M.BufferTarget();\n    const output=new M.Output({format:new M.WavOutputFormat(),target});\n    const conversion=await M.Conversion.init({input,output,tracks:'primary',video:{discard:true},audio:{codec:'pcm-s16',numberOfChannels:1,sampleRate:16000,forceTranscode:true},trim:{start,end},showWarnings:false});\n    if(!conversion.isValid)throw new Error('Не вдалося підготувати аудіодоріжку. Спробуй відкрити сайт у Chrome.');\n    conversion.onProgress=p=>onProgress(Number(p||0));\n    await conversion.execute();\n    if(!target.buffer)throw new Error('Не вдалося створити аудіофрагмент.');\n    const blob=new Blob([target.buffer],{type:'audio/wav'});\n    if(blob.size>20*1024*1024)throw new Error('Аудіофрагмент вийшов завеликим.');\n    return new File([blob],\\`yurchak-\\${Math.round(start)}-\\${Math.round(end)}.wav\\`,{type:'audio/wav'});\n  }\n\n  async function transcribePart`
    );

    (0,eval)(code);
  }catch(e){
    console.error(e);
    document.body.innerHTML=`<div style="min-height:100vh;display:grid;place-items:center;background:#f6faff;font-family:Inter,Arial,sans-serif;color:#13233e;padding:24px"><div style="max-width:520px;background:white;border:1px solid #dce8f8;border-radius:20px;padding:28px"><h2 style="margin-top:0">Не вдалося запустити сайт</h2><p style="color:#73839b;line-height:1.55">${String(e?.message||e)}</p><button onclick="location.reload()" style="border:0;border-radius:11px;background:#1d68f5;color:white;padding:11px 16px;font-weight:700">Оновити сторінку</button></div></div>`;
  }
})();
