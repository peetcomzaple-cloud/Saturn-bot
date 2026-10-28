"""Strict offline oracle for the owner's seven T20 live acceptance criteria.

Consumes raw, run-bound evidence. It never starts a run, changes settings, closes
windows, or upgrades uncertain/missing evidence to a pass.
"""
import hashlib
import json
import re
from collections import Counter
from datetime import datetime
from pathlib import Path


def timestamp(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Unzoned timestamp')
    return parsed.timestamp()


def evaluate(packet, evidence_root):
    failures = []

    def require(condition, reason):
        if not condition:
            failures.append(reason)

    try:
        run = packet['product']['runs'][0]
        require(len(packet['product']['runs']) == 1, 'Exactly one scoped run is required')
        run_id = run['id']
        sha = packet['build']['expectedSha']
        require(bool(re.fullmatch('[a-f0-9]{40}', sha)), 'Build SHA is not an exact commit')
        require(packet['build']['sourceManifestVerified'] is True, 'Committed source manifest was not verified')
        require(set(packet['build']['serviceShas']) == {'api', 'worker', 'supervisor'}, 'Service identity is incomplete')
        require(all(value == sha for value in packet['build']['serviceShas'].values()), 'Service build SHA mismatch')
        require(packet['build']['runtime'] == 'pi', 'Scripted runtime cannot satisfy T20')
        require(packet['settingsBefore'] == packet['settingsAfter'], 'Test bot model/tool settings changed')

        before, after = packet['before'], packet['after']
        fixture = packet['fixture']
        require(fixture['profile'] != fixture['botProfile'], 'Fixture reuses the bot profile')
        require(fixture['pid'] > 0 and fixture['startTicks'] > 0, 'Fixture process identity is missing')
        require(fixture['cdpIsolationVerified'] is True and fixture['listeningSockets'] == [], 'Fixture exposes a listening/CDP socket')
        require(not any('remote-debugging' in arg for arg in fixture['argv']), 'Fixture enables remote debugging')
        profile_flag = '--user-data-dir=' + fixture['profile']
        require(any(arg == profile_flag or re.search(r'(?:^|\s)' + re.escape(profile_flag) + r'(?=$|\s)', arg) for arg in fixture['argv']), 'Fixture profile was not independently launched')
        target = fixture['windowId']
        inventory = {}
        for label, snapshot in [('before', before), ('after', after)]:
            require(snapshot['runId'] == run_id and snapshot['buildSha'] == sha, label + ' snapshot is not bound to this run/build')
            require(snapshot['inventoryComplete'] is True, label + ' inventory is uncertain')
            require(snapshot['collectedBeforeTeardown'] is True, label + ' evidence was collected after teardown')
            require(snapshot['containerRunning'] is True, label + ' container was stopped before capture')
            require(0 <= timestamp(snapshot['capturedAt']) - timestamp(snapshot['inventoryAt']) <= 5, label + ' inventory is stale')
            windows = snapshot['windows']
            ids = [window['id'] for window in windows]
            require(len(ids) == len(set(ids)), label + ' inventory has duplicate IDs')
            inventory[label] = {window['id']: window for window in windows}
            root = Path(evidence_root).resolve()
            image_path = (root / snapshot['imageFile']).resolve()
            require(image_path.is_relative_to(root), 'Screenshot path escapes evidence directory')
            if image_path.is_relative_to(root):
                image = image_path.read_bytes()
                require(image.startswith(b'\x89PNG\r\n\x1a\n') and len(image) > 100, label + ' screenshot is missing or empty')
                require(hashlib.sha256(image).hexdigest() == snapshot['imageSha256'], label + ' screenshot hash mismatch')
        require(before['containerId'] == after['containerId'] and before['display'] == after['display'], 'Desktop context changed')
        require(0 <= timestamp(run['startedAt']) - timestamp(before['capturedAt']) <= 60,
                'Baseline is not fresh within sixty seconds before run start')
        require(timestamp(after['capturedAt']) >= timestamp(run['completedAt']), 'Final evidence was captured before run completion')
        require(target in inventory['before'] and target not in inventory['after'], 'Fixture window did not disappear')
        require(inventory['before'].get(target, {}).get('pid') == fixture['pid'], 'Fixture PID/window correlation failed')
        bot_windows = set(fixture['botWindowIds'])
        require(bool(bot_windows) and target not in bot_windows, 'Bot window baseline is missing or overlaps fixture')
        for window_id, window in inventory['before'].items():
            if window_id == target:
                continue
            remaining = inventory['after'].get(window_id, {})
            require(all(remaining.get(key) == window.get(key) for key in ['id', 'pid', 'startTicks', 'wmClass']), 'A survivor window disappeared or changed process identity: ' + window_id)
        require(bot_windows <= set(inventory['before']) and bot_windows <= set(inventory['after']), 'A bot window is missing')

        actual = (run.get('actualModelProvider'), run.get('actualModelId'))
        require(all(isinstance(value, str) and value for value in actual), 'Actual model identity is missing')
        require(not any(re.search(r'(?:^|[-/:])latest(?:$|[-/:])', value or '', re.I) for value in actual), 'Actual model is a moving alias')
        require(not re.fullmatch(r'(?:openrouter/)?(?:auto|free|bodybuilder)', actual[1] or '', re.I), 'Actual model is an unresolved router')
        capability = packet['modelEvidence']
        require((capability['provider'], capability['modelId']) == actual, 'Vision evidence belongs to another actual model')
        require(capability['capability'] == 'vision' and capability['source'] in ['catalog', 'pixel_challenge_pass'], 'Actual model has not been verified to read images')
        require(run['status'] == 'completed' and not run.get('error'), 'Run did not complete successfully')
        attempts = packet['product']['attempts']
        require(bool(attempts) and attempts[-1]['status'] == 'completed' and
                sum(attempt['status'] == 'completed' for attempt in attempts) == 1 and
                all(attempt['runId'] == run_id and not attempt.get('error') and
                    attempt['status'] in ['waiting_input', 'completed'] for attempt in attempts),
                'Attempt failed/retried or attempt evidence is missing')

        events = packet['product']['events']
        require(bool(events), 'Tool audit is missing')
        require(all(event['runId'] == run_id for event in events), 'Tool audit contains another run')
        calls = [event['payload'] for event in events if event['type'] == 'agent.tool.called']
        completions = [event['payload'] for event in events if event['type'] == 'agent.tool.completed']
        require(all(event['type'] in ['agent.tool.called', 'agent.tool.completed'] for event in events), 'Unexpected tool audit event')
        require(all(call.get('name') in ['computer_observe', 'computer_act'] for call in calls + completions), 'Non-computer tool used')
        call_ids = Counter((call.get('name'), call.get('executionId')) for call in calls)
        completion_ids = Counter((call.get('name'), call.get('executionId')) for call in completions)
        require(call_ids == completion_ids and all(value == 1 for value in call_ids.values()), 'Tool audit is incomplete or duplicated')
        require({'computer_observe', 'computer_act'} <= {call.get('name') for call in calls}, 'Observe/action path is incomplete')
        require(all(call.get('outcome') == 'succeeded' and not call.get('error') and call.get('uncertain') is not True for call in completions), 'Tool error, pause or uncertain result')
        require(all(call.get('windowInventoryStatus') == 'validnonempty' and not call.get('windowInventoryTruncated') for call in completions), 'Missing/uncertain tool window inventory')
        # A lifecycle reset between baseline capture and the first bot observation
        # must not disappear behind an otherwise successful target-close action.
        initial = completions[0] if completions else {}
        initial_windows = {window['id']: window for window in initial.get('windows', [])}
        require(initial.get('name') == 'computer_observe' and
                all(initial_windows.get(wid, {}).get('pid') == window.get('pid')
                    for wid, window in inventory['before'].items()),
                'Initial bot observation does not contain the full baseline')
        survivors = set(inventory['before']) - {target}
        require(all(all(any(window.get('id') == wid and
                                window.get('pid') == inventory['before'][wid].get('pid')
                                for window in call.get('windows', [])) for wid in survivors)
                    for call in completions), 'A survivor disappeared from the product tool evidence')
        require(any(call.get('windowCloseVerification', {}).get('verified') is True for call in completions), 'Product did not verify closure')
        effects = packet['product']['effects']
        require(bool(effects), 'Effect ledger evidence is missing')
        require(all(effect['runId'] == run_id and effect['kind'] == 'computer_act' and effect['status'] == 'completed' for effect in effects), 'Effect ledger contains a failed, uncertain or unauthorized effect')
        keys = [effect['idempotencyKey'] for effect in effects]
        requests = [json.dumps(effect['request'], sort_keys=True) for effect in effects]
        require(len(keys) == len(set(keys)) and len(requests) == len(set(requests)), 'A side effect was repeated')
        final = packet['product']['finalMessages']
        require(bool(final) and all(message['runId'] == run_id and message['role'] == 'bot' for message in final), 'Final answer evidence is missing')
        text = '\n'.join(block.get('text', '') for message in final for block in message['blocks'] if block.get('kind') == 'text')
        require(fixture['title'] in text and bool(re.search('ปิด.*(?:แล้ว|สำเร็จ)|closed', text, re.I)), 'Final answer does not confirm the observed fixture closure')
        require(not re.search(r'ไม่สำเร็จ|ยังไม่ได้|ไม่แน่ใจ|uncertain|unable|cannot|failed|could not', text, re.I), 'Final answer contradicts successful closure')
        require(packet['teardownStarted'] is False, 'Evidence was evaluated after teardown')
    except (KeyError, IndexError, TypeError, ValueError, AttributeError, OverflowError, OSError) as error:
        failures.append('Missing or malformed evidence: ' + type(error).__name__)
    return {'verdict': 'FAIL' if failures else 'PASS', 'failures': failures, 'criteria': 7,
            'note': 'Offline oracle verdict over supplied raw evidence; historical live FAILs are unchanged.'}
