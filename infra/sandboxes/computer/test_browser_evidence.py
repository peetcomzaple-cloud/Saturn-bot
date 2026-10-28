"""Exercise evidence hooks in the actual isolated helper, without a model or network."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
SOURCE = HERE / 'rakazo-page-browser'
loader = importlib.machinery.SourceFileLoader('actual_captured_helper', str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class ProductEvidenceTests(unittest.TestCase):
    def capture(self, command='snapshot'):
        evidence = helper.BrowserEvidence('run-current', 'execution-one', command)
        evidence.reply('Target.attachToTarget', {'targetId':'target-one'}, {'sessionId':'session-one'}, None)
        evidence.selected('session-one', 'target-one')
        return evidence

    def request(self, evidence, sid='session-one', rid='123.1', method='POST', kind='XHR'):
        evidence.event({'method':'Network.requestWillBeSent', 'sessionId':sid, 'params':{
            'requestId':rid, 'type':kind, 'request':{'url':'https://fixture.test/forms/order-submit?case=one',
                'method':method, 'headers':{'authorization':'SECRET-HEADER'}, 'postData':'SECRET-BODY'}}})

    def test_missing_or_invalid_context_disables_capture(self):
        for run, execution in ((None,None), ('run',None), ('', 'exec'), ('run','bad\nexec'), ('run', True)):
            evidence = helper.BrowserEvidence(run, execution, 'snapshot')
            self.assertIsNone(evidence.finish({'ok':True}))

    def test_real_pi_execution_identity_is_preserved(self):
        execution = json.dumps(['pi-tool','main','call-1'], separators=(',',':'))
        evidence = helper.BrowserEvidence('run-current', execution, 'snapshot')
        evidence.reply('Target.attachToTarget', {'targetId':'target-one'}, {'sessionId':'session-one'}, None)
        evidence.selected('session-one','target-one')
        self.assertEqual(evidence.finish({'ok':True,'targetId':'target-one'})['executionId'],execution)

    def test_only_selected_actual_attach_can_qualify(self):
        evidence = self.capture()
        evidence.reply('Target.attachToTarget', {'targetId':'other'}, {'sessionId':'candidate-session'}, None)
        result = evidence.finish({'ok':True, 'targetId':'target-one'})
        self.assertTrue(result['complete'])
        self.assertEqual(result['events'][-1]['sessionId'], 'session-one')
        evidence.selected('unknown-session', 'other')
        self.assertFalse(evidence.finish({'ok':True, 'targetId':'other'})['complete'])

    def test_snapshot_for_another_target_cannot_claim_selected_session(self):
        self.assertFalse(self.capture().finish({'ok':True, 'targetId':'other'})['complete'])

    def test_xhr_post_keeps_request_identity_without_private_data(self):
        evidence = self.capture('act')
        self.request(evidence)
        evidence.event({'method':'Network.responseReceived', 'sessionId':'session-one', 'params':{
            'requestId':'123.1', 'response':{'status':504, 'headers':{'set-cookie':'SECRET-COOKIE'},
                                           'body':'SECRET-RESPONSE'}}})
        output = evidence.finish({'ok':False, 'error':'SECRET-ERROR', 'tree':'SECRET-DOM'})
        encoded = json.dumps(output)
        self.assertNotIn('SECRET', encoded)
        self.assertNotIn('https://', encoded)
        self.assertEqual(output['events'][-2]['status'], 504)
        self.assertEqual(output['events'][-2]['requestId'], '123.1')
        self.assertEqual(output['events'][-2]['requestMethod'], 'POST')

    def test_request_ids_are_scoped_to_the_actual_session(self):
        evidence = self.capture('act')
        self.request(evidence)
        evidence.reply('Target.attachToTarget', {'targetId':'other'}, {'sessionId':'session-two'}, None)
        evidence.event({'method':'Network.loadingFailed', 'sessionId':'session-two',
                        'params':{'requestId':'123.1','errorText':'net::ERR_CONNECTION_RESET'}})
        self.assertFalse(any(e['method']=='Network.loadingFailed' for e in evidence.events))
        evidence.event({'method':'Network.loadingFailed', 'sessionId':'session-one',
                        'params':{'requestId':'123.1','errorText':'private arbitrary error'}})
        self.assertEqual(evidence.events[-1]['errorCode'], 'OTHER')

    def test_bounds_mark_capture_incomplete(self):
        evidence = self.capture()
        for _ in range(200):
            evidence.add('helper.selected', sessionId='session-one', targetId='target-one')
        envelope = evidence.finish({'ok':True,'targetId':'target-one'})
        self.assertFalse(envelope['complete'])
        self.assertEqual(len(envelope['events']),160)

    def test_url_fingerprint_preserves_query_without_credentials_or_fragment(self):
        fingerprint = helper.BrowserEvidence.url_fingerprint
        self.assertEqual(fingerprint('HTTPS://user:password@Fixture.Test:443/path?q=1#fragment'),
                         fingerprint('https://fixture.test/path?q=1'))
        self.assertNotEqual(fingerprint('https://fixture.test/path?q=1'), fingerprint('https://fixture.test/path?q=2'))
        self.assertNotEqual(fingerprint('http://[::1]:8080/'), fingerprint('http://[::1]:8081/'))

    def test_actual_client_event_hook_observes_xhr_before_document_filter(self):
        client = helper.CdpClient('ws://127.0.0.1:9222/devtools/browser/fixture')
        client._evidence = self.capture('act')
        client._handle_event({'method':'Network.requestWillBeSent','sessionId':'session-one','params':{
            'requestId':'321.2','type':'XHR','request':{'method':'POST','url':'https://fixture.test/forms/order-submit'}}})
        self.assertTrue(any(e.get('requestId')=='321.2' for e in client._evidence.events))
        self.assertNotIn(('session-one','321.2'), client._document_requests)

    def test_actual_target_switch_updates_action_result_attribution(self):
        client = helper.CdpClient('ws://127.0.0.1:9222/devtools/browser/fixture')
        client._evidence = self.capture('act')
        def rpc(method, params=None, **kwargs):
            result = {'sessionId':'session-two'} if method == 'Target.attachToTarget' else {}
            helper.evidence_call(client,'reply',method,params or {},result,kwargs.get('session_id'))
            return result
        client.call = rpc
        with patch.object(client,'save_persisted_state'):
            self.assertEqual(helper.switch_to_target(client,'target-two'),'session-two')
        result = client._evidence.finish({'ok':True,'targetId':'target-two'})
        self.assertTrue(result['complete'])
        self.assertEqual(result['events'][-1]['sessionId'],'session-two')
        self.assertEqual(result['events'][-1]['targetId'],'target-two')
        self.assertFalse(client._evidence.finish({'ok':True,'targetId':'target-one'})['complete'])

    def test_actual_client_records_write_and_browser_level_read_loss(self):
        class Socket:
            def settimeout(self, timeout): pass
        for loss in ('write','read'):
            client = helper.CdpClient('ws://127.0.0.1:9222/devtools/browser/fixture')
            client._evidence = self.capture('act')
            client._sock = Socket()
            client._send_frame = lambda *args: None
            if loss == 'write':
                client._send_frame = lambda *args: (_ for _ in ()).throw(BrokenPipeError('closed'))
            else:
                client._read_frame = lambda: (_ for _ in ()).throw(RuntimeError('CDP websocket closed by peer'))
            with self.assertRaises((BrokenPipeError,RuntimeError)):
                client.call('Target.getTargets',timeout_s=0.1)
            fault = client._evidence.events[-1]
            self.assertEqual((fault['method'],fault['sessionId'],fault['targetId']),
                             ('transport.closed','session-one','target-one'))
        evidence = helper.BrowserEvidence('run-current','execution-one','snapshot')
        evidence.transport_failed(None)
        self.assertFalse(evidence.finish({'ok':False})['complete'])

    def test_actual_helper_completion_does_not_count_intentional_close_as_disconnect(self):
        close_calls = []
        class Client:
            def __init__(self, *args, **kwargs):
                self._active_target_id = 'target-one'
            def connect(self): pass
            def close(self): close_calls.append(True)
            def call(self, method, params=None, **kwargs):
                if method == 'Page.bringToFront':
                    return {}
                if method == 'Runtime.evaluate':
                    return {'result': {'value': True}}
                raise AssertionError('Unexpected CDP call: ' + method)
        def attach(client):
            client._evidence.reply('Target.attachToTarget', {'targetId':'target-one'}, {'sessionId':'session-one'}, None)
            return 'session-one'
        output = io.StringIO()
        with patch.dict(os.environ, {'RAKAZO_BROWSER_RUN_ID':'run-current', 'RAKAZO_BROWSER_EXECUTION_ID':'execution-one',
                                     'RAKAZO_BROWSER_WATCH_STDIN':'0','RAKAZO_BROWSER_ARGS_STDIN':'0'}), \
             patch.object(helper,'wait_for_cdp'), patch.object(helper,'discover_ws_url',return_value='ws://fixture'), \
             patch.object(helper,'CdpClient',Client), patch.object(helper,'attach_page',side_effect=attach), \
             patch.object(helper,'snapshot',return_value={'ok':True,'targetId':'target-one'}), \
             patch.object(helper,'flush_and_persist_state'), contextlib.redirect_stdout(output):
            self.assertEqual(helper.run(['helper','snapshot','{}']),0)
        evidence = json.loads(output.getvalue())['_browserEvidence']
        self.assertTrue(evidence['complete'])
        self.assertTrue(evidence['events'][-1]['ok'])
        self.assertEqual(close_calls,[True])
        self.assertFalse(any(e['method']=='transport.closed' for e in evidence['events']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
