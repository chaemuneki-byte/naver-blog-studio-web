"""Intercept every external request; test the server-mode UI without accounts."""
import json
import unittest
from playwright.sync_api import sync_playwright, expect


class RemoteWebTests(unittest.TestCase):
    def test_login_screen_input_auto_job_and_secret_lifetime(self):
        with sync_playwright() as p:
            browser = p.chromium.launch(channel='msedge', headless=True)
            context = browser.new_context(viewport={'width': 1280, 'height': 900})
            image_page = context.new_page()
            image_page.set_viewport_size({'width': 1100, 'height': 760})
            image_page.set_content('<p>LOCAL FIXTURE: login input</p>')
            screenshot = image_page.screenshot()
            image_page.close()
            ready = False
            inputs, jobs, errors = [], [], []
            post = {'title': '블로그 글쓰기의 기본 원칙', 'sections': [
                {'heading': '1. 시작하기', 'content': '가' * 243},
                {'heading': '2. 마무리', 'content': '나' * 244}]}
            def route(r):
                nonlocal ready
                url = r.request.url
                data = {'ok': True}
                if url.endswith('/config.json'):
                    data = {'mode': 'server'}
                elif '/api/' in url:
                    endpoint = url.split('/api/')[1]
                    if endpoint == 'session':
                        if r.request.method == 'POST':
                            self.assertEqual(r.request.post_data_json['code'], 'fixture-access-code')
                            data = {'token': 'fixture-session-token'}
                    else:
                        self.assertEqual(r.request.headers.get('authorization'), 'Bearer fixture-session-token')
                        if endpoint == 'browser/screen':
                            r.fulfill(body=screenshot, content_type='image/png');return
                        if endpoint == 'browser/ready' and not ready:
                            r.fulfill(status=409, content_type='application/json', body=json.dumps({'detail': '로그인 필요'}));return
                        if endpoint == 'browser/writer':
                            self.assertEqual(r.request.post_data_json['blogId'], 'fixture');ready = True
                        if endpoint == 'browser/input':inputs.append(r.request.post_data_json)
                        if endpoint == 'jobs':jobs.append(r.request.post_data_json);data = {'id': 'test-job'}
                        if endpoint == 'jobs/test-job':data = {'id': 'test-job', 'status': 'published', 'progress': 100, 'message': '발행을 확인했어요', 'url': 'https://blog.naver.com/fixture/123456'}
                elif url == 'https://api.openai.com/v1/responses':
                    if r.request.method == 'OPTIONS':
                        r.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'POST'});return
                    data = {'status': 'completed', 'output': [{'type': 'message', 'content': [{'type': 'output_text', 'text': json.dumps(post)}]}]}
                    r.fulfill(content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps(data));return
                elif url.startswith('http://127.0.0.1:4173/'):
                    r.continue_();return
                else:
                    r.abort();return
                r.fulfill(content_type='application/json', body=json.dumps(data))
            context.route('**/*', route)
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto('http://127.0.0.1:4173/')
            page.locator('#settings-nav').click()
            page.locator('#api-key').fill('fixture-api-key')
            page.locator('#blog-id').fill('fixture')
            page.locator('#access-code').fill('fixture-access-code')
            page.locator('#open-naver').click()
            page.locator('#remote-screen').wait_for(state='visible')
            page.locator('#remote-text').fill('fixture-login-secret')
            page.locator('#remote-input .primary').click()
            expect(page.locator("#remote-text")).to_have_value("")
            page.locator('#remote-writer').click()
            expect(page.locator("#remote-state")).to_have_text("글쓰기 화면 준비됨")
            page.locator('#remote .dialog-head button').click()
            self.assertEqual(inputs[0], {'kind': 'text', 'text': 'fixture-login-secret'})
            page.locator('#keyword').fill('블로그');page.locator('#target').fill('500')
            page.locator('#auto').check();page.locator('#generate').click()
            expect(page.locator("#status")).to_have_text("발행을 확인했어요", timeout=10000)
            self.assertEqual(len(jobs), 1)
            self.assertTrue(jobs[0]['publish'])
            self.assertEqual(jobs[0]['post'], post)
            self.assertNotIn('fixture-', page.evaluate('JSON.stringify(localStorage)'))
            self.assertEqual(page.locator('#access-code').input_value(), '')
            self.assertEqual(errors, [])
            browser.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
