"""Discover this machine's tailnet identity without printing account information."""
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent
addresses = subprocess.check_output(['tailscale', 'ip', '-4'], text=True).split()
if len(addresses) != 1 or ipaddress.ip_address(addresses[0]) not in ipaddress.ip_network('100.64.0.0/10'):
    raise SystemExit('A single active Tailscale IPv4 address is required')
status = json.loads(subprocess.check_output(['tailscale', 'status', '--json']))
if status.get('BackendState') != 'Running':
    raise SystemExit('Tailscale must be running')
identity = status['Self']
names = [addresses[0]]
for field in ('DNSName', 'HostName'):
    name = identity.get(field, '').lower().rstrip('.')
    if name and re.fullmatch(r'[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?', name) and ('.' not in name or name.endswith('.ts.net')):
        names.append(name)
env_path = root / '.env'
existing = env_path.read_text().splitlines() if env_path.exists() else []
retained = [line for line in existing if not line.startswith(('TAILSCALE_IP=', 'COMPUTER_ALLOWED_HOSTS='))]
retained += ['TAILSCALE_IP=' + addresses[0], 'COMPUTER_ALLOWED_HOSTS=' + ','.join(name + ':16080' for name in names)]
os.umask(0o077)
env_path.write_text('\n'.join(retained) + '\n')
env_path.chmod(0o600)
print('Configured Tailscale IPv4:', addresses[0])
