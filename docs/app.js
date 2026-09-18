import {RemoteBrowser} from './remote.js';
import {bodyText, clean, count, generate, normalizePost, validate} from './core.js';
const $ = id => document.getElementById(id);
let post = null, meta = null, example = false, busy = false, controller = null, connected = false, serverJob = null;
const remote=new RemoteBrowser(value=>{connected=value;updateConnection();updateStats();});
const settingsFields = ['blog-id','model','speed'];
try { const saved=JSON.parse(localStorage.getItem('blog-studio-settings')||'{}'); for(const id of settingsFields) if(saved[id]) $(id).value=saved[id]; } catch {}
async function bridge(type,payload={}) {
  if(type==='PING'){await remote.ready();return {ok:true};}
  if(type==='START')return remote.request('jobs',{method:'POST',body:payload,timeout:20000});
  if(type==='STATUS')return remote.request(`jobs/${encodeURIComponent(payload.id)}`);
  if(type==='STOP')return remote.request(`jobs/${encodeURIComponent(payload.id)}/stop`,{method:'POST'});
  throw new Error('지원하지 않는 작업입니다.');
}
function updateConnection(){
  $('connection').classList.toggle('connected',connected);
  $('connection').querySelector('span').textContent=connected?'네이버 연결됨':remote.available?'네이버 연결':'원고 작성 모드';
  $('auto').disabled=busy||!connected;
  if(!connected){$('auto').checked=false;$('generate-label').textContent='원고 만들기';}
  $('auto-hint').textContent=connected?'원고 완성 후 네이버에 바로 발행':'네이버 연결 후 사용할 수 있어요';
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
  updateConnection();
}
function config() {
  const blogId=$('blog-id').value.trim(), speed=Number($('speed').value);
  if(!/^[A-Za-z0-9_-]{1,64}$/.test(blogId)) throw new Error('연결 설정에 본인의 블로그 ID를 입력해 주세요.');
  if(!Number.isInteger(speed)||speed<1||speed>80) throw new Error('입력 속도는 초당 1~80자의 정수로 설정해 주세요.');
  return {blogId,speed};
}
function updateStats() {
  const errors=post?validate(post,meta.target,meta.keyword):[];
  $('total').textContent=post?count(bodyText(post)).toLocaleString():'0';
  $('section-total').textContent=`소제목 ${post?.sections.length||0}개`;
  $('validation').textContent=post?(errors.length?errors.join(' '):'✓ 목표 분량과 소제목별 200~300자 조건을 충족했습니다.') : '';
  $('validation').classList.toggle('ok',!errors.length);
  for(const id of ['download','copy']) $(id).disabled=!post;
  for(const id of ['type','publish']) $(id).disabled=!post||busy||example||!connected||!!errors.length;
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
  await remote.config();
  $('server-notice').hidden=remote.available;
  $('access-fields').hidden=!remote.available;
  $('open-naver').disabled=!remote.available;
  $('server-description').textContent=remote.available?'설치 없이 이 웹 안에서 네이버에 로그인하세요. 연결 종료 시 서버의 로그인 세션이 삭제됩니다.':'자동 발행 서버가 아직 연결되지 않았습니다. 현재는 원고 생성·수정·복사를 사용할 수 있습니다.';
  try{await remote.ready();connected=true;}catch{connected=false;}
  updateConnection();updateStats();
}
async function ensureBridge() {await bridge('PING',{},1800);connected=true;}
async function sendToNaver(publish) {
  if(!post||example) throw new Error('실제 원고를 먼저 생성해 주세요. 예시 원고는 발행할 수 없습니다.');
  const candidate=normalizePost(post), errors=validate(candidate,meta.target,meta.keyword);
  if(errors.length) throw new Error(errors.join(' '));
  const connection=config();
  await ensureBridge();
  controller?.signal.throwIfAborted();
  const result=await bridge('START',{...connection,post:candidate,keyword:meta.keyword,target:meta.target,publish},15000);
  serverJob=result.id;setBusy(true);
  if(controller?.signal.aborted){await bridge('STOP',{id:serverJob});return;}
  status('네이버 편집기를 연결하고 있어요','연결 화면에서 서버 브라우저의 입력 과정을 볼 수 있습니다.');
}
$('generate').addEventListener('click',async()=>{
  if(busy) return;
  const keyword=clean($('keyword').value), target=Number($('target').value), auto=$('auto').checked;
  try {
    setBusy(true);
    controller=new AbortController();
    if(auto){config();await ensureBridge();}
    controller.signal.throwIfAborted();
    if(!$('api-key').value.trim()){$('settings').showModal();throw new Error('OpenAI API 키를 입력한 뒤 다시 생성해 주세요.');}
    $('progress').value=5;
    const result=await generate({key:$('api-key').value,model:$('model').value.trim(),keyword,target,facts:$('facts').value,
      signal:controller.signal,onProgress:message=>status(message,'조건에 맞는 자연스러운 원고를 작성하고 있어요.')});
    post=result;meta={keyword,target};example=false;render();$('progress').value=100;
    status('원고가 완성됐어요',`${count(bodyText(post)).toLocaleString()}자 · 내용을 수정하거나 네이버에 입력할 수 있어요.`);
    if(auto){controller.signal.throwIfAborted();await sendToNaver(true);}
  } catch(error){status(error.name==='AbortError'?'글 생성을 중지했어요':'작업을 완료하지 못했어요',error.message,error.name!=='AbortError');}
  finally {controller=null;if(!serverJob)setBusy(false);}
});
$('title').addEventListener('input',()=>{if(post){post.title=$('title').value;updateStats();}});
for(const [id,publish] of [['type',false],['publish',true]]) $(id).addEventListener('click',async()=>{
  if(busy)return;setBusy(true);
  controller=new AbortController();
  try {await sendToNaver(publish);}catch(error){status('네이버 연결을 확인해 주세요',error.message,true);setBusy(false);}
  finally{controller=null;}
});
$('stop').addEventListener('click',async()=>{
  controller?.abort();
  if(serverJob) try {await bridge('STOP',{id:serverJob});status('중지를 요청했어요','발행 요청이 이미 전송됐다면 블로그에서 게시 여부를 확인해 주세요.');} catch(error){status('중지 상태를 확인할 수 없어요',error.message,true);}
});
let pollingJob=false;
setInterval(async()=>{
  if(!serverJob||pollingJob) return;
  pollingJob=true;
  try {
    const job=await bridge('STATUS',{id:serverJob});
    if(!job)throw new Error('연결 작업 기록이 없습니다. 네이버에서 게시 여부를 확인해 주세요.');
    $('progress').value=job.progress||0;status(job.message,job.detail||'',['error','unknown'].includes(job.status));
    if(['published','typed','error','stopped','unknown'].includes(job.status)){
      serverJob=null;setBusy(false);
      if(job.url && /^https:\/\/blog\.naver\.com\//.test(job.url)){const a=document.createElement('a');a.href=job.url;a.target='_blank';a.rel='noopener';a.textContent='발행된 글 확인 ↗';$('status-detail').replaceChildren(a);}
    }
  }catch(error){status('작업 상태를 다시 확인하고 있어요',`${error.message} 서버 작업은 계속될 수 있습니다.`,true);if(!remote.token){serverJob=null;setBusy(false);}}finally{pollingJob=false;}
},1800);
for(const id of ['settings-nav','connection']) $(id).addEventListener('click',()=>{$('settings').showModal();probe();});
$('help-nav').addEventListener('click',()=>$('guide').showModal());
$('write-nav').addEventListener('click',()=>{$('keyword').focus();window.scrollTo({top:0,behavior:'smooth'});});
$('server-info').addEventListener('click',()=>$('guide').showModal());
$('save-settings').addEventListener('click',()=>{
  try {
    const speed=Number($('speed').value);if(speed<1||speed>80||!Number.isInteger(speed))throw new Error('입력 속도는 1~80자의 정수로 설정해 주세요.');
    localStorage.setItem('blog-studio-settings',JSON.stringify(Object.fromEntries(settingsFields.map(id=>[id,$(id).value.trim()]))));
    $('settings').close();status('설정을 적용했어요','API 키는 이 탭을 닫거나 새로고침하면 지워집니다.');probe();
  }catch(error){status('설정을 저장하지 못했어요',error.message,true);}
});
$('open-naver').addEventListener('click',async()=>{
  $('open-naver').disabled=true;
  try {
    await remote.open($('access-code').value);$('access-code').value='';
    $('settings').close();$('remote').showModal();await remote.refresh();
    status('네이버 로그인 화면을 열었어요','로그인 후 ‘글쓰기 열기’를 눌러 주세요.');
  }catch(error){$('server-description').textContent=error.message;status('네이버 연결을 확인해 주세요',error.message,true);}
  finally{$('open-naver').disabled=!remote.available;}
});
remote.bind({config,report:status});
window.addEventListener('beforeunload',event=>{if(busy){event.preventDefault();event.returnValue='';}});

document.querySelectorAll('[data-target]').forEach(button=>button.addEventListener('click',()=>{
  $('target').value=button.dataset.target;document.querySelectorAll('[data-target]').forEach(el=>el.classList.toggle('selected',el===button));
}));
$('target').addEventListener('input',()=>document.querySelectorAll('[data-target]').forEach(el=>el.classList.toggle('selected',el.dataset.target===$('target').value)));
$('auto').addEventListener('change',()=>{$('generate-label').textContent=$('auto').checked?'생성하고 자동 발행':'원고 만들기';});
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
