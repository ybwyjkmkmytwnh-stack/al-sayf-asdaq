"""أدوات مشتركة لاختبارات المتصفح (Playwright/Chromium). هذه اختبارات للمسار البرمجي فقط — لا تثبت أداء إنسان."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[2]
CHROME_ARGS = ["--autoplay-policy=no-user-gesture-required", "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"]


@asynccontextmanager
async def server(port: int = 8771):
    proc = subprocess.Popen([sys.executable, str(ROOT / "serve.py"), "--port", str(port), "--no-auto-analyze"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    t0 = time.time()
    import urllib.request
    while time.time() - t0 < 20:
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=1).read()
            break
        except Exception:
            await asyncio.sleep(0.2)
    else:
        proc.kill()
        raise RuntimeError("الخادم لم يبدأ")
    try:
        yield f"http://127.0.0.1:{port}/"
    finally:
        proc.terminate()
        try:
            proc.wait(5)
        except Exception:
            proc.kill()


@asynccontextmanager
async def browser(extra_args=None, headless=True):
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=headless, args=CHROME_ARGS + list(extra_args or []))
        try:
            yield b
        finally:
            await b.close()


class Page:
    def __init__(self, page):
        self.page = page
        self.logs = []
        page.on("console", lambda m: self.logs.append((m.type, m.text)))
        page.on("pageerror", lambda e: self.logs.append(("pageerror", str(e))))

    def errors(self):
        return [l for l in self.logs if l[0] in ("error", "pageerror")]

    async def open(self, url, timeout=60000):
        await self.page.goto(url)
        await self.page.wait_for_function("window.__karaokeBoot && window.__karaokeBoot.state !== 'loading'", timeout=timeout)
        return await self.page.evaluate("window.__karaokeBoot")

    async def ev(self, js, arg=None):
        return await self.page.evaluate(js, arg)
