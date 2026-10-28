import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from t20_acceptance import evaluate


class AcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        image = b'\x89PNG\r\n\x1a\n' + b'fixture-pixels' * 30
        for label in ['before', 'after']:
            (self.root / (label + '.png')).write_bytes(image)
        bot = {'id': '0x1', 'pid': 100, 'startTicks': 11, 'wmClass': 'bot.Chromium'}
        target = {'id': '0x2', 'pid': 200, 'startTicks': 22, 'wmClass': 'fixture.Chromium'}
        survivor = {'id': '0x3', 'pid': 300, 'startTicks': 33, 'wmClass': 'OtherApp'}
        sha = 'a' * 40
        before = {'runId': 'run', 'buildSha': sha, 'containerId': 'container', 'display': ':99',
                  'containerRunning': True, 'collectedBeforeTeardown': True, 'inventoryComplete': True,
                  'inventoryAt': '2026-01-01T00:00:00Z', 'capturedAt': '2026-01-01T00:00:01Z',
                  'windows': [bot, target, survivor], 'imageFile': 'before.png', 'imageSha256': hashlib.sha256(image).hexdigest()}
        after = {**before, 'windows': copy.deepcopy([bot, survivor]), 'inventoryAt': '2026-01-01T00:00:09Z',
                 'capturedAt': '2026-01-01T00:00:10Z', 'imageFile': 'after.png'}
        events = []
        for index, name in enumerate(['computer_observe', 'computer_act']):
            payload = {'name': name, 'executionId': str(index)}
            events += [{'runId': 'run', 'type': 'agent.tool.called', 'payload': payload},
                       {'runId': 'run', 'type': 'agent.tool.completed', 'payload': {**payload,
                        'outcome': 'succeeded', 'windowInventoryStatus': 'validnonempty',
                        'windows': copy.deepcopy([bot, target, survivor] if name == 'computer_observe' else [bot, survivor]),
                        **({'windowCloseVerification': {'verified': True}} if name == 'computer_act' else {})}}]
        self.packet = {
            'build': {'expectedSha': sha, 'sourceManifestVerified': True, 'runtime': 'pi',
                      'serviceShas': dict.fromkeys(['api', 'worker', 'supervisor'], sha)},
            'settingsBefore': {'modelProvider': None, 'modelId': None},
            'settingsAfter': {'modelProvider': None, 'modelId': None},
            'fixture': {'title': 'T20 fixture', 'windowId': '0x2', 'pid': 200, 'startTicks': 22,
                        'profile': '/fixture-profile', 'botProfile': '/bot-profile', 'botWindowIds': ['0x1'],
                        'cdpIsolationVerified': True, 'listeningSockets': [], 'argv': ['chromium', '--user-data-dir=/fixture-profile']},
            'before': before, 'after': after, 'teardownStarted': False,
            'modelEvidence': {'provider': 'fixture-provider', 'modelId': 'vision-v1', 'capability': 'vision', 'source': 'catalog'},
            'product': {
                'runs': [{'id': 'run', 'status': 'completed', 'error': None, 'startedAt': '2026-01-01T00:00:02Z',
                          'completedAt': '2026-01-01T00:00:08Z', 'actualModelProvider': 'fixture-provider', 'actualModelId': 'vision-v1'}],
                'attempts': [{'runId': 'run', 'status': 'completed'}], 'events': events,
                'effects': [{'runId': 'run', 'kind': 'computer_act', 'status': 'completed', 'idempotencyKey': 'once', 'request': {'actions': 'close'}}],
                'finalMessages': [{'runId': 'run', 'role': 'bot', 'blocks': [{'kind': 'text', 'text': 'T20 fixture closed.'}]}],
            },
        }

    def tearDown(self):
        self.folder.cleanup()

    def test_complete_synthetic_evidence_satisfies_the_oracle(self):
        self.assertEqual(evaluate(self.packet, self.root)['verdict'], 'PASS')

    def test_every_missing_top_level_evidence_is_a_failure(self):
        for key in self.packet:
            with self.subTest(key=key):
                packet = copy.deepcopy(self.packet)
                del packet[key]
                self.assertEqual(evaluate(packet, self.root)['verdict'], 'FAIL')

    def test_answered_question_attempts_are_allowed_without_replaying_effects(self):
        self.packet['product']['attempts'].insert(0, {'runId': 'run', 'status': 'waiting_input', 'error': None})
        self.assertEqual(evaluate(self.packet, self.root)['verdict'], 'PASS')

    def test_lifecycle_loss_before_the_first_observation_is_a_failure(self):
        self.packet['product']['events'][1]['payload']['windows'] = [self.packet['before']['windows'][1]]
        result = evaluate(self.packet, self.root)
        self.assertEqual(result['verdict'], 'FAIL')
        self.assertIn('Initial bot observation does not contain the full baseline', result['failures'])

    def test_uncertain_and_each_acceptance_violation_fail_closed(self):
        violations = [
            lambda p: p['before'].update(inventoryAt='2025-12-31T23:00:00Z', capturedAt='2025-12-31T23:00:01Z'),
            lambda p: p['product']['runs'][0].update(startedAt='2026-01-01T00:00:02'),
            lambda p: p['product']['attempts'].insert(0, {'runId': 'run', 'status': 'failed'}),
            lambda p: p['product']['attempts'].append(copy.deepcopy(p['product']['attempts'][0])),
            lambda p: p['fixture'].update(profile='/bot-profile'),
            lambda p: p['fixture'].update(listeningSockets=[{'port': 9222}]),
            lambda p: p['fixture']['argv'].append('--remote-debugging-port=9222'),
            lambda p: p['settingsAfter'].update(modelId='changed'),
            lambda p: p['modelEvidence'].update(capability='orphan'),
            lambda p: p['product']['runs'][0].update(actualModelId='model-latest'),
            lambda p: p['product']['runs'][0].update(actualModelId='auto'),
            lambda p: p['build'].update(runtime='scripted'),
            lambda p: p['build']['serviceShas'].update(worker='b' * 40),
            lambda p: p['after'].update(inventoryComplete=False),
            lambda p: p['after'].update(windows=p['before']['windows']),
            lambda p: p['after'].update(windows=p['after']['windows'][:1]),
            lambda p: p['after']['windows'][0].update(startTicks=999),
            lambda p: p['after'].update(containerRunning=False),
            lambda p: p['after'].update(collectedBeforeTeardown=False),
            lambda p: p['after'].update(runId='other-run'),
            lambda p: p['after'].update(imageSha256='0' * 64),
            lambda p: p['after'].update(imageFile='../outside.png'),
            lambda p: p['product']['events'][0]['payload'].update(name='browser_act'),
            lambda p: p['product']['events'].pop(),
            lambda p: p['product']['events'][3]['payload'].update(uncertain=True),
            lambda p: p['product']['events'][3]['payload'].update(windowInventoryStatus='unknown'),
            lambda p: p['product']['events'][3]['payload'].update(outcome='error'),
            lambda p: p['product']['effects'].append(copy.deepcopy(p['product']['effects'][0])),
            lambda p: p['product']['runs'][0].update(status='failed'),
            lambda p: p['product']['finalMessages'][0]['blocks'][0].update(text='Could not close T20 fixture'),
            lambda p: p.update(teardownStarted=True),
        ]
        for index, violation in enumerate(violations):
            with self.subTest(index=index):
                packet = copy.deepcopy(self.packet)
                violation(packet)
                self.assertEqual(evaluate(packet, self.root)['verdict'], 'FAIL')


if __name__ == '__main__':
    unittest.main()
