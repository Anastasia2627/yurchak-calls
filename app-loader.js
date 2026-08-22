(async()=>{
  try{
    const r=await fetch(`app-groq.js?v=${Date.now()}`,{cache:'no-store'});
    if(!r.ok) throw new Error(`Не вдалося завантажити застосунок: HTTP ${r.status}`);
    let code=await r.text();

    code=code.replace(
      'let mediaLibPromise = null;',
      'let mediaLibPromise = null; const nativeAudioCache = new WeakMap();'
    );

    const mediaPattern=/async function mediaLib\(\)\{[\s\S]*?\n  \}\n  async function inspectMedia\(M,file\)\{[\s\S]*?\n  \}/;
    if(!mediaPattern.test(code)) throw new Error('Не вдалося підготувати нативну обробку аудіо.');
    code=code.replace(mediaPattern,
      "async function mediaLib(){ return null; }\n"+
      "  async function inspectMedia(_M,file){\n"+
      "    const AudioCtx=window.AudioContext||window.webkitAudioContext;\n"+
      "    if(!AudioCtx)throw new Error('Цей браузер не підтримує обробку аудіо. Відкрий сайт у Chrome.');\n"+
      "    const ctx=new AudioCtx({sampleRate:16000});\n"+
      "    try{\n"+
      "      const buffer=await ctx.decodeAudioData(await file.arrayBuffer());\n"+
      "      if(!buffer||!Number.isFinite(buffer.duration)||buffer.duration<=0)throw new Error('Порожня аудіодоріжка.');\n"+
      "      nativeAudioCache.set(file,buffer);\n"+
      "      return {audio:true,duration:buffer.duration};\n"+
      "    }catch(e){\n"+
      "      throw new Error('Chrome не зміг прочитати аудіодоріжку цього відео. Спробуй інший MP4 або M4A/MP3.');\n"+
      "    }finally{ try{await ctx.close();}catch{} }\n"+
      "  }"
    );

    const chunkPattern=/async function makeM4aChunk\(M,file,start,end,onProgress\)\{[\s\S]*?\n  \}\n\n  async function transcribePart/;
    if(!chunkPattern.test(code)) throw new Error('Не вдалося підготувати WAV-конвертацію.');
    code=code.replace(chunkPattern,
      "async function makeM4aChunk(_M,file,start,end,onProgress){\n"+
      "    const audio=nativeAudioCache.get(file);\n"+
      "    if(!audio)throw new Error('Аудіодоріжка не підготовлена.');\n"+
      "    const sr=audio.sampleRate;\n"+
      "    const from=Math.max(0,Math.floor(start*sr));\n"+
      "    const to=Math.min(audio.length,Math.ceil(end*sr));\n"+
      "    const frames=Math.max(0,to-from);\n"+
      "    if(!frames)throw new Error('Порожній аудіофрагмент.');\n"+
      "    const wav=new ArrayBuffer(44+frames*2);\n"+
      "    const v=new DataView(wav);\n"+
      "    const str=(o,s)=>{for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i));};\n"+
      "    str(0,'RIFF');v.setUint32(4,36+frames*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,sr,true);v.setUint32(28,sr*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,frames*2,true);\n"+
      "    const channels=[];for(let c=0;c<audio.numberOfChannels;c++)channels.push(audio.getChannelData(c));\n"+
      "    const reportEvery=Math.max(1,Math.floor(frames/20));\n"+
      "    for(let i=0;i<frames;i++){\n"+
      "      let sample=0;for(let c=0;c<channels.length;c++)sample+=channels[c][from+i]||0;sample/=Math.max(1,channels.length);sample=Math.max(-1,Math.min(1,sample));v.setInt16(44+i*2,sample<0?sample*32768:sample*32767,true);\n"+
      "      if(i%reportEvery===0)onProgress(i/frames);\n"+
      "    }\n"+
      "    onProgress(1);\n"+
      "    const blob=new Blob([wav],{type:'audio/wav'});\n"+
      "    if(blob.size>20*1024*1024)throw new Error('Аудіофрагмент вийшов завеликим.');\n"+
      "    return new File([blob],'yurchak-'+Math.round(start)+'-'+Math.round(end)+'.wav',{type:'audio/wav'});\n"+
      "  }\n\n"+
      "  async function transcribePart"
    );

    code += '\n//# sourceURL=app-groq-runtime.js';
    (0,eval)(code);
  }catch(e){
    console.error(e);
    document.body.innerHTML=`<div style="min-height:100vh;display:grid;place-items:center;background:#f6faff;font-family:Inter,Arial,sans-serif;color:#13233e;padding:24px"><div style="max-width:520px;background:white;border:1px solid #dce8f8;border-radius:20px;padding:28px"><h2 style="margin-top:0">Не вдалося запустити сайт</h2><p style="color:#73839b;line-height:1.55">${String(e?.message||e)}</p><button onclick="location.reload()" style="border:0;border-radius:11px;background:#1d68f5;color:white;padding:11px 16px;font-weight:700">Оновити сторінку</button></div></div>`;
  }
})();
