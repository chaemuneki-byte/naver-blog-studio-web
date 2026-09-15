import {normalizePost,validate} from './core.js';
import {isStudioUrl,isPostUrl,fingerprint,terminal} from './policy.js';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const runners=new Set();let starting=false,changes=Promise.resolve();
const readJob=async()=> (await chrome.storage.session.get('job')).job;
const saveJob=async job=>chrome.storage.session.set({job});
function patch(id,change){
  const operation=changes.then(async()=>{const job=await readJob();if(job?.id!==id)return null;if(terminal(job.status))return job;Object.assign(job,change,{updatedAt:Date.now()});await saveJob(job);return job;});
  changes=operation.catch(()=>{});return operation;
}
async function journal(job,state,url=''){await chrome.storage.local.set({[job.fingerprint]:{state,blogId:job.blogId,title:job.post.title,url,at:Date.now()}});}
function checkBlog(value){if(!/^[A-Za-z0-9_-]{1,64}$/.test(value||''))throw new Error('본인 블로그 ID를 확인해 주세요.');}
async function writer(blogId){
  const existing=await chrome.tabs.query({url:'https://blog.naver.com/*'});
  const tab=existing.find(t=>{
    const u=new URL(t.url);return (u.pathname===`/${blogId}/postwrite` || (u.pathname.includes('PostWrite')&&u.searchParams.get('blogId')===blogId));
  });
  if(tab){await chrome.tabs.update(tab.id,{active:true});return tab;}
  return chrome.tabs.create({url:`https://blog.naver.com/${encodeURIComponent(blogId)}/postwrite`,active:true});
}
async function findEditor(tabId){
  try{
    const results=await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>({
      ready:!!document.querySelector('.se-documentTitle .se-text-paragraph')&&!!document.querySelector('[contenteditable="true"]')&&!!document.querySelector('.se-component.se-text .se-text-paragraph'),url:location.href
    })});
    return results.find(result=>result.result?.ready);
  }catch{return null;}
}
async function beginTyping(job){
  if(runners.has(job.id))return;
  runners.add(job.id);
  try{
    while(Date.now()-job.startedAt<300000){
      const current=await readJob();if(current?.id!==job.id||terminal(current.status))return;
      const editor=await findEditor(job.tabId);
      if(editor){
        const frameUrl=new URL(editor.result.url);
        const authorized=frameUrl.pathname.startsWith(`/${job.blogId}/`)||frameUrl.searchParams.get('blogId')===job.blogId;
        if(!authorized)throw new Error('열린 편집기의 블로그 ID가 요청과 다릅니다. 올바른 계정의 글쓰기 화면을 확인하세요.');
        job=await patch(job.id,{frameId:editor.frameId,status:'typing',message:'네이버에 한 글자씩 입력하고 있어요',detail:'입력 중에는 편집기를 클릭하거나 다른 키를 누르지 마세요.'});
        if(!job||job.status!=='typing')return;
        const answer=await chrome.tabs.sendMessage(job.tabId,{type:'EXECUTE',job},{frameId:editor.frameId});
        if(!answer?.ok)throw new Error(answer?.error||'편집기 연결에 실패했습니다.');
        return;
      }
      await delay(700);
    }
    throw new Error('5분 안에 편집기를 찾지 못했습니다. 네이버 로그인과 도움말/임시저장 안내를 확인해 주세요.');
  }catch(error){await patch(job.id,{status:'error',message:'네이버 입력을 시작하지 못했어요',detail:error.message});}
  finally{runners.delete(job.id);}
}
async function verifyPublished(job){
  if(job.status!=='publishing')return job;
  try{
    const results=await chrome.scripting.executeScript({target:{tabId:job.tabId,allFrames:true},func:()=>({
      url:location.href,title:document.querySelector('.se-title-text, .se-documentTitle')?.innerText||''
    })});
    const found=results.find(r=>isPostUrl(r.result?.url,job.blogId)&&r.result.title.replace(/\s/g,'').includes(job.post.title.replace(/\s/g,'')));
    if(found){await journal(job,'published',found.result.url);return patch(job.id,{status:'published',message:'블로그 발행을 완료했어요',detail:'게시물 주소와 제목을 확인했습니다.',url:found.result.url,progress:100});}
  }catch{}
  if(Date.now()-(job.publishAt||job.updatedAt)>60000)return patch(job.id,{status:'error',message:'발행 결과를 직접 확인해 주세요',detail:'발행 요청은 전송됐지만 완료를 확인하지 못했습니다. 중복 방지를 위해 자동 재시도하지 않습니다.'});
  return job;
}
async function fromStudio(type,payload,sender){
  if(type==='PING')return {version:'1.0.0'};
  if(type==='OPEN'){checkBlog(payload.blogId);const tab=await writer(payload.blogId);return {tabId:tab.id};}
  if(type==='START'){
    if(starting)throw new Error('다른 연결 요청이 진행 중입니다.');starting=true;
    try{
      checkBlog(payload.blogId);
      const previous=await readJob();if(previous&&!terminal(previous.status))throw new Error('이미 진행 중인 작업이 있습니다. 해당 웹페이지에서 중지하거나 네이버를 확인하세요.');
      const post=normalizePost(payload.post),errors=validate(post,payload.target,payload.keyword);
      if(errors.length)throw new Error(errors.join(' '));
      if(!Number.isFinite(payload.speed)||payload.speed<1||payload.speed>80||typeof payload.publish!=='boolean')throw new Error('입력 설정을 확인해 주세요.');
      const key=await fingerprint(payload.blogId,post),record=(await chrome.storage.local.get(key))[key];
      if(record&&['publishing','published'].includes(record.state))throw new Error('이 원고는 발행 완료 또는 결과 미확인 기록이 있습니다. 중복 발행하지 않습니다. 네이버에서 확인해 주세요.');
      const tab=await writer(payload.blogId);
      const job={id:crypto.randomUUID(),owner:sender.tab.id,tabId:tab.id,fingerprint:key,post,blogId:payload.blogId,speed:payload.speed,publish:payload.publish,status:'opening',message:'네이버 편집기를 기다리고 있어요',detail:'로그인과 보안 확인, 도움말/임시저장 안내는 네이버 탭에서 직접 처리해 주세요.',progress:0,startedAt:Date.now(),updatedAt:Date.now()};
      await saveJob(job);beginTyping(job);return {id:job.id};
    }finally{starting=false;}
  }
  let job=await readJob();if(!job||job.id!==payload.id||job.owner!==sender.tab.id)throw new Error('이 웹페이지의 작업 기록이 아닙니다.');
  if(type==='STOP'){
    if(!terminal(job.status)){
      try{await chrome.tabs.sendMessage(job.tabId,{type:'STOP',id:job.id});}catch{}
      job=await patch(job.id,{status:'stopped',message:'작업을 중지했어요',detail:job.status==='publishing'?'발행 요청 이후 중지했습니다. 이미 발행되었을 수 있으니 네이버를 확인하세요.':'입력된 내용은 편집기에 남아 있습니다.'});
    }
    return {status:job.status};
  }
  if(type==='STATUS'){
    if(job.status==='opening')beginTyping(job);
    job=await verifyPublished(job);
    if(job.status==='typing'&&Date.now()-job.updatedAt>90000)job=await patch(job.id,{status:'error',message:'편집기 연결이 멈췄어요',detail:'네이버 탭을 확인하세요. 발행하지 않았습니다.'});
    const {post,fingerprint,...publicJob}=job;return publicJob;
  }
  throw new Error('지원하지 않는 요청입니다.');
}
async function fromNaver(message,sender){
  const job=await readJob();
  if(!job||job.id!==message.id||job.tabId!==sender.tab?.id||job.frameId!==sender.frameId)throw new Error('요청한 편집기와 일치하지 않습니다.');
  if(terminal(job.status))throw new Error('작업이 이미 종료되었습니다.');
  if(message.type==='WILL_PUBLISH'){
    if(!job.publish)throw new Error('입력만 요청한 작업입니다.');
    if(job.status!=='typing')throw new Error('이미 발행 요청이 처리되었습니다.');
    await journal(job,'publishing');
    const next=await patch(job.id,{status:'publishing',publishAt:Date.now(),message:'최종 발행 요청을 보내고 있어요',detail:'발행 후 게시물 주소와 제목을 확인합니다.'});
    if(next?.status!=='publishing')throw new Error('발행 전에 작업이 중지되었습니다.');
    return {ok:true};
  }
  if(message.type==='PROGRESS'&&job.status==='typing')await patch(job.id,{progress:Math.max(0,Math.min(99,Number(message.progress)||0))});
  if(message.type==='TYPED'&&job.status==='typing'&&!job.publish){await journal(job,'typed');await patch(job.id,{status:'typed',progress:100,message:'네이버에 입력을 완료했어요',detail:'발행 버튼은 누르지 않았습니다. 원고를 확인한 후 웹에서 발행할 수 있어요.'});}
  if(message.type==='FAILED')await patch(job.id,{status:'error',message:'작업을 완료하지 못했어요',detail:String(message.error).slice(0,1000)+(job.status==='publishing'?' 이미 발행되었을 수 있으니 블로그를 확인하세요.':'')});
  return {ok:true};
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{
  const task=async()=>{
    if(sender.tab&&sender.frameId===0&&isStudioUrl(sender.url))return fromStudio(message.type,message.payload||{},sender);
    if(sender.tab&&new URL(sender.url||'about:blank').hostname==='blog.naver.com')return fromNaver(message,sender);
    throw new Error('허용되지 않은 웹페이지입니다.');
  };
  task().then(result=>reply({ok:true,result})).catch(error=>reply({ok:false,error:error.message}));return true;
});
chrome.tabs.onUpdated.addListener((tabId,change)=>{if(change.status==='complete')readJob().then(job=>{if(job?.tabId===tabId&&job.status==='publishing')verifyPublished(job);});});
chrome.tabs.onRemoved.addListener(tabId=>readJob().then(job=>{if(job?.tabId===tabId&&!terminal(job.status))patch(job.id,{status:'error',message:'네이버 탭이 닫혔어요',detail:job.status==='publishing'?'발행 여부를 블로그에서 확인하세요. 자동 재발행하지 않습니다.':'작업이 중지되었습니다.'});}));
chrome.action.onClicked.addListener(()=>chrome.tabs.create({url:'https://chaemuneki-byte.github.io/naver-blog-studio-web/'}));
