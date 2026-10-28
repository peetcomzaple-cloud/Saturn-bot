"""Offline protocol/error regressions for the live browser helper."""
import importlib.machinery
import importlib.util
import json
from pathlib import Path
import struct
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from importlib.machinery import SourceFileLoader
from importlib.util import module_from_spec, spec_from_loader

loader = importlib.machinery.SourceFileLoader("page_browser", str(Path(__file__).with_name("rakazo-page-browser")))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class PageBrowserTest(unittest.TestCase):
    def test_document_dns_failures_keep_only_known_codes_and_request_identity(self):
        for error in ('net::ERR_NAME_NOT_RESOLVED', 'net::ERR_NAME_RESOLUTION_FAILED', 'private arbitrary error'):
            with self.subTest(error=error):
                evidence = helper.BrowserEvidence('run-1', 'execution-1', 'navigate')
                evidence.reply('Target.attachToTarget', {'targetId':'target-1'}, {'sessionId':'session-1'}, None)
                evidence.selected('session-1','target-1')
                evidence.event({'method':'Network.requestWillBeSent','sessionId':'session-1','params':{
                    'requestId':'request-1','type':'Document','request':{'url':'http://missing.example.test/','method':'GET'}}})
                evidence.event({'method':'Network.loadingFailed','sessionId':'session-1','params':{
                    'requestId':'request-1','errorText':error}})
                envelope = evidence.finish({'ok':False,'error':error})
                self.assertTrue(envelope['complete'])
                failure = next(event for event in envelope['events'] if event['method']=='Network.loadingFailed')
                self.assertEqual(failure['errorCode'],error if error.startswith('net::ERR_NAME_') else 'OTHER')
                self.assertEqual(failure['urlSha256'],helper.BrowserEvidence.url_fingerprint('http://missing.example.test/'))
                self.assertNotIn('private',json.dumps(envelope))
                self.assertNotIn('http://',json.dumps(envelope))

    def test_closed_stdin_cancels_helper_without_a_browser(self):
        with subprocess.Popen([sys.executable, str(Path(__file__).with_name("rakazo-page-browser")), "snapshot", "{}"],
                              env={**os.environ, "RAKAZO_BROWSER_WATCH_STDIN": "1", "RAKAZO_CDP_PORT": "0"},
                              stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as process:
            process.stdin.close()
            self.assertEqual(process.wait(timeout=3), 130)

    def test_closed_extended_frame_does_not_spin(self):
        for partial in (b"\x81\x7e", b"\x81\x7f", b"\x81\x80"):
            with self.subTest(partial=partial):
                client = helper.CdpClient("ws://127.0.0.1:9222/test")
                client._sock = Mock()
                client._sock.recv.return_value = b""
                client._buf.extend(partial)
                with self.assertRaisesRegex(RuntimeError, "closed"):
                    client._read_frame()

    def test_bounds_frame_before_reading_payload(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._sock = Mock()
        client._buf.extend(b"\x81\x7f" + struct.pack("!Q", 10_000_000))
        with self.assertRaisesRegex(RuntimeError, "too large"):
            client._read_frame()
        client._sock.recv.assert_not_called()

    def test_rejects_url_credentials_before_navigation(self):
        client = Mock()
        for url in ("http://example:fake-password@example.test", "https://example:fake-password@example.test"):
            with self.assertRaisesRegex(RuntimeError, "credentials"):
                helper.navigate(client, "session", url)
        client.call.assert_not_called()

    def test_rejects_navigation_error(self):
        client = Mock()
        client.call.return_value = {"errorText": "net::ERR_NAME_NOT_RESOLVED"}
        with self.assertRaisesRegex(RuntimeError, "ERR_NAME_NOT_RESOLVED"):
            helper.navigate(client, "session", "https://example.test")

    def test_preserves_completed_actions_when_next_response_is_lost(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}, True, TimeoutError("lost response")]
            result = helper.act(Mock(), "session", [
                {"kind": "click", "ref": "first"}, {"kind": "click", "ref": "second"},
            ])
        self.assertEqual(result["completed"], 1)
        self.assertTrue(result["uncertain"])
        self.assertFalse(result["ok"])

    def test_rejects_missing_text_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "Text"):
                helper.act(Mock(), "session", [{"kind": "fill", "ref": "first"}])
            ensure.assert_not_called()

    def test_binds_saved_login_fill_to_its_origin_in_the_same_evaluation(self):
        with patch.object(helper, "ensure_helpers"), patch.object(helper, "snapshot", return_value={"ok": True}), \
                patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [True, {}]
            helper.act(Mock(), "session", [
                {"kind": "fill", "ref": "e1", "text": "fake-password", "origin": "https://login.example.test"},
            ])
        self.assertEqual(
            evaluate.call_args_list[1].args[2],
            'window.__rakazoPageBrowser.fill("e1", "fake-password", "https://login.example.test")',
        )

    def test_rejects_origin_outside_fill_before_any_action(self):
        with patch.object(helper, "ensure_helpers") as ensure:
            with self.assertRaisesRegex(RuntimeError, "origin"):
                helper.act(Mock(), "session", [
                    {"kind": "type", "ref": "e1", "text": "x", "origin": "https://login.example.test"},
                ])
            ensure.assert_not_called()

    def test_reads_arguments_from_one_stdin_line_only(self):
        payload = b'{"actions": []}\nrest'
        with patch.object(helper.os, "read", side_effect=[payload[i:i + 1] for i in range(len(payload))]) as read:
            self.assertEqual(helper.read_stdin_line(), '{"actions": []}')
        self.assertEqual(read.call_count, len(b'{"actions": []}\n'))

    def test_discovery_cannot_leave_loopback_endpoint(self):
        with patch.object(helper, "http_get_json", return_value={"webSocketDebuggerUrl": "ws://example.test:9222/session"}):
            with self.assertRaisesRegex(RuntimeError, "Unexpected CDP"):
                helper.discover_ws_url(9222)

    def test_ensure_world_reuses_named_isolated_context(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        calls = []

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append(method)
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                client._handle_event({
                    "method": "Runtime.executionContextCreated",
                    "sessionId": session_id,
                    "params": {
                        "context": {
                            "id": 42,
                            "name": helper.WORLD_NAME,
                            "auxData": {"frameId": "frame-1", "isDefault": False},
                        }
                    },
                })
                return {}
            raise AssertionError(f"unexpected CDP call: {method}")

        client.call = fake_call  # type: ignore[method-assign]
        helper.ensure_world(client, "session-a")
        self.assertEqual(client.context_id, 42)
        self.assertNotIn("Page.createIsolatedWorld", calls)

    def test_context_lookup_rejects_default_foreign_and_unbound_contexts(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        for aux, session in (({"frameId": "frame-1", "isDefault": True}, "session-a"),
                             ({"frameId": "other-frame", "isDefault": False}, "session-a"),
                             ({"frameId": "frame-1", "isDefault": False}, "session-b"),
                             ({}, "session-a")):
            client._handle_event({"method": "Runtime.executionContextCreated", "sessionId": session,
                                  "params": {"context": {"id": 42, "name": helper.WORLD_NAME, "auxData": aux}}})
            self.assertIsNone(client.find_world_context(helper.WORLD_NAME, "frame-1", "session-a"))

    def test_ensure_world_creates_when_missing(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            if method == "Page.getFrameTree":
                return {"frameTree": {"frame": {"id": "frame-1"}}}
            if method == "Runtime.enable":
                return {}
            if method == "Page.createIsolatedWorld":
                self.assertEqual(params["worldName"], helper.WORLD_NAME)
                return {"executionContextId": 7}
            raise AssertionError(f"unexpected CDP call: {method}")

    def test_navigate_detects_http_400_bad_request(self):
        client = Mock()
        client.call.side_effect = [
            {"loaderId": "loader-1", "frameId": "frame-1"},  # Page.navigate
            {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-1"}}},  # Page.getFrameTree
        ]
        with patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",  # readyState
                {"url": "https://accounts.example.test/signin", "title": "Error 400 (Bad Request)!!1", "httpStatus": 400},
            ]
            res = helper.navigate(client, "session", "https://accounts.example.test/signin")
            self.assertFalse(res["ok"])
            self.assertEqual(res["httpStatus"], 400)
            self.assertEqual(res["title"], "Error 400 (Bad Request)!!1")
            self.assertEqual(res["fallback"], "computer_act")

    def test_navigate_returns_success_for_http_200(self):
        client = Mock()
        client.call.side_effect = [
            {"loaderId": "loader-1", "frameId": "frame-1"},  # Page.navigate
            {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-1"}}},  # Page.getFrameTree
        ]
        with patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",  # readyState
                {"url": "https://accounts.example.test/signin", "title": "Sign in - Google Accounts", "httpStatus": 200},
            ]
            res = helper.navigate(client, "session", "https://accounts.example.test/signin")
            self.assertTrue(res["ok"])
            self.assertEqual(res["httpStatus"], 200)
            self.assertEqual(res["httpStatusStatus"], "known")
            self.assertEqual(res["title"], "Sign in - Google Accounts")

    def test_navigate_never_fabricates_200_when_status_is_missing(self):
        client = Mock()
        client.call.side_effect = [
            {"loaderId": "loader-1", "frameId": "frame-1"},
            {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-1"}}},
        ]
        with patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",
                {"url": "https://example.test/app", "title": "App", "httpStatus": None},
            ]
            res = helper.navigate(client, "session", "https://example.test/app")
            self.assertTrue(res["ok"])
            self.assertEqual(res["httpStatusStatus"], "unknown")
            self.assertNotIn("httpStatus", res)

    def test_navigate_detects_200_challenge_page_and_ignores_subresource_403(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._handle_event(
            {
                "sessionId": "session-1",
                "method": "Network.responseReceived",
                "params": {
                    "requestId": "req-sub-1",
                    "loaderId": "loader-1",
                    "frameId": "frame-1",
                    "type": "XHR",
                    "response": {"url": "https://example.test/api/sub", "status": 403, "headers": {}},
                },
            }
        )
        client._handle_event(
            {
                "sessionId": "session-1",
                "method": "Network.responseReceived",
                "params": {
                    "requestId": "req-doc-1",
                    "loaderId": "loader-1",
                    "frameId": "frame-1",
                    "type": "Document",
                    "response": {"url": "https://example.test/home", "status": 200, "headers": {}},
                },
            }
        )
        with patch.object(
            client,
            "call",
            side_effect=[
                {"loaderId": "loader-1", "frameId": "frame-1"},
                {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-1"}}},
            ],
        ), patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",
                {"url": "https://example.test/home", "title": "Home", "httpStatus": None},
            ]
            ok_res = helper.navigate(client, "session-1", "https://example.test/home")
            self.assertTrue(ok_res["ok"])
            self.assertEqual(ok_res["httpStatus"], 200)

        with patch.object(
            client,
            "call",
            side_effect=[
                {"loaderId": "loader-1", "frameId": "frame-1"},
                {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-1"}}},
            ],
        ), patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",
                {
                    "url": "https://example.test/home",
                    "title": "Just a moment...",
                    "bodySnippet": "Verify you are human",
                    "hasChallengeDom": True,
                    "httpStatus": 200,
                },
            ]
            chal_res = helper.navigate(client, "session-1", "https://example.test/home")
            self.assertFalse(chal_res["ok"])
            self.assertEqual(chal_res["httpStatus"], 200)
            self.assertTrue(chal_res["challengeDetected"])

    def test_navigate_captures_429_retry_after_and_redirect_chain(self):
        client = helper.CdpClient("ws://127.0.0.1:9222/test")
        client._handle_event(
            {
                "sessionId": "session-1",
                "method": "Network.requestWillBeSent",
                "params": {
                    "requestId": "req-1",
                    "loaderId": "loader-2",
                    "frameId": "frame-1",
                    "type": "Document",
                    "request": {"url": "https://example.test/start"},
                },
            }
        )
        client._handle_event(
            {
                "sessionId": "session-1",
                "method": "Network.requestWillBeSent",
                "params": {
                    "requestId": "req-1",
                    "loaderId": "loader-2",
                    "frameId": "frame-1",
                    "type": "Document",
                    "request": {"url": "https://example.test/rate-limited"},
                    "redirectResponse": {"url": "https://example.test/start", "status": 302},
                },
            }
        )
        client._handle_event(
            {
                "sessionId": "session-1",
                "method": "Network.responseReceived",
                "params": {
                    "requestId": "req-1",
                    "loaderId": "loader-2",
                    "frameId": "frame-1",
                    "type": "Document",
                    "response": {
                        "url": "https://example.test/rate-limited",
                        "status": 429,
                        "headers": {"Retry-After": "7"},
                    },
                },
            }
        )
        with patch.object(
            client,
            "call",
            side_effect=[
                {"loaderId": "loader-2", "frameId": "frame-1"},
                {"frameTree": {"frame": {"id": "frame-1", "loaderId": "loader-2"}}},
            ],
        ), patch.object(helper, "ensure_world"), patch.object(helper, "eval_json") as evaluate:
            evaluate.side_effect = [
                "complete",
                {"url": "https://example.test/rate-limited", "title": "Too Many Requests"},
            ]
            res = helper.navigate(client, "session-1", "https://example.test/start")
            self.assertFalse(res["ok"])
            self.assertEqual(res["httpStatus"], 429)
            self.assertEqual(res["retryAfterMs"], 7000)
            self.assertTrue(res["redirected"])
            self.assertEqual(
                res["redirectChain"], [{"url": "https://example.test/start", "status": 302}]
            )

    def test_clear_origin_storage_scopes_cookies_and_storage_to_target_origin(self):
        calls = []

        def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
            calls.append((method, params, session_id))
            if method == "Network.getCookies":
                return {
                    "cookies": [
                        {"name": "host_sid", "domain": "app.example.test", "path": "/"},
                        {"name": "parent_sso", "domain": ".example.test", "path": "/"},
                        {"name": "other_sid", "domain": "other.test", "path": "/"},
                    ]
                }
            if method == "Page.getFrameTree":
                return {
                    "frameTree": {
                        "frame": {
                            "id": "frame-1",
                            "securityOrigin": "https://app.example.test",
                            "url": "https://app.example.test/login",
                        }
                    }
                }
            return {}

        client = Mock()
        client.call.side_effect = fake_call

        res = helper.clear_origin_storage(
            client,
            "session-1",
            {
                "origin": "https://app.example.test",
                "includeSessionStorage": False,
                "includeSubdomainSharedCookies": False,
            },
        )
        self.assertTrue(res["ok"])
        self.assertEqual(res["origin"], "https://app.example.test")
        self.assertEqual(res["deletedCookies"], 1)
        self.assertFalse(res["clearedSessionStorage"])
        methods = [m for m, _, _ in calls]
        self.assertIn("Storage.clearDataForOrigin", methods)
        self.assertNotIn("Network.clearBrowserCookies", methods)
        self.assertNotIn("DOMStorage.clear", methods)
        deleted = [p for m, p, _ in calls if m == "Network.deleteCookies"]
        self.assertEqual(len(deleted), 1)
        self.assertEqual(deleted[0]["name"], "host_sid")

        calls.clear()
        res_with_session_and_shared = helper.clear_origin_storage(
            client,
            "session-1",
            {
                "origin": "https://app.example.test",
                "storageKey": "https://app.example.test/",
                "includeSessionStorage": True,
                "includeSubdomainSharedCookies": True,
            },
        )
        self.assertEqual(res_with_session_and_shared["deletedCookies"], 2)
        self.assertTrue(res_with_session_and_shared["clearedSessionStorage"])
        methods_2 = [m for m, _, _ in calls]
        self.assertIn("Storage.clearDataForStorageKey", methods_2)
        self.assertIn("DOMStorage.clear", methods_2)

        with self.assertRaisesRegex(ValueError, "storageType"):
            helper.clear_origin_storage(
                client,
                "session-1",
                {"origin": "https://app.example.test", "storageTypes": ["session_storage"]},
            )
        with self.assertRaisesRegex(ValueError, "storageKey"):
            helper.clear_origin_storage(
                client,
                "session-1",
                {
                    "origin": "https://app.example.test",
                    "storageKey": "https://evil.example.test/",
                },
            )

    def test_harvest_json_and_download_receipts_and_stealth_challenge(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            small_file = Path(tmpdir) / "report (1).pdf"
            small_file.write_bytes(b"hello-pdf-bytes")
            large_file = Path(tmpdir) / "huge.bin"
            large_file.write_bytes(b"x" * 2048)

            client = Mock()
            client.context_id = 7
            client._api_responses = {
                "session-1": [
                    {
                        "requestId": "req-1",
                        "url": "https://api.example.test/v1/items",
                        "status": 200,
                        "mimeType": "application/json",
                    }
                ]
            }
            client._downloads = {
                "guid-1": {
                    "guid": "guid-1",
                    "url": "https://files.example.test/report.pdf",
                    "suggestedFilename": "report.pdf",
                    "filePath": str(small_file),
                    "state": "completed",
                    "receivedBytes": 15,
                    "totalBytes": 15,
                },
                "guid-2": {
                    "guid": "guid-2",
                    "url": "https://files.example.test/huge.bin",
                    "suggestedFilename": "huge.bin",
                    "filePath": str(large_file),
                    "state": "completed",
                    "receivedBytes": 2048,
                    "totalBytes": 2048,
                },
            }

            challenge_state = {
                "hasToken": False,
                "hasChallengeDom": True,
                "title": "Just a moment...",
                "bodySnippet": "Verify you are human",
                "url": "https://example.test/protected",
            }

            def fake_call(method, params=None, *, session_id=None, timeout_s=30.0):
                if method == "Network.getResponseBody":
                    return {"body": '{"items":[{"id":1,"name":"Alpha"}]}', "base64Encoded": False}
                if method == "Page.getFrameTree":
                    return {"frameTree": {"frame": {"id": "frame-1"}}}
                if method == "Page.createIsolatedWorld":
                    return {"executionContextId": 7}
                if method == "Runtime.evaluate":
                    expr = (params or {}).get("expression", "")
                    if "hasChallengeDom" in expr:
                        return {"result": {"value": dict(challenge_state)}}
                    return {"result": {"value": True}}
                return {}

            client.call.side_effect = fake_call

            harvested = helper.harvest_json_apis(
                client, "session-1", {"urlFilter": "api.example.test", "maxItems": 5}
            )
            self.assertTrue(harvested["ok"])
            self.assertEqual(len(harvested["apis"]), 1)
            self.assertEqual(harvested["apis"][0]["data"]["items"][0]["name"], "Alpha")

            downloads = helper.collect_download_receipts(
                client, download_dir=tmpdir, max_hash_bytes=1024
            )
            self.assertEqual(len(downloads), 2)
            # guid-1 has explicit filePath to report (1).pdf and state=completed
            self.assertEqual(downloads[0]["name"], "report.pdf")
            self.assertEqual(downloads[0]["pathStatus"], "known")
            self.assertTrue(downloads[0]["path"].endswith("report (1).pdf"))
            self.assertEqual(downloads[0]["size"], 15)
            self.assertTrue(bool(downloads[0].get("sha256")))
            # guid-2 exceeded max_hash_bytes=1024, so sha256 is skipped safely
            self.assertEqual(downloads[1]["pathStatus"], "known")
            self.assertEqual(downloads[1]["size"], 2048)
            self.assertIsNone(downloads[1].get("sha256"))
            self.assertEqual(downloads[1].get("hashSkippedReason"), "exceeds_50mb_limit")

            pts = helper.bezier_pointer_points(10.0, 20.0, 210.0, 320.0, steps=12)
            self.assertEqual(len(pts), 12)
            self.assertEqual(pts[-1], (210, 320))

            # 1) When challenge remains active after click, solve_challenge MUST NOT claim solved=True
            unsolved = helper.solve_challenge(
                client, "session-1", {"x": 210, "y": 320, "settleMs": 0}
            )
            self.assertFalse(unsolved["ok"])
            self.assertTrue(unsolved["dispatched"])
            self.assertFalse(unsolved["solved"])
            self.assertEqual(unsolved["status"], "still_challenged")
            self.assertTrue(unsolved["requiresTakeover"])
            self.assertEqual(unsolved["fallback"], "request_takeover")

            # 2) When challenge DOM clears and a fresh token is populated on a valid page, solve_challenge reports verified
            obs_queue = [
                {
                    "hasToken": False,
                    "tokenValue": "",
                    "hasChallengeDom": True,
                    "httpStatus": 200,
                    "title": "Just a moment...",
                    "bodySnippet": "Verify you are human",
                    "url": "https://example.test/protected",
                },
                {
                    "hasToken": True,
                    "tokenValue": "fresh-turnstile-token-999",
                    "hasChallengeDom": False,
                    "httpStatus": 200,
                    "title": "Protected Dashboard",
                    "bodySnippet": "Welcome back",
                    "url": "https://example.test/protected",
                },
            ]

            def fake_call_transition(method, params=None, *, session_id=None, timeout_s=30.0):
                if method == "Runtime.evaluate":
                    expr = (params or {}).get("expression", "")
                    if "hasChallengeDom" in expr:
                        return {"result": {"value": obs_queue.pop(0) if obs_queue else dict(challenge_state)}}
                    return {"result": {"value": True}}
                return fake_call(method, params, session_id=session_id, timeout_s=timeout_s)

            client.call.side_effect = fake_call_transition
            solved = helper.solve_challenge(
                client, "session-1", {"x": 210, "y": 320, "settleMs": 0}
            )
            self.assertTrue(solved["ok"])
            self.assertTrue(solved["dispatched"])
            self.assertTrue(solved["solved"])
            self.assertFalse(solved["businessGoalVerified"])
            self.assertEqual(solved["status"], "verified")
            self.assertEqual(solved["clickedAt"], {"x": 210, "y": 320})

            # 3) Stale pre-existing token MUST NOT be reported as solved
            stale_queue = [
                {
                    "hasToken": True,
                    "tokenValue": "stale-token-123",
                    "hasChallengeDom": False,
                    "httpStatus": 200,
                    "title": "Login",
                    "bodySnippet": "Sign in",
                    "url": "https://example.test/login",
                },
                {
                    "hasToken": True,
                    "tokenValue": "stale-token-123",
                    "hasChallengeDom": False,
                    "httpStatus": 200,
                    "title": "Login",
                    "bodySnippet": "Sign in",
                    "url": "https://example.test/login",
                },
            ]
            obs_queue.extend(stale_queue)
            stale_res = helper.solve_challenge(
                client, "session-1", {"x": 210, "y": 320, "settleMs": 0}
            )
            self.assertFalse(stale_res["ok"])
            self.assertFalse(stale_res["solved"])
            self.assertEqual(stale_res["status"], "still_challenged")

            # 4) Challenge DOM disappearing because page navigated to HTTP 502 error page MUST NOT report solved
            error_queue = [
                {
                    "hasToken": False,
                    "tokenValue": "",
                    "hasChallengeDom": True,
                    "httpStatus": 403,
                    "title": "Just a moment...",
                    "bodySnippet": "Verify you are human",
                    "url": "https://example.test/protected",
                },
                {
                    "hasToken": False,
                    "tokenValue": "",
                    "hasChallengeDom": False,
                    "httpStatus": 502,
                    "title": "502 Bad Gateway",
                    "bodySnippet": "nginx 502 bad gateway",
                    "url": "https://example.test/protected",
                },
            ]
            obs_queue.extend(error_queue)
            err_res = helper.solve_challenge(
                client, "session-1", {"x": 210, "y": 320, "settleMs": 0}
            )
            self.assertFalse(err_res["ok"])
            self.assertFalse(err_res["solved"])
            self.assertEqual(err_res["status"], "navigation_error")
            self.assertTrue(err_res["requiresTakeover"])

            stealth = helper.apply_stealth_evasion(client, "session-1")
            self.assertEqual(stealth, {"ok": True, "stealth": True})

    def test_cross_cli_state_persistence_and_harvest_json_redaction_and_bounds(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            state_path = os.path.join(tmpdir, "browser-state.json")
            report_file = os.path.join(tmpdir, "report-final.pdf")
            Path(report_file).write_bytes(b"VERIFIED_PDF_DATA")

            # Simulate CLI process #1 receiving CDP download & API response events
            client1 = helper.CdpClient("ws://127.0.0.1:9222/devtools/browser/1", state_file=state_path)
            client1._handle_event(
                {
                    "method": "Browser.downloadWillBegin",
                    "params": {
                        "guid": "dl-guid-101",
                        "url": "https://files.example.test/report-final.pdf",
                        "suggestedFilename": "report-final.pdf",
                    },
                }
            )
            client1._handle_event(
                {
                    "method": "Browser.downloadProgress",
                    "params": {
                        "guid": "dl-guid-101",
                        "state": "completed",
                        "receivedBytes": 17,
                        "totalBytes": 17,
                        "filePath": report_file,
                    },
                }
            )
            client1._api_responses["session-1"] = [
                {
                    "requestId": "req-secret",
                    "url": "https://api.example.test/v1/auth/session",
                    "status": 200,
                    "mimeType": "application/json",
                }
            ]
            client1.call = Mock(
                return_value={
                    "body": json.dumps(
                        {
                            "user": "alice",
                            "accessToken": "super-secret-jwt",
                            "nested": {"password": "my-password", "apiKey": "k-12345", "visible": "ok"},
                        }
                    ),
                    "base64Encoded": False,
                }
            )
            helper.flush_and_persist_state(client1, "session-1")

            # Simulate CLI process #2 starting fresh and reading persisted state
            client2 = helper.CdpClient("ws://127.0.0.1:9222/devtools/browser/1", state_file=state_path)
            client2.call = Mock(return_value={})
            receipts = helper.collect_download_receipts(client2, download_dir=tmpdir)
            self.assertEqual(len(receipts), 1)
            self.assertEqual(receipts[0]["guid"], "dl-guid-101")
            self.assertEqual(receipts[0]["pathStatus"], "known")
            self.assertEqual(receipts[0]["path"], report_file)

            harvested = helper.harvest_json_apis(client2, "session-2", {"urlFilter": "api.example.test"})
            self.assertTrue(harvested["ok"])
            self.assertEqual(len(harvested["apis"]), 1)
            api_data = harvested["apis"][0]["data"]
            self.assertEqual(api_data["user"], "alice")
            self.assertEqual(api_data["accessToken"], "[REDACTED]")
            self.assertEqual(api_data["nested"]["password"], "[REDACTED]")
            self.assertEqual(api_data["nested"]["apiKey"], "[REDACTED]")
            self.assertEqual(api_data["nested"]["visible"], "ok")

    def test_collect_download_receipts_never_fabricates_identity_from_preexisting_files_or_inprogress_state(self):
        with tempfile.TemporaryDirectory() as tmpdir, tempfile.TemporaryDirectory() as other_dir:
            old_path = Path(tmpdir) / "report.pdf"
            new_path = Path(tmpdir) / "report (1).pdf"
            outside_path = Path(other_dir) / "outside.pdf"
            old_bytes = b"OLD_REPORT_SYNTHETIC_CONTENT"
            new_bytes = b"NEW_REPORT_SYNTHETIC_CONTENT"
            old_path.write_bytes(old_bytes)
            new_path.write_bytes(new_bytes)
            outside_path.write_bytes(b"OUTSIDE_SECRET")

            # 1) Completed receipt without reported filePath MUST NOT guess report.pdf or report (1).pdf
            collision_client = Mock()
            collision_client._downloads = {
                "new-guid": {
                    "guid": "new-guid",
                    "url": "https://files.example.test/report.pdf",
                    "suggestedFilename": "report.pdf",
                    "state": "completed",
                    "receivedBytes": len(new_bytes),
                    "totalBytes": len(new_bytes),
                }
            }
            collision_receipts = helper.collect_download_receipts(
                collision_client, download_dir=tmpdir
            )
            self.assertEqual(len(collision_receipts), 1)
            self.assertEqual(collision_receipts[0]["guid"], "new-guid")
            self.assertEqual(collision_receipts[0]["state"], "completed")
            self.assertEqual(collision_receipts[0]["pathStatus"], "unknown")
            self.assertNotIn("path", collision_receipts[0])
            self.assertNotIn("sha256", collision_receipts[0])
            self.assertNotIn("size", collision_receipts[0])

            # 2) inProgress receipt MUST NOT attach path or sha256 even if old/new files exist or filePath is set
            inprogress_client = Mock()
            inprogress_client._downloads = {
                "in-progress-guid": {
                    "guid": "in-progress-guid",
                    "url": "https://files.example.test/report.pdf",
                    "suggestedFilename": "report.pdf",
                    "filePath": str(new_path),
                    "state": "inProgress",
                    "receivedBytes": 4,
                    "totalBytes": len(new_bytes),
                }
            }
            inprogress_receipts = helper.collect_download_receipts(
                inprogress_client, download_dir=tmpdir
            )
            self.assertEqual(len(inprogress_receipts), 1)
            self.assertEqual(inprogress_receipts[0]["guid"], "in-progress-guid")
            self.assertEqual(inprogress_receipts[0]["state"], "inProgress")
            self.assertEqual(inprogress_receipts[0]["pathStatus"], "unknown")
            self.assertNotIn("path", inprogress_receipts[0])
            self.assertNotIn("sha256", inprogress_receipts[0])
            self.assertNotIn("size", inprogress_receipts[0])

            # 3) Completed receipt with filePath outside download_dir is rejected
            outside_client = Mock()
            outside_client._downloads = {
                "outside-guid": {
                    "guid": "outside-guid",
                    "url": "https://files.example.test/outside.pdf",
                    "suggestedFilename": "outside.pdf",
                    "filePath": str(outside_path),
                    "state": "completed",
                }
            }
            outside_receipts = helper.collect_download_receipts(
                outside_client, download_dir=tmpdir
            )
            self.assertEqual(len(outside_receipts), 1)
            self.assertEqual(outside_receipts[0]["pathStatus"], "unknown")
            self.assertNotIn("path", outside_receipts[0])
            self.assertNotIn("sha256", outside_receipts[0])

            # 4) Positive control: completed receipt with explicit filePath inside download_dir succeeds
            explicit_client = Mock()
            explicit_client._downloads = {
                "explicit-guid": {
                    "guid": "explicit-guid",
                    "url": "https://files.example.test/report.pdf",
                    "suggestedFilename": "report.pdf",
                    "filePath": str(new_path),
                    "state": "completed",
                    "receivedBytes": len(new_bytes),
                    "totalBytes": len(new_bytes),
                }
            }
            explicit_receipts = helper.collect_download_receipts(
                explicit_client, download_dir=tmpdir
            )
            self.assertEqual(len(explicit_receipts), 1)
            self.assertEqual(explicit_receipts[0]["guid"], "explicit-guid")
            self.assertEqual(explicit_receipts[0]["state"], "completed")
            self.assertEqual(explicit_receipts[0]["pathStatus"], "known")
            self.assertEqual(explicit_receipts[0]["path"], str(new_path))
            self.assertEqual(explicit_receipts[0]["size"], len(new_bytes))

    def test_playlist_recorder_uses_supported_page_browser_commands_and_checks_json_results(self):
        recorder_path = Path(__file__).with_name("rakazo-record-playlist")
        loader = SourceFileLoader("rakazo_record_playlist", str(recorder_path))
        spec = spec_from_loader(loader.name, loader)
        assert spec is not None and spec.loader is not None
        recorder = module_from_spec(spec)
        spec.loader.exec_module(recorder)

        seen_cmds: list[list[str]] = []

        def fake_run(cmd, capture_output=True, text=True, timeout=None):
            seen_cmds.append(list(cmd))
            if cmd[0] == "pactl":
                return subprocess.CompletedProcess(cmd, 1, stdout="", stderr="Connection failure: Connection refused")
            if cmd[1] == "navigate":
                payload = json.loads(cmd[2])
                if "fail" in payload["url"]:
                    return subprocess.CompletedProcess(
                        cmd, 0, stdout='{"ok": false, "error": "HTTP 500 error"}\n', stderr=""
                    )
                return subprocess.CompletedProcess(
                    cmd,
                    0,
                    stdout=json.dumps({"ok": True, "url": payload["url"], "title": "Clip 1"}) + "\n",
                    stderr="",
                )
            if cmd[1] == "click_selector":
                payload = json.loads(cmd[2])
                if payload["selector"] == "#missing":
                    return subprocess.CompletedProcess(
                        cmd,
                        0,
                        stdout='{"ok": false, "clicked": false, "error": "No element"}\n',
                        stderr="",
                    )
                return subprocess.CompletedProcess(
                    cmd, 0, stdout='{"ok": true, "clicked": true}\n', stderr=""
                )
            return subprocess.CompletedProcess(cmd, 2, stdout="", stderr="unknown command")

        with patch.object(recorder.shutil, "which", return_value="/usr/local/bin/rakazo-page-browser"), \
             patch.object(recorder.subprocess, "run", side_effect=fake_run):
            self.assertFalse(recorder.has_live_pulse_source("rakazo_sink.monitor"))
            ok_nav = recorder.navigate_url("https://example.test/clip1")
            self.assertTrue(ok_nav["ok"])
            self.assertEqual(seen_cmds[-1][1], "navigate")

            bad_nav = recorder.navigate_url("https://example.test/fail")
            self.assertFalse(bad_nav["ok"])
            self.assertIn("HTTP 500", bad_nav["error"])

            ok_adv = recorder.advance_next_clip(".next-button")
            self.assertTrue(ok_adv["ok"])
            self.assertEqual(seen_cmds[-1][1], "click_selector")

            bad_adv = recorder.advance_next_clip("#missing")
            self.assertFalse(bad_adv["ok"])

    def test_transcribe_and_doc_extract_cli_contracts(self):
        transcribe_path = Path(__file__).with_name("rakazo-transcribe")
        t_loader = SourceFileLoader("rakazo_transcribe", str(transcribe_path))
        t_spec = spec_from_loader(t_loader.name, t_loader)
        assert t_spec is not None and t_spec.loader is not None
        transcribe = module_from_spec(t_spec)
        t_spec.loader.exec_module(transcribe)

        self.assertEqual(transcribe.format_srt_timestamp(0.0), "00:00:00,000")
        self.assertEqual(transcribe.format_srt_timestamp(65.432), "00:01:05,432")
        self.assertEqual(transcribe.resolve_provider_and_key("", ""), ("groq", ""))
        self.assertEqual(transcribe.resolve_provider_and_key("openai", "sk-test"), ("openai", "sk-test"))
        self.assertEqual(
            transcribe.redact_secret("Bearer sk-secret-key-999 failed", "sk-secret-key-999"),
            "Bearer [REDACTED] failed",
        )
        # Missing API key returns exit code 2 with structured error
        self.assertEqual(transcribe.main(["dummy.mp3", "--provider", "groq", "--api-key", ""]), 2)
        # Missing input file with valid key returns exit code 1
        self.assertEqual(
            transcribe.main(["/nonexistent/file.mp3", "--provider", "groq", "--api-key", "gsk_test"]),
            1,
        )

        doc_path = Path(__file__).with_name("rakazo-doc-extract")
        d_loader = SourceFileLoader("rakazo_doc_extract", str(doc_path))
        d_spec = spec_from_loader(d_loader.name, d_loader)
        assert d_spec is not None and d_spec.loader is not None
        doc_extract = module_from_spec(d_spec)
        sys.modules[d_spec.name] = doc_extract
        d_spec.loader.exec_module(doc_extract)

        with tempfile.TemporaryDirectory() as tmpdir:
            sample_txt = Path(tmpdir) / "notes.txt"
            sample_txt.write_text("สวัสดีครับ Rakazo Document Test", encoding="utf-8")
            extracted = doc_extract.extract_document(sample_txt)
            self.assertTrue(extracted["ok"])
            self.assertEqual(extracted["type"], "text")
            self.assertIn("สวัสดีครับ", extracted["text"])

            # Missing document returns ok=False and exit code 1
            missing_doc = doc_extract.extract_document(Path(tmpdir) / "missing.pdf")
            self.assertFalse(missing_doc["ok"])
            self.assertEqual(doc_extract.main([str(Path(tmpdir) / "missing.pdf")]), 1)

            # Corrupt PDF returns ok=False when extractors fail
            corrupt_pdf = Path(tmpdir) / "corrupt.pdf"
            corrupt_pdf.write_bytes(b"NOT_A_PDF")
            with patch.object(doc_extract.shutil, "which", return_value=None):
                corrupt_res = doc_extract.extract_document(corrupt_pdf)
                self.assertFalse(corrupt_res["ok"])


if __name__ == "__main__":
    unittest.main()


