"""Offline fixture tests, never contacts Naver or OpenAI. Requires playwright."""
import json
from pathlib import Path
import unittest
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parent.parent
HTML='''<!doctype html><meta charset="utf-8"><div class="se-documentTitle"><p class="se-text-paragraph" contenteditable="true"></p></div>
<div class="se-component se-text"><div class="se-text-paragraph" contenteditable="true"></div></div>
<button data-click-area="tpb.publish" onclick="document.getElementById('confirm').hidden=false">발행</button>
<button id="confirm" hidden data-click-area="tpb*i.publish" onclick="window.finalClicks++">발행</button>'''
MOCK='''window.events=[];window.finalClicks=0;window.handlers=[];
window.chrome={runtime:{id:'fixture',onMessage:{addListener:f=>handlers.push(f)},sendMessage:async message=>{events.push(message);if(message.type==='WILL_PUBLISH'&&window.rejectPublish)return {ok:false,error:'중지됨'};return {ok:true,result:{ok:true}};}}};
const originalTimeout=window.setTimeout;window.setTimeout=(fn,ms)=>originalTimeout(fn,Math.min(ms,1));'''


class NaverFixture(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(channel='msedge',headless=True)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close();cls.pw.stop()

    def setUp(self):
        self.context=self.browser.new_context()
        self.context.route('**/*',lambda route:route.abort())
        self.page=self.context.new_page();self.page.set_content(HTML)
        self.page.add_script_tag(content=MOCK)
        self.page.add_script_tag(content=(ROOT/'extension'/'naver.js').read_text('utf-8'))
        self.job={'id':'test-job','speed':80,'publish':True,'post':{'title':'블로그 한글 입력 😀 테스트','sections':[{'heading':'1. 시작하기','content':'가나다 라마바. '*25},{'heading':'2. 마무리하기','content':'다음 내용을 확인해 보세요. '*15}]}}

    def tearDown(self):
        self.context.close()

    def start(self):
        self.page.evaluate("job=>handlers[0]({type:'EXECUTE',job},{id:'fixture'},result=>window.ack=result)",self.job)

    def wait(self):
        self.page.wait_for_function("finalClicks===1||events.some(e=>e.type==='FAILED'||e.type==='TYPED')",timeout=15000)

    def test_unicode_typing_and_single_final_click(self):
        self.start();self.wait()
        self.assertEqual(self.page.evaluate('finalClicks'),1)
        events=self.page.evaluate('events')
        self.assertEqual(sum(e['type']=='WILL_PUBLISH' for e in events),1)
        self.assertFalse(any(e['type']=='FAILED' for e in events))
        self.assertEqual(self.page.locator('.se-documentTitle').inner_text(),self.job['post']['title'])

    def test_existing_draft_not_overwritten(self):
        self.page.locator('.se-documentTitle p').fill('기존 원고')
        self.start();self.wait()
        self.assertEqual(self.page.evaluate('finalClicks'),0)
        self.assertEqual(self.page.locator('.se-documentTitle').inner_text(),'기존 원고')

    def test_input_only_does_not_publish(self):
        self.job['publish']=False;self.start();self.wait()
        self.assertEqual(self.page.evaluate('finalClicks'),0)
        self.assertTrue(self.page.evaluate("events.some(e=>e.type==='TYPED')"))

    def test_denied_publish_ack_prevents_click(self):
        self.page.evaluate('window.rejectPublish=true')
        self.start();self.wait()
        self.assertEqual(self.page.evaluate('finalClicks'),0)

    def test_cancellation_before_input_stops(self):
        self.start()
        self.page.evaluate("handlers[0]({type:'STOP',id:'test-job'},{id:'fixture'},()=>{})")
        self.wait();self.assertEqual(self.page.evaluate('finalClicks'),0)


if __name__=='__main__':unittest.main(verbosity=2)
