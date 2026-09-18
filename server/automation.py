"""Naver editor adapter. Live selector compatibility still needs an account test."""
import asyncio
from contextlib import contextmanager
import hashlib
import json
import re
import sqlite3
from urllib.parse import urlparse, parse_qs
from .models import clean

TITLE = ".se-documentTitle .se-text-paragraph"
BODY = ".se-component.se-text .se-text-paragraph"
PUBLISH = 'button[data-click-area="tpb.publish"],button[class*="publish_btn"]'
CONFIRM = 'button[data-click-area="tpb*i.publish"],button[class*="confirm_btn"]'


def fingerprint(payload):
    data = {"blog": payload.blogId.lower(), "post": payload.post.model_dump()}
    return hashlib.sha256(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class Journal:
    def __init__(self, path):
        self.path = str(path)
        with self.connect() as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS publication (hash TEXT PRIMARY KEY, state TEXT, url TEXT)")

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.path)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def has(self, key):
        with self.connect() as conn:
            return conn.execute("SELECT state FROM publication WHERE hash=?", (key,)).fetchone() is not None

    def reserve(self, key):
        # Commit BEFORE clicking: restart/timeout must never trigger a duplicate click.
        with self.connect() as conn:
            conn.execute("INSERT INTO publication VALUES (?, 'attempted', '')", (key,))

    def published(self, key, url):
        with self.connect() as conn:
            conn.execute("UPDATE publication SET state='published', url=? WHERE hash=?", (url, key))


def check_stop(session):
    if session.stop.is_set():
        raise InterruptedError("작업을 중지했습니다.")


async def editor(page):
    for frame in page.frames:
        if await frame.locator(TITLE).count() and await frame.locator(TITLE).first.is_visible():
            return frame
    raise ValueError("네이버 로그인을 완료하고 빈 글쓰기 화면을 열어 주세요.")


def writer_url(url, blog_id):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "blog.naver.com":
        return False
    if parsed.path.lower().rstrip("/") == f"/{blog_id}/postwrite".lower():
        return True
    query = parse_qs(parsed.query)
    return (parsed.path in ("/PostWriteForm.naver", "/PostWriteFormSe.naver")
            and query.get("blogId", [""])[0].lower() == blog_id.lower())


async def contents(frame, selector):
    return clean(" ".join(await frame.locator(selector).all_inner_texts()))


async def type_text(session, text, speed, start, span):
    # Unicode code points preserve Korean; keyboard.type's ASCII limitation is avoided.
    for i, char in enumerate(text):
        check_stop(session)
        if char == "\n":
            await session.page.keyboard.press("Enter")
        else:
            await session.page.keyboard.insert_text(char)
        session.job["progress"] = round(start + span * (i + 1) / len(text))
        try:
            await asyncio.wait_for(session.stop.wait(), timeout=1 / speed)
        except TimeoutError:
            pass
    check_stop(session)


def post_url(url, blog_id):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname != "blog.naver.com":
        return False
    if re.fullmatch(r"/" + re.escape(blog_id) + r"/\d+/?", parsed.path, re.I):
        return True
    query = parse_qs(parsed.query)
    return (parsed.path == "/PostView.naver" and query.get("blogId", [""])[0].lower() == blog_id.lower()
            and query.get("logNo", [""])[0].isdigit())


async def visible_button(page, selector):
    for frame in page.frames:
        for button in await frame.locator(selector).all():
            if await button.is_visible():
                return button
    raise ValueError("네이버 발행 버튼을 찾지 못했습니다. 연결 화면에서 편집기 상태를 확인해 주세요.")


async def run_job(session, payload, journal):
    attempted = False
    key = fingerprint(payload)
    try:
        check_stop(session)
        if payload.publish and journal.has(key):
            raise ValueError("이 원고는 이미 발행 요청 기록이 있습니다. 네이버에서 게시 여부를 확인해 주세요.")
        frame = await editor(session.page)
        if not any(writer_url(f.url, payload.blogId) for f in session.page.frames):
            raise ValueError("열린 글쓰기 화면과 설정한 블로그 ID가 다릅니다.")
        expected_title, expected_body = payload.post.title, clean(payload.post.body())
        old_title, old_body = await contents(frame, TITLE), await contents(frame, BODY)
        if (old_title, old_body) != (expected_title, expected_body):
            if old_title or old_body:
                raise ValueError("편집기에 다른 내용이 있습니다. 기존 글을 보존하기 위해 중지했습니다. 빈 글쓰기 화면을 준비해 주세요.")
            session.job.update(message="제목을 입력하고 있어요", status="typing")
            await frame.locator(TITLE).first.click()
            await type_text(session, expected_title, payload.speed, 0, 5)
            await frame.locator(BODY).first.click()
            session.job["message"] = "본문을 한 글자씩 입력하고 있어요"
            await type_text(session, payload.post.body(), payload.speed, 5, 85)
        check_stop(session)
        if await contents(frame, TITLE) != expected_title or await contents(frame, BODY) != expected_body:
            raise ValueError("입력된 제목 또는 본문이 원고와 다릅니다. 발행하지 않았습니다.")
        if not payload.publish:
            session.job.update(status="typed", message="네이버 입력을 마쳤어요", progress=100)
            return
        session.job.update(status="publishing", message="발행 설정을 확인하고 있어요", progress=92)
        await (await visible_button(session.page, PUBLISH)).click()
        # Wait for the publication panel. Never choose privacy/category on behalf of user.
        confirm = None
        for _ in range(30):
            check_stop(session)
            try:
                confirm = await visible_button(session.page, CONFIRM)
                break
            except ValueError:
                await asyncio.sleep(.2)
        if confirm is None:
            raise ValueError("최종 발행 버튼을 찾지 못했습니다. 네이버 화면을 확인해 주세요.")
        check_stop(session)
        journal.reserve(key)
        attempted = True
        session.job.update(message="발행 결과를 확인하고 있어요", progress=97)
        await confirm.click(timeout=10000)
        for _ in range(60):
            for candidate in session.page.context.pages:
                for candidate_frame in candidate.frames:
                    if post_url(candidate_frame.url, payload.blogId):
                        titles = candidate_frame.locator('.se-title-text, .pcol1 .htitle, .se-documentTitle')
                        if any(clean(t) == expected_title for t in await titles.all_text_contents()):
                            journal.published(key, candidate_frame.url)
                            session.job.update(status="published", message="발행을 확인했어요", progress=100, url=candidate_frame.url)
                            return
            await asyncio.sleep(.5)
        session.job.update(status="unknown", message="발행 결과를 확인하지 못했어요", detail="이미 게시되었을 수 있습니다. 네이버에서 확인하세요. 자동으로 다시 발행하지 않습니다.")
    except InterruptedError as error:
        session.job.update(status="stopped", message=str(error))
    except Exception as error:
        # Do not expose exception repr: it may include page contents or credentials.
        message = str(error) if isinstance(error, (ValueError, sqlite3.IntegrityError)) else "네이버 화면의 응답을 확인하지 못했습니다. 연결 화면을 확인해 주세요."
        if isinstance(error, sqlite3.IntegrityError):
            message = "이 원고의 발행 요청 기록이 있습니다. 게시 여부를 확인해 주세요."
        session.job.update(status="unknown" if attempted else "error", message=message,
                           detail="이미 게시되었을 수 있어 재발행하지 않습니다." if attempted else "")
