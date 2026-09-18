"""Run from repo root: python -m unittest discover -s tests -p server_test.py -v"""
import asyncio
import tempfile
import unittest
from fastapi.testclient import TestClient
from playwright.async_api import async_playwright
from server.app import create_app, allowed_url, Session
from server.automation import Journal, run_job, fingerprint, post_url, writer_url
from server.models import StartJob

CODE = "test-only-code-with-32-characters"
ORIGIN = "http://127.0.0.1:8000"


def payload(**changes):
    data = {"blogId": "fixture", "speed": 80, "target": 500, "keyword": "블로그",
            "post": {"title": "블로그 글쓰기의 기본 원칙", "sections": [
                {"heading": "1. 시작하기", "content": "가" * 243},
                {"heading": "2. 마무리", "content": "나" * 244}]}, "publish": False}
    data.update(changes)
    return StartJob.model_validate(data)


class BoundaryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.app = create_app(code=CODE, origin=ORIGIN, data_dir=self.tmp.name)
        self.client = TestClient(self.app)
        self.client.__enter__()
        self.headers = {"Origin": ORIGIN}

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.tmp.cleanup()

    def token(self):
        return self.client.post('/api/session', json={"code": CODE}, headers=self.headers).json()['token']

    def test_configuration_and_auth_required(self):
        self.assertEqual(self.client.get('/config.json').json()['mode'], 'server')
        self.assertEqual(self.client.get('/api/browser/screen').status_code, 401)
        token = self.token()
        h = {**self.headers, "Authorization": f"Bearer {token}"}
        self.assertEqual(self.client.get('/api/browser/screen', headers=h).status_code, 409)
        self.assertEqual(self.client.delete('/api/session', headers=h).status_code, 200)
        self.assertEqual(self.client.get('/api/browser/screen', headers=h).status_code, 401)

    def test_origin_and_validation_never_echo_credentials(self):
        self.assertEqual(self.client.post('/api/session', json={"code": CODE}).status_code, 403)
        self.assertEqual(self.client.post('/api/session', json={"code": CODE}, headers={"Origin": "https://evil.example"}).status_code, 403)
        r = self.client.post('/api/session', json={"code": CODE, "extra": "secret"}, headers=self.headers)
        self.assertEqual(r.status_code, 422)
        self.assertNotIn(CODE, r.text)
        self.assertNotIn('secret', r.text)

    def test_login_limit_and_session_limit(self):
        for _ in range(10):
            self.assertEqual(self.client.post('/api/session', json={"code": "wrong"}, headers=self.headers).status_code, 401)
        self.assertEqual(self.client.post('/api/session', json={"code": CODE}, headers=self.headers).status_code, 429)

    def test_independent_tokens_and_capacity(self):
        one, two = self.token(), self.token()
        self.assertNotEqual(one, two)
        self.assertEqual(self.client.post('/api/session', json={"code": CODE}, headers=self.headers).status_code, 409)
        self.client.delete('/api/session', headers={**self.headers, "Authorization": f"Bearer {one}"})
        self.assertEqual(self.client.get('/api/browser/screen', headers={"Authorization": f"Bearer {two}"}).status_code, 409)

    def test_large_actual_body_rejected(self):
        r = self.client.post('/api/session', content=b'a' * 100001, headers=self.headers)
        self.assertEqual(r.status_code, 413)

    def test_network_allowlist(self):
        for url in ['https://nid.naver.com/nidlogin.login', 'https://ssl.pstatic.net/image.png']:
            self.assertTrue(allowed_url(url))
        for url in ['http://nid.naver.com/', 'https://naver.com.evil.test/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://nid.naver.com:8443/']:
            self.assertFalse(allowed_url(url))

    def test_server_revalidates_post_and_owner_urls(self):
        self.assertEqual(payload().target, 500)
        bad = payload().model_dump();bad['post']['sections'][0]['content'] = 'short'
        with self.assertRaises(ValueError):
            StartJob.model_validate(bad)
        self.assertTrue(post_url('https://blog.naver.com/fixture/123456', 'fixture'))
        self.assertFalse(post_url('https://blog.naver.com/other/123456', 'fixture'))
        self.assertTrue(writer_url('https://blog.naver.com/fixture/postwrite', 'fixture'))
        self.assertFalse(writer_url('https://blog.naver.com/other/postwrite', 'fixture'))


FIXTURE = '''<!doctype html><html><meta charset="utf-8"><body>
<div class="se-documentTitle"><div class="se-text-paragraph" contenteditable="true"></div></div>
<div class="se-component se-text"><div class="se-text-paragraph" contenteditable="true"></div></div>
<button data-click-area="tpb.publish" onclick="document.querySelector('#confirm').hidden=false">발행</button>
<button id="confirm" data-click-area="tpb*i.publish" hidden onclick="location.href='https://blog.naver.com/fixture/123456'">확인</button>
</body></html>'''


class AdapterTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.journal = Journal(self.tmp.name + '/journal.db')
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(channel='msedge', headless=True)
        self.context = await self.browser.new_context()
        async def route(r):
            if r.request.url == 'https://blog.naver.com/fixture/123456':
                await r.fulfill(body='<div class="se-title-text">블로그 글쓰기의 기본 원칙</div>', content_type='text/html; charset=utf-8')
            else:
                await r.fulfill(body=FIXTURE, content_type='text/html; charset=utf-8')
        await self.context.route('**/*', route)
        self.page = await self.context.new_page()
        await self.page.goto('https://blog.naver.com/fixture/postwrite')
        self.session = Session(context=self.context, page=self.page, job={"progress": 0})

    async def asyncTearDown(self):
        await self.browser.close()
        await self.pw.stop()
        self.tmp.cleanup()

    async def test_sequential_korean_input_then_publish_and_duplicate_block(self):
        p = payload()
        await run_job(self.session, p, self.journal)
        self.assertEqual(self.session.job['status'], 'typed')
        self.assertEqual(await self.page.locator('.se-documentTitle').inner_text(), p.post.title)
        p.publish = True
        await run_job(self.session, p, self.journal)
        self.assertEqual(self.session.job['status'], 'published')
        self.assertEqual(self.session.job['url'], 'https://blog.naver.com/fixture/123456')
        await run_job(self.session, p, self.journal)
        self.assertEqual(self.session.job['status'], 'error')

    async def test_existing_draft_is_preserved(self):
        await self.page.locator('.se-documentTitle .se-text-paragraph').fill('기존 원고')
        await run_job(self.session, payload(publish=True), self.journal)
        self.assertEqual(self.session.job['status'], 'error')
        self.assertEqual(await self.page.locator('.se-documentTitle').inner_text(), '기존 원고')
        self.assertFalse(self.journal.has(fingerprint(payload())))

    async def test_stop_during_typing_prevents_publication(self):
        task = asyncio.create_task(run_job(self.session, payload(publish=True), self.journal))
        await asyncio.sleep(.3)
        self.session.stop.set()
        await task
        self.assertEqual(self.session.job['status'], 'stopped')
        self.assertFalse(self.journal.has(fingerprint(payload())))

    async def test_durable_reservation_survives_restart(self):
        key = fingerprint(payload())
        self.journal.reserve(key)
        restarted = Journal(self.tmp.name + '/journal.db')
        await run_job(self.session, payload(publish=True), restarted)
        self.assertEqual(self.session.job['status'], 'error')
        self.assertEqual(await self.page.locator('.se-documentTitle').inner_text(), '')


if __name__ == '__main__':
    unittest.main(verbosity=2)
