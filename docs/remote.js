// Same-origin only. The browser session token lives in memory, never localStorage/URLs.
export class RemoteBrowser {
  constructor(onChange) {this.token=null;this.available=false;this.onChange=onChange;this.imageURL=null;this.refreshing=false;this.polling=false;}
  async request(path, {method='GET',body,timeout=15000,binary=false}={}) {
    const response=await fetch(`./api/${path}`,{method,cache:'no-store',credentials:'omit',
      headers:{...(this.token?{Authorization:`Bearer ${this.token}`} : {}),...(body?{'Content-Type':'application/json'}:{})},
      body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeout)});
    if(!response.ok) {
      if(response.status===401){this.token=null;this.onChange?.(false);}
      let message='서버 연결에 실패했습니다.';
      try{const data=await response.json();if(typeof data.detail==='string')message=data.detail;else if(response.status===422)message='입력한 원고와 설정을 확인해 주세요.';}catch{}
      throw new Error(message);
    }
    return binary?response.blob():response.json();
  }
  async config() {
    try {const r=await fetch('./config.json',{cache:'no-store'});const data=await r.json();this.available=data.mode==='server';}catch{this.available=false;}
    return this.available;
  }
  async ready() {if(!this.available||!this.token)throw new Error('설정에서 네이버 로그인 화면을 열고 글쓰기를 준비해 주세요.');await this.request('browser/ready');}
  async open(code) {
    if(!this.available)throw new Error('자동 발행 서버가 아직 연결되지 않았습니다. 현재는 원고 작성 모드입니다.');
    if(!this.token){const result=await this.request('session',{method:'POST',body:{code}});this.token=result.token;}
    await this.request('browser',{method:'POST',timeout:45000});
  }
  async input(payload){await this.request('browser/input',{method:'POST',body:payload});}
  async writer(blogId){await this.request('browser/writer',{method:'POST',body:{blogId},timeout:40000});}
  async close(){if(this.token)await this.request('session',{method:'DELETE'});this.token=null;this.clearImage();this.onChange?.(false);}
  clearImage(){if(this.imageURL)URL.revokeObjectURL(this.imageURL);this.imageURL=null;}
  bind({config,report}) {
    const $=id=>document.getElementById(id), screen=$('remote-screen');
    const action=async fn=>{try{await fn();await this.refresh();}catch(e){$('remote-state').textContent=e.message;}};
    this.refresh=async()=>{
      if(this.refreshing||!this.token||!$('remote').open)return;
      this.refreshing=true;
      try{const blob=await this.request('browser/screen',{binary:true});const old=this.imageURL;this.imageURL=URL.createObjectURL(blob);screen.src=this.imageURL;if(old)URL.revokeObjectURL(old);
        let ready=false;try{await this.ready();ready=true;}catch{}
        this.onChange?.(ready);$('remote-state').textContent=ready?'글쓰기 화면 준비됨':'네이버 로그인 후 ‘글쓰기 열기’를 눌러 주세요.';
      }catch(e){$('remote-state').textContent=e.message;}finally{this.refreshing=false;}
    };
    screen.addEventListener('click',event=>action(async()=>{const r=screen.getBoundingClientRect();await this.input({kind:'click',x:Math.max(0,Math.min(1100,(event.clientX-r.left)/r.width*1100)),y:Math.max(0,Math.min(760,(event.clientY-r.top)/r.height*760))});$('remote-text').focus();}));
    screen.addEventListener('wheel',event=>{event.preventDefault();if(!this.scrolling){this.scrolling=true;action(()=>this.input({kind:'scroll',delta:Math.max(-760,Math.min(760,Math.round(event.deltaY)))})).finally(()=>this.scrolling=false);}},{passive:false});
    screen.addEventListener('keydown',event=>{if(['Enter','Tab','Backspace','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();action(()=>this.input({kind:'key',key:event.key}));}});
    $('remote-input').addEventListener('submit',event=>{event.preventDefault();const text=$('remote-text').value;$('remote-text').value='';if(text)action(()=>this.input({kind:'text',text}));});
    $('remote-enter').addEventListener('click',()=>action(()=>this.input({kind:'key',key:'Enter'})));
    $('remote-backspace').addEventListener('click',()=>action(()=>this.input({kind:'key',key:'Backspace'})));
    $('remote-refresh').addEventListener('click',()=>this.refresh());
    $('remote-writer').addEventListener('click',()=>action(()=>this.writer(config().blogId)));
    $('remote-disconnect').addEventListener('click',()=>action(async()=>{await this.close();$('remote').close();report('네이버 연결을 종료했어요','서버의 로그인 세션이 삭제되었습니다.');}));
    $('remote').addEventListener('close',()=>{$('remote-text').value='';screen.removeAttribute('src');this.clearImage();});
    setInterval(()=>this.refresh(),1800);
  }
}
