"""Private, same-origin browser host. One Uvicorn worker; TLS required in production."""
import asyncio
import contextlib
import hashlib
import os
from pathlib import Path
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from urllib.parse import urlparse
from fastapi import FastAPI, Request, HTTPException
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from playwright.async_api import async_playwright
from .models import Login, Writer, Input, StartJob
from .automation import Journal, editor, run_job

ROOT = Path(__file__).resolve().parents[1]
ACTIVE = {"starting", "typing", "publishing"}
ALLOWED_HOSTS = ("naver.com", "pstatic.net", "naver.net")


def allowed_url(url):
    parsed = urlparse(url)
    host = parsed.hostname or ""
    return (parsed.scheme == "https" and parsed.port in (None, 443)
            and any(host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_HOSTS))


@dataclass
class Session:
    created: float = field(default_factory=time.monotonic)
    touched: float = field(default_factory=time.monotonic)
    context: object = None
    page: object = None
    job: dict = field(default_factory=dict)
    task: object = None
    stop: asyncio.Event = field(default_factory=asyncio.Event)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def active(self):
        return bool(self.task and not self.task.done())


def create_app(*, code=None, origin=None, data_dir=None, browser_factory=None):
    access_code = code if code is not None else os.getenv("STUDIO_ACCESS_CODE", "")
    public_origin = origin or os.getenv("PUBLIC_ORIGIN", "")
    local = public_origin in ("http://127.0.0.1:8000", "http://localhost:8000")
    if len(access_code) < 24:
        raise RuntimeError("STUDIO_ACCESS_CODE must contain at least 24 characters.")
    parsed = urlparse(public_origin)
    if not parsed.hostname or parsed.username or (not local and parsed.scheme != "https") or parsed.path or parsed.query or parsed.fragment:
        raise RuntimeError("PUBLIC_ORIGIN must be the exact HTTPS origin (no trailing slash).")
    data = Path(data_dir or os.getenv("DATA_DIR", ROOT / "data"))
    data.mkdir(parents=True, exist_ok=True)
    journal = Journal(data / "publication.sqlite3")
    sessions, attempts = {}, {}
    browser = None
    pw = None
    browser_lock = asyncio.Lock()

    async def dispose(token):
        session = sessions.pop(token, None)
        if session:
            session.stop.set()
            if session.task and not session.task.done():
                session.task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await session.task
            if session.context:
                await session.context.close()

    async def reap():
        while True:
            await asyncio.sleep(30)
            now = time.monotonic()
            for token, s in list(sessions.items()):
                if now - s.created > 7200 or (not s.active() and now - s.touched > 1800):
                    await dispose(token)
            for ip, times in list(attempts.items()):
                if not times or now - times[-1] > 300:
                    attempts.pop(ip, None)

    @asynccontextmanager
    async def lifespan(app):
        nonlocal pw, browser
        cleaner = asyncio.create_task(reap())
        yield
        cleaner.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cleaner
        for token in list(sessions):
            await dispose(token)
        if browser:
            await browser.close()
        if pw:
            await pw.stop()

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        # Pydantic's default response echoes input, including login code/text.
        return JSONResponse({"detail": "입력한 원고와 설정 형식을 확인해 주세요."}, status_code=422)

    @app.middleware("http")
    async def boundary(request, call_next):
        if request.url.path.startswith("/api/"):
            if request.headers.get("origin") not in (None, public_origin):
                return JSONResponse({"detail": "허용되지 않은 요청 출처입니다."}, status_code=403)
            if request.method != "GET" and request.headers.get("origin") != public_origin:
                return JSONResponse({"detail": "요청 출처를 확인할 수 없습니다."}, status_code=403)
            # Limit actual streamed bytes, not just attacker-controlled Content-Length.
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 100_000:
                    return JSONResponse({"detail": "요청이 너무 큽니다."}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff",
                                 "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY"})
        if not local:
            response.headers["Strict-Transport-Security"] = "max-age=31536000"
        return response

    def auth(request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        session = sessions.get(token)
        now = time.monotonic()
        if not session or now - session.created > 7200 or (not session.active() and now - session.touched > 1800):
            raise HTTPException(401, "연결이 만료되었습니다. 다시 연결해 주세요.")
        session.touched = now
        return session

    async def get_browser():
        nonlocal pw, browser
        async with browser_lock:
            if browser and browser.is_connected():
                return browser
            if browser_factory:
                browser = await browser_factory()
            else:
                pw = await async_playwright().start()
                browser = await pw.chromium.launch(headless=True, chromium_sandbox=not local,
                                                   channel=os.getenv("BROWSER_CHANNEL") or None)
            return browser

    async def open_session(s):
        if s.context:
            return
        b = await get_browser()
        s.context = await b.new_context(viewport={"width": 1100, "height": 760}, locale="ko-KR",
                                        timezone_id="Asia/Seoul", accept_downloads=False, service_workers="block")
        async def route(req):
            try:
                allowed = allowed_url(req.request.url)
            except ValueError:
                allowed = False
            if allowed:
                await req.continue_()
            else:
                await req.abort()
        await s.context.route("**/*", route)
        await s.context.route_web_socket("**/*", lambda ws: ws.close())
        s.page = await s.context.new_page()
        s.page.set_default_timeout(10000)
        await s.page.goto("https://nid.naver.com/nidlogin.login", wait_until="domcontentloaded", timeout=30000)

    @app.get("/api/config")
    async def config():
        return {"mode": "server", "accessCodeRequired": True, "version": 2}

    @app.get("/config.json")
    async def web_config():
        return {"mode": "server", "version": 2}

    @app.post("/api/session")
    async def login(payload: Login, request: Request):
        ip = request.client.host if request.client else "unknown"
        now = time.monotonic()
        times = [t for t in attempts.get(ip, []) if now - t < 300]
        if len(times) >= 10:
            raise HTTPException(429, "접속 시도가 많습니다. 5분 후 다시 시도해 주세요.")
        if len(attempts) >= 10000 and ip not in attempts:
            raise HTTPException(429, "잠시 후 다시 시도해 주세요.")
        attempts[ip] = times + [now]
        if not secrets.compare_digest(hashlib.sha256(payload.code.encode()).digest(), hashlib.sha256(access_code.encode()).digest()):
            raise HTTPException(401, "접속 코드를 확인해 주세요.")
        if len(sessions) >= 2:
            raise HTTPException(409, "연결된 작업 공간이 있습니다. 기존 연결을 종료하거나 만료 후 다시 연결해 주세요.")
        token = secrets.token_urlsafe(32)
        sessions[token] = Session()
        return {"token": token}

    @app.delete("/api/session")
    async def logout(request: Request):
        auth(request)
        await dispose(request.headers["authorization"].removeprefix("Bearer "))
        return {"ok": True}

    @app.post("/api/browser")
    async def open_browser(request: Request):
        s = auth(request)
        async with s.lock:
            try:
                await open_session(s)
            except Exception:
                if s.context:
                    await s.context.close()
                s.context = s.page = None
                raise HTTPException(503, "서버 브라우저를 열지 못했습니다. 운영자가 브라우저 실행 환경을 확인해야 합니다.") from None
        return {"ok": True}

    def require_page(s, control=False):
        if not s.page or s.page.is_closed():
            raise HTTPException(409, "네이버 로그인 화면을 먼저 열어 주세요.")
        if control and s.active():
            raise HTTPException(409, "자동 입력 중입니다. 작업을 중지한 뒤 화면을 조작해 주세요.")

    @app.get("/api/browser/screen")
    async def screen(request: Request):
        s = auth(request)
        require_page(s)
        # Never cache screenshots or store login fields on disk.
        try:
            return Response(await s.page.screenshot(type="jpeg", quality=70, timeout=10000), media_type="image/jpeg")
        except Exception:
            raise HTTPException(503, "화면을 가져오지 못했습니다.") from None

    @app.post("/api/browser/input")
    async def browser_input(payload: Input, request: Request):
        s = auth(request)
        async with s.lock:
            require_page(s, True)
            try:
                if payload.kind == "click":
                    await s.page.mouse.click(payload.x, payload.y)
                elif payload.kind == "text":
                    await s.page.keyboard.insert_text(payload.text)
                elif payload.kind == "key":
                    await s.page.keyboard.press(payload.key)
                elif payload.kind == "scroll":
                    await s.page.mouse.wheel(0, payload.delta)
            except Exception:
                raise HTTPException(503, "네이버 입력에 응답이 없습니다. 화면을 확인해 주세요.") from None
        return {"ok": True}

    @app.post("/api/browser/writer")
    async def writer(payload: Writer, request: Request):
        s = auth(request)
        async with s.lock:
            require_page(s, True)
            # Never discard an existing draft through a navigation command.
            try:
                await editor(s.page)
                return {"ok": True}
            except ValueError:
                pass
            try:
                await s.page.goto(f"https://blog.naver.com/{payload.blogId}/postwrite", wait_until="domcontentloaded", timeout=30000)
            except Exception:
                raise HTTPException(503, "글쓰기 화면을 열지 못했습니다.") from None
        return {"ok": True}

    @app.get("/api/browser/ready")
    async def ready(request: Request):
        s = auth(request)
        require_page(s)
        try:
            await editor(s.page)
        except ValueError as error:
            raise HTTPException(409, str(error)) from None
        return {"ready": True}

    @app.post("/api/jobs")
    async def start(payload: StartJob, request: Request):
        s = auth(request)
        async with s.lock:
            require_page(s, True)
            try:
                await editor(s.page)
            except ValueError as error:
                raise HTTPException(409, str(error)) from None
            s.stop.clear()
            s.job = {"id": secrets.token_hex(12), "status": "starting", "message": "네이버 원고 입력을 준비하고 있어요", "progress": 0}
            s.task = asyncio.create_task(run_job(s, payload, journal))
            return {"id": s.job["id"]}

    @app.get("/api/jobs/{job_id}")
    async def job_status(job_id: str, request: Request):
        s = auth(request)
        if s.job.get("id") != job_id:
            raise HTTPException(404, "작업 기록이 없습니다.")
        return s.job

    @app.post("/api/jobs/{job_id}/stop")
    async def job_stop(job_id: str, request: Request):
        s = auth(request)
        if s.job.get("id") != job_id:
            raise HTTPException(404, "작업 기록이 없습니다.")
        s.stop.set()
        return {"ok": True}

    app.mount("/", StaticFiles(directory=ROOT / "docs", html=True), name="web")
    return app
