import {bodyText, clean, count, generate, normalizePost, validate} from './core.js';
const $ = id => document.getElementById(id);
let post = null, meta = null, example = false, busy = false, controller = null, connected = false, extensionJob = null;
const pending = new Map();
const settingsFields = ['blog-id','model','speed'];
try { const saved=JSON.parse(localStorage.getItem('blog-studio-settings')||'{}'); for(const id of settingsFields) if(saved[id]) $(id).value=saved[id]; } catch {}
window.addEventListener('message', event => {
  if(event.source !== window || event.origin !== location.origin || event.data?.channel !== 'BLOG_STUDIO_RESPONSE') return;
  const entry = pending.get(event.data.id);
  if(entry) { clearTimeout(entry.timer); pending.delete(event.data.id); event.data.ok ? entry.resolve(event.data.result) : entry.reject(new Error(event.data.error || '브라우저 연결 요청에 실패했습니다.')); }
});
function bridge(type, payload={}, timeout=5000) {
  return new Promise((resolve,reject)=>{
    const id=crypto.randomUUID();
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('네이버 연결 확장을 설치하고 이 페이지를 새로고침해 주세요.'));},timeout);
    pending.set(id,{resolve,reject,timer});
    window.postMessage({channel:'BLOG_STUDIO_REQUEST', id, type, payload},location.origin);
  });
}
function status(text, detail='', error=false) {
  $('status').textContent=text; $('status-detail').textContent=detail;
  $('status').style.color=error?'#ad4c3f':'';
}
function setBusy(value) {
  busy=value;
  for(const id of ['generate','demo','keyword','target','facts','auto','title']) $(id).disabled=value;
  document.querySelectorAll('.section-heading,.section-content,[data-target]').forEach(el=>el.disabled=value);
  $('stop').disabled=!value;
  $('status-orb').classList.toggle('busy',value);
  $('progress').hidden=!value;
  updateStats();
}
function config() {
  const blogId=$('blog-id').value.trim(), speed=Number($('speed').value);
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(blogId)) throw new Error('연결 설정에 본인의 블로그 ID를 입력해 주세요.');
  if(!Number.isFinite(speed)||speed<1||speed>80) throw new Error('입력 속도는 초당 1~80자로 설정해 주세요.');
  return {blogId,speed};
}
function updateStats() {
  const errors=post?validate(post,meta.target,meta.keyword):[];
  $('total').textContent=post?count(bodyText(post)).toLocaleString():'0';
  $('section-total').textContent=`소제목 ${post?.sections.length||0}개`;
  $('validation').textContent=post?(errors.length?errors.join(' '):'✓ 목표 분량과 소제목별 200~300자 조건을 충족했습니다.') : '';
  $('validation').classList.toggle('ok',!errors.length);
  for(const id of ['download','copy']) $(id).disabled=!post;
  for(const id of ['type','publish']) $(id).disabled=!post||busy||example||!!errors.length;
  document.querySelectorAll('.article-section').forEach((el,i)=>{
    const n=count(post.sections[i].content); const label=el.querySelector('.section-count');label.textContent=`${n} / 200~300자`;label.classList.toggle('bad',n<200||n>300);
  });
}
function render() {
  $('empty').hidden=!!post; $('article').hidden=!post;
  if(!post) return;
  $('title').value=post.title; $('sections').replaceChildren();
  post.sections.forEach((section,index)=>{
    const fragment=$('section-template').content.cloneNode(true);
    fragment.querySelector('.section-index').textContent=`SECTION ${String(index+1).padStart(2,'0')}`;
    const heading=fragment.querySelector('.section-heading'), content=fragment.querySelector('.section-content');
    heading.value=section.heading;content.value=section.content;
    heading.disabled=busy;content.disabled=busy;
    heading.setAttribute('aria-label',`${index+1}번 소제목`); content.setAttribute('aria-label',`${index+1}번 내용`);
    heading.addEventListener('input',()=>{post.sections[index].heading=heading.value;updateStats();});
    content.addEventListener('input',()=>{post.sections[index].content=content.value;updateStats();});
    $('sections').append(fragment);
  });
  $('draft-badge').textContent=example?'예시 원고':'작성 완료';
  updateStats();
}
async function probe() {
  try {await bridge('PING',{},1800);connected=true;} catch {connected=false;}
  $('connection').classList.toggle('connected',connected);
  $('connection').querySelector('span').textContent=connected?'네이버 연결 준비됨':'네이버 연결 필요';
  $('extension-status').textContent=connected?'✓ 연결됨':'설치 후 새로고침';
}
async function ensureBridge() {await bridge('PING',{},1800);connected=true;}
async function sendToNaver(publish) {
  if(!post||example) throw new Error('실제 원고를 먼저 생성해 주세요. 예시 원고는 발행할 수 없습니다.');
  const candidate=normalizePost(post), errors=validate(candidate,meta.target,meta.keyword);
  if(errors.length) throw new Error(errors.join(' '));
  const connection=config();
  await ensureBridge();
  const result=await bridge('START',{...connection,post:candidate,keyword:meta.keyword,target:meta.target,publish},15000);
  extensionJob=result.id;setBusy(true);
  status('네이버 편집기를 연결하고 있어요','로그인이 필요하면 새 네이버 탭에서 직접 로그인하세요.');
}
$('generate').addEventListener('click',async()=>{
  if(busy) return;
  const keyword=clean($('keyword').value), target=Number($('target').value), auto=$('auto').checked;
  try {
    setBusy(true);
    if(auto){config();await ensureBridge();}
    if(!$('api-key').value.trim()){$('settings').showModal();throw new Error('OpenAI API 키를 입력한 뒤 다시 생성해 주세요.');}
    controller=new AbortController();$('progress').value=5;
    const result=await generate({key:$('api-key').value,model:$('model').value.trim(),keyword,target,facts:$('facts').value,
      signal:controller.signal,onProgress:message=>status(message,'조건에 맞는 자연스러운 원고를 작성하고 있어요.')});
    post=result;meta={keyword,target};example=false;render();$('progress').value=100;
    status('원고가 완성됐어요',`${count(bodyText(post)).toLocaleString()}자 · 내용을 수정하거나 네이버에 입력할 수 있어요.`);
    if(auto){controller.signal.throwIfAborted();await sendToNaver(true);}
  } catch(error){status(error.name==='AbortError'?'글 생성을 중지했어요':'작업을 완료하지 못했어요',error.message,error.name!=='AbortError');}
  finally {controller=null;if(!extensionJob)setBusy(false);}
});
$('title').addEventListener('input',()=>{if(post){post.title=$('title').value;updateStats();}});
for(const [id,publish] of [['type',false],['publish',true]]) $(id).addEventListener('click',async()=>{
  if(busy)return;setBusy(true);
  try {await sendToNaver(publish);}catch(error){status('네이버 연결을 확인해 주세요',error.message,true);setBusy(false);}
});
$('stop').addEventListener('click',async()=>{
  controller?.abort();
  if(extensionJob) try {await bridge('STOP',{id:extensionJob});status('중지를 요청했어요','발행 요청이 이미 전송됐다면 블로그에서 게시 여부를 확인해 주세요.');} catch(error){status('중지 상태를 확인할 수 없어요',error.message,true);}
});
setInterval(async()=>{
  if(!extensionJob) return;
  try {
    const job=await bridge('STATUS',{id:extensionJob});
    if(!job)throw new Error('연결 작업 기록이 없습니다. 네이버에서 게시 여부를 확인해 주세요.');
    $('progress').value=job.progress||0;status(job.message,job.detail||'',job.status==='error');
    if(['published','typed','error','stopped'].includes(job.status)){
      extensionJob=null;setBusy(false);
      if(job.url){const a=document.createElement('a');a.href=job.url;a.target='_blank';a.rel='noopener';a.textContent='발행된 글 확인 ↗';$('status-detail').replaceChildren(a);}
    }
  }catch(error){extensionJob=null;setBusy(false);status('연결이 끊어졌어요',`${error.message} 작업이 진행 중일 수 있으니 네이버를 확인해 주세요.`,true);}
},1800);
for(const id of ['settings-nav','connection']) $(id).addEventListener('click',()=>{$('settings').showModal();probe();});
$('help-nav').addEventListener('click',()=>$('guide').showModal());
$('write-nav').addEventListener('click',()=>{$('keyword').focus();window.scrollTo({top:0,behavior:'smooth'});});
$('show-install').addEventListener('click',()=>{$('settings').close();$('guide').showModal();});
$('save-settings').addEventListener('click',()=>{
  try {
    const speed=Number($('speed').value);if(speed<1||speed>80||!Number.isFinite(speed))throw new Error('입력 속도는 1~80자로 설정해 주세요.');
    localStorage.setItem('blog-studio-settings',JSON.stringify(Object.fromEntries(settingsFields.map(id=>[id,$(id).value.trim()]))));
    $('settings').close();status('설정을 적용했어요','API 키는 이 탭을 닫거나 새로고침하면 지워집니다.');probe();
  }catch(error){status('설정을 저장하지 못했어요',error.message,true);}
});
$('open-naver').addEventListener('click',async()=>{
  try {const connection=config();await ensureBridge();await bridge('OPEN',connection);status('네이버 편집기를 열었어요','네이버에 로그인하고 빈 편집기를 준비하세요.');} catch(error){status('네이버 연결을 확인해 주세요',error.message,true);}
});
document.querySelectorAll('[data-target]').forEach(button=>button.addEventListener('click',()=>{
  $('target').value=button.dataset.target;document.querySelectorAll('[data-target]').forEach(el=>el.classList.toggle('selected',el===button));
}));
$('target').addEventListener('input',()=>document.querySelectorAll('[data-target]').forEach(el=>el.classList.toggle('selected',el.dataset.target===$('target').value)));
$('auto').addEventListener('change',()=>{$('generate-label').textContent=$('auto').checked?'생성하고 자동 발행':'포스팅 생성하기';});
$('copy').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${post.title}\n\n${bodyText(post)}`);status('원고를 복사했어요');}catch{status('복사 권한을 확인해 주세요','TXT 저장으로 원고를 내려받을 수 있어요.',true);}});
$('download').addEventListener('click',()=>{const url=URL.createObjectURL(new Blob([`${post.title}\n\n${bodyText(post)}`],{type:'text/plain;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=`${post.title.replace(/[<>:"/\\|?*]/g,'_')}.txt`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
$('demo').addEventListener('click',()=>{
  post=normalizePost({title:'블로그 글쓰기, 첫 포스팅을 완성하는 4가지 방법',sections:[
    {heading:'1. 독자의 질문에서 시작하기',content:'블로그 글쓰기를 시작하려고 화면을 열었는데, 첫 문장부터 막막할 때가 있습니다. 이럴 때는 멋진 표현을 찾기보다 독자가 무엇을 궁금해할지 한 가지 질문을 적어보세요. 처음 시작하는 사람에게 필요한 준비물인지, 자주 겪는 문제의 해결 방법인지 정하면 이야기의 방향이 선명해집니다. 예를 들어 글을 쓰는 순서가 주제라면 실제로 따라 할 수 있는 단계부터 정리해보는 겁니다. 한 번에 모든 내용을 담으려 하기보다, 읽고 나서 하나라도 실행할 수 있는 글을 목표로 잡아보세요.'},
    {heading:'2. 제목에는 구체적인 약속 담기',content:'제목은 글의 내용을 짧게 소개하는 안내문과 같습니다. 핵심 키워드를 자연스럽게 넣고, 이 글에서 무엇을 얻을 수 있는지 함께 적어주세요. 막연히 도움이 되는 글이라고 말하기보다 대상이나 방법을 구체적으로 보여주면 좋습니다. 처음 쓰는 사람을 위한 작성 순서처럼 독자의 상황을 떠올릴 수 있는 표현을 골라보세요. 다만 본문에서 설명하지 않는 결과를 제목에 약속하면 기대와 내용이 달라집니다. 제목을 만든 다음에는 본문이 그 약속을 실제로 지키고 있는지 다시 읽어보는 과정도 필요합니다.'},
    {heading:'3. 한 소제목에는 한 가지 이야기',content:'본문을 길게 이어 쓰기 전에 이야기할 내용을 소제목으로 나눠보세요. 각 소제목은 그 아래에서 답할 질문 하나를 맡도록 구성하면 좋습니다. 설명을 먼저 적고 짧은 예시를 덧붙인 다음, 독자가 해볼 행동으로 문단을 마무리해보는 방식입니다. 같은 내용을 표현만 바꿔 반복하기보다 새로운 정보가 있는지 살펴보세요. 문장이 길어졌다면 두 문장으로 나누어 읽어보고, 없어도 뜻이 통하는 수식어는 덜어내도 좋습니다. 분량보다 중요한 것은 처음부터 끝까지 이야기가 자연스럽게 이어지는지 확인하는 일입니다.'},
    {heading:'4. 발행 전에는 소리 내어 읽기',content:'초안을 완성했다면 잠시 쉬었다가 독자의 입장에서 다시 읽어보세요. 소리 내어 읽으면 어색한 연결이나 너무 긴 문장을 발견하는 데 도움이 됩니다. 실제 경험과 예시가 구분되는지, 확인하지 않은 수치를 사실처럼 적지는 않았는지도 살펴보세요. 제목과 소제목만 훑어보아도 글의 흐름이 이해되는지 점검하면 구조를 정리하기가 쉽습니다. 마지막에는 독자가 바로 해볼 수 있는 작은 행동을 제안해보세요. 오늘은 주제 하나를 고르고 소제목부터 적는 것만으로도 첫 포스팅을 시작할 준비가 됩니다.'}
  ]});meta={keyword:'블로그 글쓰기',target:count(bodyText(post))};example=true;render();status('예시 원고를 보고 있어요','실제 생성 결과가 아니며 네이버에 발행되지 않습니다.');
});
probe();
