import test from 'node:test';import assert from 'node:assert/strict';
let seq=0;
async function fixture(){
  const state={session:{},local:{}},handlers=[];
  const area=name=>({get:async key=>({[key]:structuredClone(state[name][key])}),set:async value=>Object.assign(state[name],structuredClone(value))});
  globalThis.chrome={storage:{session:area('session'),local:area('local')},
    runtime:{onMessage:{addListener:fn=>handlers.push(fn)}},
    tabs:{query:async()=>[],create:async()=>({id:99}),update:async()=>{},sendMessage:async()=>({ok:true}),onUpdated:{addListener:()=>{}},onRemoved:{addListener:()=>{}}},
    scripting:{executeScript:async()=>[{frameId:0,result:{ready:true,url:'https://blog.naver.com/myblog/postwrite'}}]},action:{onClicked:{addListener:()=>{}}}};
  await import(`../extension/background.js?test=${seq++}`);
  const studio={tab:{id:7},frameId:0,url:'https://chaemuneki-byte.github.io/naver-blog-studio-web/'};
  const send=(message,sender=studio)=>new Promise(resolve=>handlers[0](message,sender,resolve));
  const input={blogId:'myblog',speed:18,publish:true,keyword:'블로그',target:500,post:{title:'블로그 글쓰기의 기본 원칙',sections:[{heading:'1. 시작하기',content:'가'.repeat(243)},{heading:'2. 마무리',content:'나'.repeat(244)}]}};
  async function start(publish=true){const result=await send({type:'START',payload:{...input,publish}});assert.equal(result.ok,true);for(let i=0;i<20&&state.session.job.status!=='typing';i++)await new Promise(r=>setTimeout(r,5));return state.session.job;}
  return {state,send,start,studio,input,naver:{tab:{id:99},frameId:0,url:'https://blog.naver.com/myblog/postwrite'}};
}
test('확장: 다른 도메인 요청 거부',async()=>{const f=await fixture();const r=await f.send({type:'PING'}, {...f.studio,url:'https://evil.test/'});assert.equal(r.ok,false);});
test('확장: 입력만 모드에서는 최종 발행 승인 거부',async()=>{const f=await fixture(),job=await f.start(false);const r=await f.send({type:'WILL_PUBLISH',id:job.id},f.naver);assert.equal(r.ok,false);assert.deepEqual(f.state.local,{});});
test('확장: 발행 승인 전에 기록하고 재승인/중복 원고 거부',async()=>{const f=await fixture(),job=await f.start();const r=await f.send({type:'WILL_PUBLISH',id:job.id},f.naver);assert.equal(r.ok,true);assert.equal(f.state.local[job.fingerprint].state,'publishing');assert.equal(f.state.session.job.status,'publishing');assert.equal((await f.send({type:'WILL_PUBLISH',id:job.id},f.naver)).ok,false);f.state.session.job.status='error';const duplicate=await f.send({type:'START',payload:f.input});assert.equal(duplicate.ok,false);assert.match(duplicate.error,/중복/);});
test('확장: 다른 탭과 프레임의 작업 접근 거부',async()=>{const f=await fixture(),job=await f.start();assert.equal((await f.send({type:'STATUS',payload:{id:job.id}},{...f.studio,tab:{id:8}})).ok,false);assert.equal((await f.send({type:'WILL_PUBLISH',id:job.id},{...f.naver,frameId:1})).ok,false);});
test('확장: 중지 후 늦은 진행 이벤트가 작업을 되살리지 않음',async()=>{const f=await fixture(),job=await f.start();await f.send({type:'STOP',payload:{id:job.id}});await f.send({type:'PROGRESS',id:job.id,progress:20},f.naver);assert.equal(f.state.session.job.status,'stopped');assert.equal((await f.send({type:'WILL_PUBLISH',id:job.id},f.naver)).ok,false);});
