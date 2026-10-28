"""Independent non-CDP desktop application and pre-teardown evidence collector.

Run inside the already admitted graphical container as its desktop user. This
helper never closes windows, stops a container, changes bot settings or sends a
user message. Existing bot and unrelated windows are always preserved.
"""
import ast
import hashlib
import json
import os
import re
import subprocess
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path


def utc():
    return datetime.now(timezone.utc).isoformat()


def has_profile(argv, profile):
    # Chromium may rewrite /proc/cmdline into one space-separated process title.
    # Match the complete known flag, retaining the original argv as raw evidence.
    flag = '--user-data-dir=' + profile
    return any(arg == flag or re.search(r'(?:^|\s)' + re.escape(flag) + r'(?=$|\s)', arg) for arg in argv)


def process_identity(pid):
    stat = Path('/proc') / str(pid) / 'stat'
    fields = stat.read_text().rsplit(')', 1)[1].split()
    return {'pid': pid, 'parentPid': int(fields[1]), 'startTicks': int(fields[19]),
            'argv': [arg for arg in (stat.parent / 'cmdline').read_bytes().decode().split('\0') if arg]}


def window_inventory():
    result = subprocess.run(['wmctrl', '-lp'], check=True, capture_output=True, text=True, timeout=5)
    windows = []
    for line in result.stdout.splitlines():
        parts = line.split(None, 4)
        if len(parts) < 4:
            raise ValueError('Incomplete window inventory')
        wid = f'0x{int(parts[0], 16):08x}'
        pid = int(parts[2])
        identity = process_identity(pid)
        prop = subprocess.run(['xprop', '-id', wid, '-notype', 'WM_CLASS'], check=True, capture_output=True, text=True, timeout=2).stdout
        if not prop.startswith('WM_CLASS = '):
            raise ValueError('Missing WM_CLASS')
        values = ast.literal_eval('(' + prop.split(' = ', 1)[1].strip() + ',)')
        if len(values) != 2 or not all(isinstance(value, str) and value for value in values):
            raise ValueError('Invalid WM_CLASS')
        windows.append({'id': wid, 'pid': pid, 'startTicks': identity['startTicks'],
                        'wmClass': '.'.join(values), 'title': parts[4] if len(parts) > 4 else '',
                        'argv': identity['argv']})
    if len({window['id'] for window in windows}) != len(windows):
        raise ValueError('Duplicate window identity')
    return windows


def fixture_network_evidence(pid, start_ticks):
    identity = process_identity(pid)
    if identity['startTicks'] != start_ticks:
        raise ValueError('Fixture process was replaced')
    processes = {}
    for path in Path('/proc').iterdir():
        if not path.name.isdecimal():
            continue
        try:
            item = process_identity(int(path.name))
            processes[item['pid']] = item
        except FileNotFoundError:
            continue
    descendants = {pid}
    while True:
        found = {item['pid'] for item in processes.values() if item['parentPid'] in descendants}
        if found <= descendants:
            break
        descendants |= found
    sockets = set()
    for child in descendants:
        for fd in (Path('/proc') / str(child) / 'fd').iterdir():
            try:
                link = os.readlink(fd)
            except FileNotFoundError:
                continue
            if link.startswith('socket:['):
                sockets.add(link[8:-1])
    listeners = []
    for protocol in ['tcp', 'tcp6']:
        for line in (Path('/proc') / str(pid) / 'net' / protocol).read_text().splitlines()[1:]:
            fields = line.split()
            if fields[3] == '0A' and fields[9] in sockets:
                listeners.append({'protocol': protocol, 'address': fields[1]})
    argv = identity['argv']
    if listeners or any('remote-debugging' in arg for item in processes.values() if item['pid'] in descendants for arg in item['argv']):
        raise ValueError('Fixture exposes a listener or a debugging transport')
    return {'cdpIsolationVerified': True, 'listeningSockets': listeners, 'argv': argv}


def prepare_fixture(folder, bot_profile, terminal='xterm'):
    folder = Path(folder).resolve()
    folder.mkdir(mode=0o700, parents=True, exist_ok=False)
    prior = window_inventory()
    bot_windows = [window['id'] for window in prior if has_profile(window['argv'], bot_profile)]
    if not bot_windows:
        raise ValueError('No bot browser window exists on the admitted desktop')
    nonce = uuid.uuid4().hex
    title = 'T20 independent fixture ' + nonce[:12]
    profile = str(folder / 'fixture-profile')
    app = folder / 'fixture_app.py'
    app.write_text('''import argparse, json, os, time
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--user-data-dir', required=True)
args = parser.parse_args()
profile = Path(args.user_data_dir)
profile.mkdir(mode=0o700, exist_ok=False)
(profile / 'session.json').write_text(json.dumps({'pid': os.getpid(), 'profile': str(profile)}))
print('INDEPENDENT T20 APPLICATION', flush=True)
print('Close only this window using the visible desktop.', flush=True)
print('Keep every other application window open.', flush=True)
while True:
    time.sleep(60)
''')
    # A terminal-hosted application has no browser/CDP surface. Its child owns
    # the dedicated data directory; the entire process tree is socket-audited.
    argv = [terminal, '-title', title, '-name', 't20-fixture', '-geometry', '88x18+120+100',
            '-fa', 'Monospace', '-fs', '16', '-e', 'python3', '-u', str(app), '--user-data-dir=' + profile]
    with (folder / 'fixture-process.log').open('xb') as log:
        process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise ValueError('Independent fixture process exited before admission')
        windows = window_inventory()
        matches = [window for window in windows if window['title'] == title and window['pid'] == process.pid]
        if len(matches) == 1:
            match = matches[0]
            prior_by_id = {window['id']: window for window in prior}
            after_by_id = {window['id']: window for window in windows}
            if any(after_by_id.get(key) != value for key, value in prior_by_id.items()):
                raise ValueError('Existing desktop window changed during fixture setup')
            receipt = {'title': title, 'windowId': match['id'], 'pid': process.pid, 'startTicks': match['startTicks'],
                       'profile': profile, 'botProfile': bot_profile, 'botWindowIds': bot_windows,
                       **fixture_network_evidence(process.pid, match['startTicks']), 'createdAt': utc()}
            (folder / 'FIXTURE.json').write_text(json.dumps(receipt, indent=2))
            return receipt
        time.sleep(0.25)
    raise ValueError('No unique fixture window appeared; keep evidence and do not dispatch')


def capture(folder, label, container_id, build_sha, run_id=None):
    if label not in ['baseline', 'before', 'after']:
        raise ValueError('Invalid capture label')
    folder = Path(folder).resolve()
    inventory_at = utc()
    windows = window_inventory()
    image = subprocess.run(['import', '-window', 'root', 'png:-'], check=True, capture_output=True, timeout=5).stdout
    if not image.startswith(b'\x89PNG\r\n\x1a\n') or len(image) < 100:
        raise ValueError('Empty desktop screenshot')
    image_file = label + '.png'
    with (folder / image_file).open('xb') as output:
        output.write(image)
    snapshot = {'runId': run_id, 'buildSha': build_sha, 'containerId': container_id,
                'containerRunning': True, 'display': os.environ['DISPLAY'], 'inventoryAt': inventory_at,
                'capturedAt': utc(), 'inventoryComplete': True, 'windows': windows,
                'imageFile': image_file, 'imageSha256': hashlib.sha256(image).hexdigest(),
                'collectedBeforeTeardown': True}
    with (folder / (label + '.json')).open('x') as output:
        json.dump(snapshot, output, indent=2)
    return snapshot
