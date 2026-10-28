import asyncio
import sys

import pytest
from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer
from controller import Computer, create_app

HOST = {"Host": "127.0.0.1:16080"}
HEADERS = {**HOST, "Origin": "http://127.0.0.1:16080", "X-Computer-Request": "1"}


async def client_for(root):
    client = TestClient(TestServer(create_app(root)), cookie_jar=CookieJar(unsafe=True))
    await client.start_server()
    await client.get("/", headers=HOST)
    return client


def test_list_files_completes_without_models(tmp_path):
    (tmp_path / "visible.txt").write_text("read-only")

    async def scenario():
        client = await client_for(tmp_path)
        try:
            response = await client.post("/api/chat", headers=HEADERS, json={"text": "list files"})
            assert response.status == 200
            await asyncio.sleep(.02)
            state = await (await client.get("/api/state", headers=HOST)).json()
            assert state["messages"][-1]["text"] == "visible.txt"
            assert state["model_calls"] == 0
            assert state["approvals"] == []
            assert (tmp_path / "visible.txt").read_text() == "read-only"
            assert not any(name.startswith(("openai", "anthropic", "litellm")) for name in sys.modules)
        finally:
            await client.close()
    asyncio.run(scenario())


def test_write_only_after_approve_and_replay_rejected(tmp_path):
    async def scenario():
        client = await client_for(tmp_path)
        try:
            await client.post("/api/chat", headers=HEADERS, json={"text": "write note.txt\nreviewed"})
            assert not (tmp_path / "note.txt").exists()
            state = await (await client.get("/api/state", headers=HOST)).json()
            approval = state["approvals"][0]["id"]
            response = await client.post("/api/approve", headers=HEADERS, json={"id": approval, "allow": True})
            assert response.status == 200
            await asyncio.sleep(.02)
            assert (tmp_path / "note.txt").read_text() == "reviewed"
            replay = await client.post("/api/approve", headers=HEADERS, json={"id": approval, "allow": True})
            assert replay.status == 400
            await client.post("/api/chat", headers=HEADERS, json={"text": "write note.txt\nsecond"})
            state = await (await client.get("/api/state", headers=HOST)).json()
            assert len(state["approvals"]) == 1
            assert (tmp_path / "note.txt").read_text() == "reviewed"
        finally:
            await client.close()
    asyncio.run(scenario())


def test_tool_error_is_visible_and_escape_never_writes(tmp_path):
    async def scenario():
        client = await client_for(tmp_path)
        try:
            await client.post("/api/chat", headers=HEADERS, json={"text": "read missing.txt"})
            await asyncio.sleep(.02)
            state = await (await client.get("/api/state", headers=HOST)).json()
            assert state["messages"][-1]["role"] == "error"
            assert "No such file" in state["messages"][-1]["text"]
            await client.post("/api/chat", headers=HEADERS, json={"text": "write ../escape\nno"})
            state = await (await client.get("/api/state", headers=HOST)).json()
            await client.post("/api/approve", headers=HEADERS, json={"id": state["approvals"][0]["id"], "allow": True})
            await asyncio.sleep(.02)
            assert not (tmp_path.parent / "escape").exists()
            state = await (await client.get("/api/state", headers=HOST)).json()
            assert "relative to the bot workspace" in state["messages"][-1]["text"]
        finally:
            await client.close()
    asyncio.run(scenario())


def test_origin_host_and_session_gate(tmp_path):
    async def scenario():
        client = TestClient(TestServer(create_app(tmp_path)), cookie_jar=CookieJar(unsafe=True))
        await client.start_server()
        try:
            assert (await client.get("/api/state", headers=HOST)).status == 401
            assert (await client.get("/", headers={"Host": "attacker.example:16080"})).status == 403
            await client.get("/", headers=HOST)
            home = await client.get("/", headers=HOST)
            policy = home.headers['Content-Security-Policy']
            assert "img-src 'self' blob: data:" in policy
            assert "script-src 'self';" in policy
            assert (await client.post("/api/chat", headers=HOST, json={"text": "list files"})).status == 403
            bad_origin = {**HEADERS, "Origin": "https://attacker.example"}
            assert (await client.post("/api/chat", headers=bad_origin, json={"text": "list files"})).status == 403
            assert (await client.get("/ws/control", headers=HEADERS)).status == 403
            assert (await client.get("/ws/view", headers={**HOST, "Origin": "https://attacker.example"})).status == 403
        finally:
            await client.close()
    asyncio.run(scenario())


def test_screen_input_waits_for_approve_and_deny_does_not_run(tmp_path):
    async def scenario():
        client = await client_for(tmp_path)
        calls = []
        async def perform(action):
            calls.append(action)
            return "done"
        async def screenshot():
            return b"screen"
        computer = client.server.app["computer"]
        computer.perform = perform
        computer.screenshot = screenshot
        try:
            await client.post("/api/chat", headers=HEADERS, json={"text": "click 100 100"})
            await asyncio.sleep(.01)
            assert calls == []
            state = await (await client.get("/api/state", headers=HOST)).json()
            await client.post("/api/approve", headers=HEADERS, json={"id": state["approvals"][0]["id"], "allow": False})
            assert calls == []
            await client.post("/api/chat", headers=HEADERS, json={"text": "type hello"})
            state = await (await client.get("/api/state", headers=HOST)).json()
            await client.post("/api/approve", headers=HEADERS, json={"id": state["approvals"][0]["id"], "allow": True})
            await asyncio.sleep(.02)
            assert calls == [{"tool": "type", "text": "hello"}]
            assert computer.busy
            await computer.task
            assert computer.messages[-1]["image"] in computer.screens
        finally:
            await client.close()
    asyncio.run(scenario())


def test_stop_cancels_live_tool_and_closes_streams(tmp_path):
    async def scenario():
        computer = Computer(tmp_path)
        started = asyncio.Event()
        cancelled = asyncio.Event()
        closed = asyncio.Event()
        async def perform(action):
            started.set()
            try:
                await asyncio.sleep(30)
            finally:
                cancelled.set()
        async def command(*args, **kwargs):
            return b""
        class Socket:
            async def close(self, **kwargs):
                closed.set()
        computer.perform = perform
        computer.command = command
        computer.sockets.add(Socket())
        computer.approved_inputs.add("old")
        computer.pending["old"] = ("old", {"tool": "click"})
        computer.launch({"tool": "click"})
        await started.wait()
        await asyncio.wait_for(computer.stop(), 1)
        assert cancelled.is_set() and closed.is_set()
        assert computer.stopped and not computer.busy
        assert not computer.approved_inputs and not computer.pending
    asyncio.run(scenario())
