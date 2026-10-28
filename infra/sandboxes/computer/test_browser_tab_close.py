"""Run the actual tab-close CLI branch with bounded offline CDP responses."""
import contextlib
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch

loader = importlib.machinery.SourceFileLoader('tab_close_helper', str(Path(__file__).with_name('rakazo-page-browser')))
spec = importlib.util.spec_from_loader(loader.name, loader)
helper = importlib.util.module_from_spec(spec)
loader.exec_module(helper)


class TabCloseTests(unittest.TestCase):
    def invoke(self, reply=None, after=None, failure=None, target='target-one', selectors=None):
        calls = []
        class Client:
            def __init__(self, *args, **kwargs):
                self._active_target_id = 'survivor'
                self._opener_map = {'target-one': 'survivor'}
            def connect(self): pass
            def close(self): pass
            def call(self, method, params=None, **kwargs):
                calls.append((method, params))
                if failure: raise failure
                return reply
        output = io.StringIO()
        before = [{'targetId': 'target-one'}, {'targetId': 'survivor'}]
        with patch.dict(os.environ, {'RAKAZO_BROWSER_WATCH_STDIN':'0','RAKAZO_BROWSER_ARGS_STDIN':'0'}), \
             patch.object(helper,'wait_for_cdp'), patch.object(helper,'discover_ws_url',return_value='ws://fixture'), \
             patch.object(helper,'CdpClient',Client), patch.object(helper,'attach_page',return_value='session'), \
             patch.object(helper,'activate_selected_page'), patch.object(helper,'flush_and_persist_state'), \
             patch.object(helper,'list_browser_tabs',side_effect=[before, after if after is not None else [{'targetId':'survivor'}]]), \
             patch.object(helper.time,'sleep'), contextlib.redirect_stdout(output):
            self.assertEqual(helper.run(['helper','tab_close',json.dumps(selectors if selectors is not None else {'targetId':target})]),0)
        return json.loads(output.getvalue()), calls

    def test_cdp_exception_is_not_ignored(self):
        result, _ = self.invoke(failure=RuntimeError('CDP close rejected'))
        self.assertFalse(result['ok'])
        self.assertIn('CDP close rejected',result['error'])
        self.assertTrue(result['uncertain'])
        self.assertNotIn('closedTargetId',result)

    def test_deprecated_acknowledgement_is_not_the_success_oracle(self):
        for reply in ({}, {'success':False}, None):
            with self.subTest(reply=reply):
                result, _ = self.invoke(reply=reply)
                self.assertTrue(result['ok'])
                self.assertEqual(result['closedTargetId'],'target-one')

    def test_acknowledged_close_must_remove_target_and_preserve_survivor(self):
        for after in ([{'targetId':'target-one'},{'targetId':'survivor'}], []):
            with self.subTest(after=after):
                result, _ = self.invoke(reply={'success':True},after=after)
                self.assertFalse(result['ok'])
                self.assertNotIn('closedTargetId',result)

    def test_absent_target_cannot_claim_a_close(self):
        result, calls = self.invoke(reply={'success':True},target='absent')
        self.assertFalse(result['ok'])
        self.assertEqual(calls,[])
        self.assertFalse(result['uncertain'])

    def test_unmatched_selector_never_closes_active_survivor(self):
        for selectors in ({'urlIncludes':'not-present'}, {'titleIncludes':'not-present'}):
            result,calls=self.invoke(reply={'success':True},selectors=selectors)
            self.assertFalse(result['ok'])
            self.assertEqual(calls,[])
            self.assertFalse(result['uncertain'])

    def test_actual_acknowledgement_and_post_inventory_establish_close(self):
        result, calls = self.invoke(reply={'success':True})
        self.assertTrue(result['ok'])
        self.assertEqual(result['closedTargetId'],'target-one')
        self.assertEqual(result['tabs'],[{'targetId':'survivor'}])
        self.assertEqual(calls,[('Target.closeTarget',{'targetId':'target-one'})])


if __name__ == '__main__':
    unittest.main()
