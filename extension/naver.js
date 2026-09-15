(() => {
  if(globalThis.__blogStudioInstalled)return;globalThis.__blogStudioInstalled=true;
  let running=null,stopped=false;
  const selectors={title:'.se-documentTitle .se-text-paragraph',body:'.se-component.se-text .se-text-paragraph',open:'button[data-click-area="tpb.publish"],button[class*="publish_btn"]',confirm:'button[data-click-area="tpb*i.publish"],button[class*="confirm_btn"]'};
  const compact=value=>String(value).normalize('NFC').replace(/[\s\u200b\ufeff]/gu,'');
  const text=key=>[...document.querySelectorAll(selectors[key])].map(el=>el.innerText).join('\n');
  const body=post=>post.sections.map(s=>s.heading+'\n'+s.content).join('\n\n');
  const check=()=>{if(stopped)throw new Error('사용자가 입력을 중지했습니다.');};
  async function tell(type,extra={}){const response=await chrome.runtime.sendMessage({type,id:running,...extra});if(!response?.ok)throw new Error(response?.error||'웹앱과 연결이 끊어졌습니다.');return response.result;}
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function verify(post){if(compact(text('title'))!==compact(post.title)||compact(text('body'))!==compact(body(post)))throw new Error('편집기에 입력된 글이 원고와 다릅니다. 자동 발행하지 않았습니다.');}
  function focusAtEnd(element){
    element.scrollIntoView({block:'center'});element.click();
    const editable=element.closest('[contenteditable="true"]')||element.querySelector('[contenteditable="true"]')||element;
    editable.focus();const range=document.createRange();range.selectNodeContents(element);range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
  }
  async function typeText(value,speed,offset,total){
    const chars=Array.from(value);
    for(let i=0;i<chars.length;i++){
      check();const char=chars[i];
      const selection=getSelection();const anchor=selection.anchorNode?.nodeType===1?selection.anchorNode:selection.anchorNode?.parentElement;
      if(!anchor?.closest('.se-documentTitle,.se-component.se-text'))throw new Error('편집기 입력 위치가 바뀌었습니다. 자동 입력을 중지했습니다.');
      const inserted=char==='\n'?document.execCommand('insertParagraph',false):document.execCommand('insertText',false,char);
      if(!inserted)throw new Error('이 편집기에서 글자 입력이 지원되지 않습니다. 확장의 입력 방식을 점검해야 합니다.');
      if(i%15===0||i===chars.length-1)await tell('PROGRESS',{progress:Math.round((offset+i+1)/total*95)});
      await pause((650+Math.random()*700)/speed+(/[.!?\n]/.test(char)?120+Math.random()*200:0));
    }
  }
  async function button(key){
    for(let i=0;i<40;i++){
      check();const found=[...document.querySelectorAll(selectors[key])].filter(el=>el.getClientRects().length&&!el.disabled&&el.innerText.trim()==='발행');
      if(found.length>1)throw new Error('발행 버튼이 여러 개입니다. 확장의 선택자를 확인해 주세요.');
      if(found.length===1)return found[0];await pause(250);
    }
    throw new Error('발행 버튼을 찾지 못했습니다. 네이버 화면과 확장의 선택자를 확인해 주세요.');
  }
  async function run(job){
    try{
      const currentTitle=compact(text('title')),currentBody=compact(text('body'));
      const identical=currentTitle===compact(job.post.title)&&currentBody===compact(body(job.post));
      if(!identical){
        if(currentTitle||currentBody)throw new Error('기존 글이 있는 편집기입니다. 덮어쓰지 않았습니다. 저장하거나 직접 비운 뒤 다시 실행하세요.');
        const title=document.querySelector(selectors.title),content=document.querySelector(selectors.body);
        if(!title||!content)throw new Error('제목 또는 본문 입력란을 찾지 못했습니다.');
        const all=body(job.post),total=Array.from(job.post.title).length+Array.from(all).length;
        focusAtEnd(title);await typeText(job.post.title,job.speed,0,total);
        focusAtEnd(content);await typeText(all,job.speed,Array.from(job.post.title).length,total);
      }
      check();verify(job.post);
      if(!job.publish){await tell('TYPED');return;}
      (await button('open')).click();const confirm=await button('confirm');
      check();verify(job.post);
      await tell('WILL_PUBLISH');check();confirm.click();
      // The background checks navigation and post title. Never retry this click.
    }catch(error){try{await tell('FAILED',{error:error.message});}catch{}}
    finally{running=null;}
  }
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id!==chrome.runtime.id)return;
    if(message.type==='STOP'){if(message.id===running)stopped=true;reply({ok:true});return;}
    if(message.type==='EXECUTE'){
      if(running){reply({ok:false,error:'이 편집기에서 이미 입력 중입니다.'});return;}
      if(!document.querySelector(selectors.title)||!document.querySelector('[contenteditable="true"]')){reply({ok:false,error:'빈 글쓰기 편집기를 열어 주세요.'});return;}
      running=message.job.id;stopped=false;reply({ok:true});run(message.job);
    }
  });
  // Exposed only to the extension's isolated world, to permit a local DOM-fixture test.
})();
