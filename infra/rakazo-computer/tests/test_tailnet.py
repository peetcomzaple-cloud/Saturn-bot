import asyncio
from aiohttp import CookieJar
from aiohttp.test_utils import TestClient, TestServer
import controller


def test_tailnet_host_session_and_origin_gate(tmp_path, monkeypatch):
    host = '100.100.1.2:16080'
    monkeypatch.setattr(controller, 'ALLOWED_HOSTS', controller.ALLOWED_HOSTS | {host, 'computer.example.ts.net:16080'})
    async def scenario():
        client = TestClient(TestServer(controller.create_app(tmp_path)), cookie_jar=CookieJar(unsafe=True))
        await client.start_server()
        try:
            assert (await client.get('/', headers={'Host':host})).status == 200
            assert (await client.get('/api/state', headers={'Host':host})).status == 200
            headers = {'Host':host,'Origin':'http://' + host,'X-Computer-Request':'1'}
            assert (await client.post('/api/chat',headers=headers,json={'text':'list files'})).status == 200
            await asyncio.sleep(.02)
            state = await (await client.get('/api/state',headers={'Host':host})).json()
            assert state['messages'][-1]['text'] == 'Workspace is empty'
            assert (await client.get('/',headers={'Host':'computer.example.ts.net:16080'})).status == 200
            response = await client.get('/ws/control',headers={'Host':host,'Origin':'http://' + host})
            assert response.status == 403
            assert 'Approve human control first' in await response.text()
            bad = {**headers,'Origin':'http://attacker.example'}
            assert (await client.post('/api/chat',headers=bad,json={'text':'list files'})).status == 403
            assert (await client.get('/',headers={'Host':'203.0.113.10:16080'})).status == 403
        finally:
            await client.close()
    asyncio.run(scenario())
