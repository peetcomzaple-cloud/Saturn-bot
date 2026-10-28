#!/usr/bin/env bash
# Only the bridge belonging to this computer is matched. No global policy changes.
set -Eeuo pipefail
test "$(id -u)" = 0 || { echo 'Run with sudo' >&2; exit 1; }
iptables -w -S DOCKER-USER >/dev/null
cd /opt/rakazo-computer
source .env
python3 - "$TAILSCALE_IP" <<'PY'
import ipaddress, sys
assert ipaddress.ip_address(sys.argv[1]) in ipaddress.ip_network('100.64.0.0/10')
PY
for chain in RAKAZO_CMP_OUT RAKAZO_CMP_IN RAKAZO_CMP_HOST RAKAZO_CMP_PORT; do
  iptables -w -N "$chain" 2>/dev/null || true
done
umask 077
rules_file="$(mktemp /opt/rakazo-computer/.firewall-XXXXXX)"
trap 'rm -f -- "$rules_file"' EXIT
{
printf '%s\n' '*filter' '-F RAKAZO_CMP_OUT' '-F RAKAZO_CMP_IN' '-F RAKAZO_CMP_HOST' '-F RAKAZO_CMP_PORT'
printf '%s\n' '-A RAKAZO_CMP_OUT -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN'
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.0.2.0/24 192.168.0.0/16 198.18.0.0/15 198.51.100.0/24 203.0.113.0/24 224.0.0.0/4 240.0.0.0/4; do
  printf '%s\n' "-A RAKAZO_CMP_OUT -d $destination -j DROP"
done
if test -f /opt/rakazo-computer/.host-blocked-ips; then
  while IFS= read -r destination; do
    test -z "$destination" || printf '%s\n' "-A RAKAZO_CMP_OUT -d $destination -j DROP"
  done < /opt/rakazo-computer/.host-blocked-ips
fi
printf '%s\n' '-A RAKAZO_CMP_OUT -j RETURN' '-A RAKAZO_CMP_IN -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN'
printf '%s\n' "-A RAKAZO_CMP_IN -i tailscale0 -s 100.64.0.0/10 -p tcp -d 172.30.160.2 --dport 8080 -m conntrack --ctorigdst $TAILSCALE_IP --ctorigdstport 16080 -j RETURN"
printf '%s\n' '-A RAKAZO_CMP_IN -j DROP' '-A RAKAZO_CMP_HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' '-A RAKAZO_CMP_HOST -j DROP' '-A RAKAZO_CMP_PORT -i lo -j ACCEPT'
printf '%s\n' "-A RAKAZO_CMP_PORT -i tailscale0 -s 100.64.0.0/10 -d $TAILSCALE_IP -j ACCEPT" '-A RAKAZO_CMP_PORT -j DROP'
for spec in 'DOCKER-USER -i br-rakazo-cmp -j RAKAZO_CMP_OUT' 'DOCKER-USER -o br-rakazo-cmp -j RAKAZO_CMP_IN' 'INPUT -i br-rakazo-cmp -j RAKAZO_CMP_HOST' 'INPUT -p tcp --dport 16080 -j RAKAZO_CMP_PORT'; do
  read -ra rule <<< "$spec"
  iptables -w -C "${rule[@]}" 2>/dev/null || printf '%s\n' "-I $spec"
done
printf '%s\n' COMMIT
} > "$rules_file"
# Apply the dedicated chains in one transaction, without a temporarily open gap
# or flushing any rules owned by another project.
iptables-restore --test --noflush < "$rules_file"
iptables-restore --wait --noflush < "$rules_file"
