(async()=>{
  try{
    const r=await fetch(`app-groq.js?v=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error(`Не вдалося завантажити застосунок: HTTP ${r.status}`);
    let code=await r.text();

    if(!code.includes('let mediaLibPromise = null;')){
      throw new Error('Не вдалося підготувати аудіомодуль: змінено структуру застосунку.');
    }
    code=code.replace(
      'let mediaLibPromise = null;',
      'let mediaLibPromise = null;\n  const nativeAudioCache = new WeakMap();'
    );

    const start=code.indexOf('  async function mediaLib(){');
    const end=code.indexOf('  async function transcribePart(', start);
    if(start<0||end<0||end<=start){
      throw new Error('Не вдалося підготувати WAV-конвертацію: медіаблок не знайдено.');
    }

    const nativeBlock=`  async function mediaLib(){ return null; }

  async function inspectMedia(_M,file){
    const AudioCtx=window.AudioContext||window.webkitAudioContext;
    if(!AudioCtx) throw new Error('Цей браузер не підтримує обробку аудіо. Відкрий сайт у Chrome.');
    const ctx=new AudioCtx({sampleRate:16000});
    try{
      const raw=await file.arrayBuffer();
      const buffer=await ctx.decodeAudioData(raw.slice(0));
      if(!buffer||!Number.isFinite(buffer.duration)||buffer.duration<=0){
        throw new Error('Порожня аудіодоріжка.');
      }
      nativeAudioCache.set(file,buffer);
      return {audio:true,duration:buffer.duration};
    }catch(e){
      console.error('Audio decode failed',e);
      throw new Error('Chrome не зміг прочитати аудіодоріжку цього відео. Спробуй інший MP4 або M4A/MP3.');
    }finally{
      try{await ctx.close();}catch{}
    }
  }

  async function makeM4aChunk(_M,file,start,end,onProgress){
    const audio=nativeAudioCache.get(file);
    if(!audio) throw new Error('Аудіодоріжка не підготовлена.');
    const sr=audio.sampleRate;
    const from=Math.max(0,Math.floor(start*sr));
    const to=Math.min(audio.length,Math.ceil(end*sr));
    const frames=Math.max(0,to-from);
    if(!frames) throw new Error('Порожній аудіофрагмент.');

    const wav=new ArrayBuffer(44+frames*2);
    const v=new DataView(wav);
    const write=(offset,text)=>{for(let i=0;i<text.length;i++)v.setUint8(offset+i,text.charCodeAt(i));};
    write(0,'RIFF');
    v.setUint32(4,36+frames*2,true);
    write(8,'WAVE');write(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);
    v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);
    write(36,'data');v.setUint32(40,frames*2,true);

    const channels=[];
    for(let c=0;c<audio.numberOfChannels;c++) channels.push(audio.getChannelData(c));
    const reportEvery=Math.max(1,Math.floor(frames/20));
    for(let i=0;i<frames;i++){
      let sample=0;
      for(let c=0;c<channels.length;c++) sample+=channels[c][from+i]||0;
      sample/=Math.max(1,channels.length);
      sample=Math.max(-1,Math.min(1,sample));
      v.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true);
      if(i%reportEvery===0) onProgress(i/frames);
    }
    onProgress(1);
    const blob=new Blob([wav],{type:'audio/wav'});
    if(blob.size>20*1024*1024) throw new Error('Аудіофрагмент вийшов завеликим.');
    return new File([blob],'yurchak-'+Math.round(start)+'-'+Math.round(end)+'.wav',{type:'audio/wav'});
  }

`;

    code=code.slice(0,start)+nativeBlock+code.slice(end);
    code+='\n//# sourceURL=app-groq-runtime.js';
    (0,eval)(code);
  }catch(e){
    console.error(e);
    document.body.innerHTML=`<div style="min-height:100vh;display:grid;place-items:center;background:#f6faff;font-family:Inter,Arial,sans-serif;color:#13233e;padding:24px"><div style="max-width:520px;background:white;border:1px solid #dce8f8;border-radius:20px;padding:28px"><h2 style="margin-top:0">Не вдалося запустити сайт</h2><p style="color:#73839b;line-height:1.55">${String(e?.message||e)}</p><button onclick="location.reload()" style="border:0;border-radius:11px;background:#1d68f5;color:white;padding:11px 16px;font-weight:700">Оновити сторінку</button></div></div>`;
  }
})();
