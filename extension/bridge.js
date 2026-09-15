(() => {
  const allowed = new Set(['PING','OPEN','START','STOP','STATUS']);
  if(location.origin !== 'https://chaemuneki-byte.github.io' || !location.pathname.startsWith('/naver-blog-studio-web/')) return;
  window.addEventListener('message', async event => {
    const message=event.data;
    if(event.source!==window || event.origin!==location.origin || message?.channel!=='BLOG_STUDIO_REQUEST' || !allowed.has(message.type) || typeof message.id!=='string') return;
    try {
      const result=await chrome.runtime.sendMessage({type:message.type,payload:message.payload});
      window.postMessage({channel:'BLOG_STUDIO_RESPONSE',id:message.id,...result},location.origin);
    }catch{
      window.postMessage({channel:'BLOG_STUDIO_RESPONSE',id:message.id,ok:false,error:'연결 확장을 다시 로드한 뒤 웹페이지를 새로고침해 주세요.'},location.origin);
    }
  });
})();
