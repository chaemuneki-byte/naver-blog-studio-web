"""Web UI with an intercepted API response. No real API key or API traffic."""
import json
import unittest
from playwright.sync_api import sync_playwright


class WebFixture(unittest.TestCase):
    def test_generation_edit_validation_and_key_not_persisted(self):
        with sync_playwright() as p:
            browser=p.chromium.launch(channel='msedge',headless=True)
            context=browser.new_context(viewport={'width':1280,'height':900})
            post={'title':'블로그 글쓰기의 기본 원칙','sections':[{'heading':'1. 시작하기','content':'가'*243},{'heading':'2. 마무리','content':'나'*244}]}
            requests=[]
            def route_request(route):
                if route.request.url.startswith('http://127.0.0.1:4173/'):
                    route.continue_()
                elif route.request.url=='https://api.openai.com/v1/responses':
                    if route.request.method=='OPTIONS':
                        route.fulfill(status=204,headers={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,content-type','Access-Control-Allow-Methods':'POST'})
                    else:
                        requests.append(route.request.post_data_json)
                        route.fulfill(status=200,content_type='application/json',headers={'Access-Control-Allow-Origin':'*'},body=json.dumps({'status':'completed','output':[{'type':'message','content':[{'type':'output_text','text':json.dumps(post)}]}]}))
                else:
                    route.abort()
            context.route('**/*',route_request)
            page=context.new_page();page.goto('http://127.0.0.1:4173/')
            page.locator('#settings-nav').click();page.locator('#api-key').fill('fixture-only-not-a-real-key');page.locator('#save-settings').click()
            page.locator('#keyword').fill('블로그');page.locator('#target').fill('500');page.locator('#generate').click()
            page.wait_for_function("document.querySelector('#draft-badge').textContent==='작성 완료'")
            self.assertEqual(len(requests),1)
            self.assertEqual(page.locator('#title').input_value(),post['title'])
            self.assertTrue(page.locator('#publish').is_enabled())
            page.locator('.section-content').first.fill('짧음')
            self.assertFalse(page.locator('#publish').is_enabled())
            self.assertIn('200~300',page.locator('#validation').inner_text())
            self.assertNotIn('fixture-only',page.evaluate('JSON.stringify(localStorage)'))
            page.set_viewport_size({'width':390,'height':844})
            self.assertTrue(page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
            page.reload();page.locator('#connection').click()
            self.assertEqual(page.locator('#api-key').input_value(),'')
            browser.close()


if __name__=='__main__':unittest.main(verbosity=2)
