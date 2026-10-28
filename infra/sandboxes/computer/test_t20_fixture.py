import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import sys

sys.path.insert(0,str(Path(__file__).parent))
import t20_desktop_fixture as fixture


class IndependentFixtureTests(unittest.TestCase):
    def test_process_title_rewrite_matches_only_the_complete_profile_flag(self):
        self.assertTrue(fixture.has_profile(['chromium --user-data-dir=/bot-profile --app=file:///fixture'], '/bot-profile'))
        self.assertTrue(fixture.has_profile(['chromium', '--user-data-dir=/bot-profile'], '/bot-profile'))
        for argv in [['chromium --user-data-dir=/bot-profile-other'], ['chromium --app=file:///--user-data-dir=/bot-profile'], ['chromium']]:
            self.assertFalse(fixture.has_profile(argv, '/bot-profile'))

    def test_launches_an_independent_profile_without_a_debugging_transport_and_preserves_existing_windows(self):
        with tempfile.TemporaryDirectory() as parent:
            folder=Path(parent)/'round'
            bot={'id':'0x1','pid':100,'startTicks':10,'title':'bot','wmClass':'bot.Chromium','argv':['chromium','--user-data-dir=/bot-profile']}
            target={'id':'0x2','pid':200,'startTicks':20,'title':'T20 independent fixture aaaaaaaaaaaa','wmClass':'fixture.Chromium','argv':[]}
            process=SimpleNamespace(pid=200,poll=lambda:None)
            with patch.object(fixture,'window_inventory',side_effect=[[bot],[bot,target]]),patch.object(fixture.uuid,'uuid4',return_value=SimpleNamespace(hex='a'*32)),patch.object(fixture.subprocess,'Popen',return_value=process) as launch,patch.object(fixture,'fixture_network_evidence',return_value={'cdpIsolationVerified':True,'listeningSockets':[],'argv':['chromium','--user-data-dir='+str(folder/'fixture-profile')]}):
                result=fixture.prepare_fixture(folder,'/bot-profile')
            argv=launch.call_args.args[0]
            self.assertFalse(any('remote-debugging' in arg for arg in argv))
            self.assertIn('--user-data-dir='+str(folder/'fixture-profile'),argv)
            self.assertEqual(result['botWindowIds'],['0x1'])
            self.assertEqual(result['windowId'],'0x2')
            self.assertEqual(json.loads((folder/'FIXTURE.json').read_text())['pid'],200)

    def test_no_bot_window_stops_preparation_before_launch(self):
        with tempfile.TemporaryDirectory() as parent,patch.object(fixture,'window_inventory',return_value=[]),patch.object(fixture.subprocess,'Popen') as launch:
            with self.assertRaisesRegex(ValueError,'No bot browser'):
                fixture.prepare_fixture(Path(parent)/'round','/bot-profile')
            launch.assert_not_called()

    def test_capture_is_nonempty_immutable_and_precedes_any_teardown(self):
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'DISPLAY':':99'}),patch.object(fixture,'window_inventory',return_value=[{'id':'0x1'}]),patch.object(fixture.subprocess,'run',return_value=SimpleNamespace(stdout=b'\x89PNG\r\n\x1a\n'+b'pixels'*100)):
            result=fixture.capture(folder,'before','container','a'*40)
            self.assertTrue(result['collectedBeforeTeardown'])
            self.assertTrue(result['inventoryComplete'])
            self.assertGreater((Path(folder)/'before.png').stat().st_size,100)
            with self.assertRaises(FileExistsError):
                fixture.capture(folder,'before','container','a'*40)

    def test_baseline_capture_matches_the_collector_contract_without_overwriting_evidence(self):
        image = b'\x89PNG\r\n\x1a\n' + b'pixels' * 100
        with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'DISPLAY':':99'}),patch.object(fixture,'window_inventory',return_value=[{'id':'0x1'}]),patch.object(fixture.subprocess,'run',return_value=SimpleNamespace(stdout=image)):
            baseline = fixture.capture(folder,'baseline','container','a'*40)
            self.assertEqual(baseline['imageFile'],'baseline.png')
            self.assertEqual(json.loads((Path(folder)/'baseline.json').read_text()),baseline)
            self.assertEqual((Path(folder)/'baseline.png').read_bytes(),image)
            with self.assertRaises(FileExistsError):
                fixture.capture(folder,'baseline','container','a'*40)
            after = fixture.capture(folder,'after','container','a'*40,'run-1')
            self.assertEqual(after['runId'],'run-1')
            self.assertEqual((Path(folder)/'baseline.png').read_bytes(),image)

    def test_invalid_capture_labels_are_rejected_before_any_observation(self):
        with tempfile.TemporaryDirectory() as folder,patch.object(fixture,'window_inventory') as inventory:
            for label in ['../baseline','unknown','']:
                with self.subTest(label=label),self.assertRaisesRegex(ValueError,'Invalid capture label'):
                    fixture.capture(folder,label,'container','a'*40)
            inventory.assert_not_called()
            self.assertEqual(list(Path(folder).iterdir()),[])


if __name__=='__main__':
    unittest.main()
