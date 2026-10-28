#!/usr/bin/env bash
set -Eeuo pipefail
test "$(id -u)" = 0 || { echo 'Run with sudo' >&2; exit 1; }
source_dir="$(cd "$(dirname "$0")" && pwd -P)"
target=/opt/rakazo-computer
if test "$(docker version --format '{{.Server.Version}}' | cut -d. -f1)" -lt 28; then
  echo 'Docker Engine 28+ is required for safe loopback publishing' >&2; exit 1
fi
if test -e "$target" && test "$(readlink -f "$target")" != "$target"; then
  echo 'Refusing a redirected project directory' >&2; exit 1
fi
if test -e "$target" && ! test -f "$target/.rakazo-computer-owner"; then
  echo 'Refusing an existing unowned project directory' >&2; exit 1
fi
if docker inspect rakazo-computer >/dev/null 2>&1; then
  test "$(docker inspect -f '{{index .Config.Labels "app.owner"}}' rakazo-computer)" = rakazo-computer || { echo 'Container name belongs to another project' >&2; exit 1; }
fi
if ss -lntH 'sport = :16080' | read -r _; then
  echo 'Port 16080 is occupied; stop only this computer before installing an update' >&2; exit 1
fi
# Refuse a network name or subnet already owned by another project.
python3 - <<'PY'
import ipaddress, json, subprocess
desired = ipaddress.ip_network('172.30.160.0/24')
ids = subprocess.check_output(['docker', 'network', 'ls', '-q'], text=True).split()
networks = json.loads(subprocess.check_output(['docker', 'network', 'inspect', *ids])) if ids else []
for network in networks:
    if network['Name'] == 'rakazo_computer' and (network.get('Labels') or {}).get('com.docker.compose.project') != 'rakazo-computer':
        raise SystemExit('Network name belongs to another project')
    for item in network.get('IPAM', {}).get('Config') or []:
        subnet = item.get('Subnet')
        if subnet and ':' not in subnet and desired.overlaps(ipaddress.ip_network(subnet)) and network['Name'] != 'rakazo_computer':
            raise SystemExit('Computer subnet overlaps an existing network')
routes = json.loads(subprocess.check_output(['ip', '-j', '-4', 'route']))
for route in routes:
    dest = route.get('dst', 'default')
    if dest != 'default' and route.get('dev') != 'br-rakazo-cmp' and desired.overlaps(ipaddress.ip_network(dest)):
        raise SystemExit('Computer subnet overlaps a host route')
PY
if ! id rakazo-computer >/dev/null 2>&1; then
  useradd --system --user-group --no-create-home --home-dir "$target" --shell /sbin/nologin rakazo-computer
fi
test "$(getent passwd rakazo-computer | cut -d: -f6)" = "$target" || { echo 'Existing system user has a different home' >&2; exit 1; }
install -d -m 755 "$target"
touch "$target/.rakazo-computer-owner"
if test "$source_dir" != "$target"; then
  # Explicit code paths only; never copy or replace workspace data.
  for path in .dockerignore Dockerfile compose.yml controller.py policy.py configure-tailnet.py entrypoint.sh firewall.sh start.sh stop.sh install.sh README.md SECURITY.md tests web; do
    cp -a "$source_dir/$path" "$target/"
  done
fi
install -d -m 700 -o rakazo-computer -g rakazo-computer "$target/workspace"
umask 077
printf 'BOT_UID=%s\nBOT_GID=%s\n' "$(id -u rakazo-computer)" "$(id -g rakazo-computer)" > "$target/.env"
cd "$target"
python3 configure-tailnet.py
if test -n "${HOST_BLOCKED_IPS:-}"; then
  python3 - <<'PY' > .host-blocked-ips
import ipaddress, os
for value in os.environ['HOST_BLOCKED_IPS'].split(','):
    address = ipaddress.ip_address(value.strip())
    if address.version != 4:
        raise SystemExit('Host block list accepts IPv4 addresses only')
    print(address)
PY
fi
docker compose build
docker run --rm --network none --read-only --tmpfs /tmp:rw,nosuid,nodev,size=64m --cap-drop ALL --security-opt no-new-privileges --entrypoint python3 rakazo-computer:local -m pytest -q -p no:cacheprovider /app/tests
bash start.sh
