"""One isolated computer, accessible through Tailscale or a loopback SSH tunnel.

The console runs explicit deterministic tools; it is not an LLM agent runtime.
No credentials, shell execution endpoint, host mount, or Docker socket exists.
"""
import asyncio
from collections import OrderedDict
import contextlib
import os
from pathlib import Path
import secrets
import signal
import ipaddress
import re

from aiohttp import web, WSMsgType
from policy import Workspace, parse_command, needs_approval, validate_url

ALLOWED_HOSTS = {"127.0.0.1:16080", "localhost:16080"}
for configured in os.environ.get("COMPUTER_ALLOWED_HOSTS", "").split(","):
    if not configured:
        continue
    name, separator, port = configured.lower().rpartition(":")
    if not separator or port != "16080":
        raise ValueError("Configured console hosts must use port 16080")
    try:
        address = ipaddress.ip_address(name)
    except ValueError:
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", name) or ("." in name and not name.endswith(".ts.net")):
            raise ValueError("Only Tailscale names are allowed")
    else:
        if address.version != 4 or address not in ipaddress.ip_network("100.64.0.0/10"):
            raise ValueError("Only Tailscale IPv4 addresses are allowed")
    ALLOWED_HOSTS.add(configured.lower())
ROOT = Path(__file__).parent


class Computer:
    def __init__(self, workspace):
        self.workspace = Workspace(workspace)
        self.sessions = set()
        self.messages = []
        self.pending = {}
        self.approved_inputs = set()
        self.mode = "bot"
        self.stopped = False
        self.busy = False
        self.task = None
        self.processes = set()
        self.sockets = set()
        self.transports = {}
        self.screens = OrderedDict()
        self.lock = asyncio.Lock()
        self.control_lock = asyncio.Lock()

    def message(self, role, text, **extra):
        self.messages.append({"id": secrets.token_hex(8), "role": role, "text": text, **extra})
        self.messages = self.messages[-60:]

    async def command(self, *args, timeout=10):
        process = await asyncio.create_subprocess_exec(
            *args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )
        self.processes.add(process)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout)
            if process.returncode:
                raise RuntimeError((stderr or stdout).decode(errors="replace")[-2000:] or f"Process exited {process.returncode}")
            return stdout
        finally:
            self.processes.discard(process)
            if process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(process.pid, signal.SIGKILL)
                await process.wait()

    async def screenshot(self):
        name = Path("/tmp") / ("screen-" + secrets.token_hex(12) + ".png")
        try:
            await self.command("scrot", str(name))
            return name.read_bytes()
        finally:
            name.unlink(missing_ok=True)

    async def perform(self, action):
        tool = action["tool"]
        if tool == "list_files":
            return self.workspace.list_files()
        if tool == "read_file":
            return self.workspace.read(action["path"])
        if tool == "write_file":
            return self.workspace.write(action["path"], action["content"])
        if tool == "human_control":
            self.mode = "human"
            return "คุณควบคุมจอได้แล้ว"
        if tool == "click":
            await self.command("xdotool", "mousemove", str(action["x"]), str(action["y"]), "click", "1")
            return "Clicked"
        if tool == "type":
            await self.command("xdotool", "type", "--clearmodifiers", "--delay", "10", "--", action["text"])
            return "Typed"
        if tool == "open":
            url = await asyncio.to_thread(validate_url, action["url"])
            # The browser has no host privileges. Its profile is ephemeral, inside /tmp.
            # Docker supplies the outer boundary; Chromium cannot use its setuid sandbox
            # in a no-new-privileges container with all capabilities dropped.
            process = await asyncio.create_subprocess_exec(
                "chromium", "--no-sandbox", "--disable-dev-shm-usage", "--no-first-run",
                "--no-default-browser-check", "--user-data-dir=/tmp/browser-profile",
                "--window-size=1280,760", "--window-position=0,0", url,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                start_new_session=True,
            )
            await asyncio.sleep(1)
            if process.returncode not in (None, 0):
                raise RuntimeError(f"Chromium exited {process.returncode}")
            return "Opened " + url
        raise ValueError("Unknown tool")

    async def execute(self, action):
        async with self.lock:
            self.busy = True
            try:
                if self.stopped:
                    raise ValueError("Computer is stopped; use คืนให้บอต to resume")
                if self.mode == "human" and action["tool"] in {"open", "click", "type"}:
                    raise ValueError("Return control to the bot before sending screen commands")
                result = await self.perform(action)
                image = None
                if action["tool"] in {"open", "click", "type"}:
                    await asyncio.sleep(1)
                    data = await self.screenshot()
                    image = secrets.token_hex(12)
                    self.screens[image] = data
                    while len(self.screens) > 12:
                        self.screens.popitem(last=False)
                self.message("bot", result, image=image)
            except asyncio.CancelledError:
                self.message("bot", "หยุดการควบคุมแล้ว")
                raise
            except Exception as error:
                self.message("error", f"{action['tool']}: {error}")
            finally:
                self.busy = False

    def launch(self, action):
        if self.task and not self.task.done():
            raise ValueError("A tool is running; stop it or wait for its result")
        self.task = asyncio.create_task(self.execute(action))

    async def stop(self):
        self.stopped = True
        self.mode = "stopped"
        self.pending.clear()
        self.approved_inputs.clear()
        if self.task and not self.task.done():
            self.task.cancel()
        # Revoke both live VNC streams before returning a successful stop response.
        await self.close_sockets()
        if self.task:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self.task
        # Release keys/buttons held by a disconnected human without moving the cursor.
        with contextlib.suppress(Exception):
            await self.command("xdotool", "keyup", "Shift_L", "Control_L", "Alt_L", "Super_L", timeout=2)
            await self.command("xdotool", "mouseup", "1", "mouseup", "2", "mouseup", "3", timeout=2)
        self.message("bot", "หยุดการควบคุมแล้ว")

    async def close_sockets(self):
        for ws in tuple(self.sockets):
            transport = self.transports.get(ws)
            if transport:
                transport.abort()
        await asyncio.gather(*(ws.close(code=1008, message=b"Control revoked") for ws in tuple(self.sockets)), return_exceptions=True)


def create_app(workspace="/workspace"):
    computer = Computer(workspace)

    @web.middleware
    async def boundary(request, handler):
        host = request.host.lower()
        health = request.path == "/health"
        if host not in ALLOWED_HOSTS and not (health and host == "172.30.160.2:8080"):
            raise web.HTTPForbidden(text="Untrusted host")
        if request.method != "GET" or request.path.startswith("/ws/"):
            if request.headers.get("Origin") != "http://" + host:
                raise web.HTTPForbidden(text="Same-origin access is required")
            if request.method != "GET" and request.headers.get("X-Computer-Request") != "1":
                raise web.HTTPForbidden(text="Missing request header")
        if not health and request.path != "/" and request.cookies.get("computer_session") not in computer.sessions:
            raise web.HTTPUnauthorized(text="Open the console first")
        try:
            response = await handler(request)
        except (ValueError, OSError, RuntimeError) as error:
            response = web.json_response({"error": str(error)}, status=400)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cache-Control"] = "no-store"
        # Tight JPEG/PNG rectangles in noVNC are decoded through data-URI images.
        response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    app = web.Application(middlewares=[boundary], client_max_size=100000)
    app["computer"] = computer

    async def home(request):
        response = web.FileResponse(ROOT / "web/index.html")
        session = request.cookies.get("computer_session")
        if session not in computer.sessions:
            if len(computer.sessions) >= 20:
                raise web.HTTPTooManyRequests(text="Restart the computer to clear console sessions")
            session = secrets.token_hex(32)
            computer.sessions.add(session)
        response.set_cookie("computer_session", session, httponly=True, samesite="Strict", path="/")
        return response

    async def state(request):
        session = request.cookies["computer_session"]
        return web.json_response({"mode": computer.mode, "stopped": computer.stopped,
                                  "busy": computer.busy, "model_calls": 0,
                                  "messages": computer.messages,
                                  "approvals": [{"id": key, "action": value[1]} for key, value in computer.pending.items() if value[0] == session]})

    async def submit(request):
        data = await request.json()
        if not isinstance(data.get("text"), str) or len(data["text"]) > 70000:
            raise ValueError("Command must be text, at most 70,000 characters")
        if computer.stopped:
            raise ValueError("Computer is stopped; use คืนให้บอต to resume")
        action = parse_command(data["text"])
        if action["tool"] == "open":
            await asyncio.to_thread(validate_url, action["url"])
        session = request.cookies["computer_session"]
        computer.message("user", data["text"])
        if needs_approval(action, session in computer.approved_inputs):
            if len(computer.pending) >= 10:
                raise ValueError("Too many pending approvals")
            computer.pending[secrets.token_hex(16)] = (session, action)
        else:
            computer.launch(action)
        return web.json_response({"ok": True})

    async def decide(request):
        data = await request.json()
        session = request.cookies["computer_session"]
        record = computer.pending.get(data.get("id"))
        if not record or record[0] != session:
            raise ValueError("Approval expired or belongs to another console")
        if not isinstance(data.get("allow"), bool):
            raise ValueError("Approval decision must be a boolean")
        if computer.stopped:
            raise ValueError("Computer is stopped")
        computer.pending.pop(data["id"])
        if data["allow"]:
            action = record[1]
            if action["tool"] in {"open", "click", "type", "human_control"}:
                computer.approved_inputs.add(session)
            computer.launch(action)
        else:
            computer.message("bot", "ไม่อนุมัติ")
        return web.json_response({"ok": True})

    async def control(request):
        async with computer.control_lock:
            return await change_control(request)

    async def change_control(request):
        data = await request.json()
        mode = data.get("mode")
        session = request.cookies["computer_session"]
        if mode == "stop":
            await computer.stop()
        elif mode == "bot":
            await computer.close_sockets()
            computer.mode = "bot"
            computer.stopped = False
            computer.message("bot", "คืนการควบคุมให้บอตแล้ว")
        elif mode == "human":
            if computer.stopped or (computer.task and not computer.task.done()):
                raise ValueError("Stop the running tool and resume before taking control")
            action = {"tool": "human_control"}
            if needs_approval(action, session in computer.approved_inputs):
                computer.pending[secrets.token_hex(16)] = (session, action)
            else:
                computer.launch(action)
        else:
            raise ValueError("Unknown control mode")
        return web.json_response({"ok": True})

    async def screen(request):
        image = request.match_info["image"]
        if image == "latest":
            data = await computer.screenshot()
        else:
            data = computer.screens.get(image)
            if data is None:
                raise web.HTTPNotFound(text="Screenshot expired")
        return web.Response(body=data, content_type="image/png")

    async def vnc(request):
        session = request.cookies["computer_session"]
        writable = request.match_info["mode"] == "control"
        if request.match_info["mode"] not in ("view", "control") or computer.stopped:
            raise web.HTTPForbidden(text="Computer is stopped")
        if writable and (computer.mode != "human" or session not in computer.approved_inputs):
            raise web.HTTPForbidden(text="Approve human control first")
        ws = web.WebSocketResponse(protocols=("binary",), max_msg_size=1024 * 1024, heartbeat=20)
        await ws.prepare(request)
        reader, writer = await asyncio.open_connection("127.0.0.1", 5901 if writable else 5900)
        computer.sockets.add(ws)
        computer.transports[ws] = request.transport

        async def downstream():
            while data := await reader.read(65536):
                await ws.send_bytes(data)
            await ws.close()

        pump = asyncio.create_task(downstream())
        try:
            async for message in ws:
                if computer.stopped or (writable and (computer.mode != "human" or session not in computer.approved_inputs)):
                    break
                if message.type == WSMsgType.BINARY:
                    writer.write(message.data)
                    await writer.drain()
                elif message.type == WSMsgType.ERROR:
                    break
        finally:
            pump.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await pump
            writer.close()
            await writer.wait_closed()
            computer.sockets.discard(ws)
            computer.transports.pop(ws, None)
            await ws.close()
        return ws

    async def health(request):
        return web.json_response({"ok": True})

    app.router.add_get("/", home)
    app.router.add_get("/health", health)
    app.router.add_get("/api/state", state)
    app.router.add_post("/api/chat", submit)
    app.router.add_post("/api/approve", decide)
    app.router.add_post("/api/control", control)
    app.router.add_get("/screen/{image}", screen)
    app.router.add_get("/ws/{mode}", vnc)
    app.router.add_static("/assets/", ROOT / "web")
    app.router.add_static("/novnc/", "/opt/novnc", follow_symlinks=False)
    return app


if __name__ == "__main__":
    ip = os.environ.get("LISTEN_IP", "172.30.160.2")
    if ip != "172.30.160.2":
        raise SystemExit("Refusing an unexpected listener address")
    web.run_app(create_app(os.environ.get("WORKSPACE", "/workspace")), host=ip, port=8080, access_log=None)
