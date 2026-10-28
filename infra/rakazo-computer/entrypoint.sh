#!/usr/bin/env bash
set -Eeuo pipefail
mkdir -p /tmp/home/.config/openbox /tmp/home/.cache
cat > /tmp/home/.config/openbox/menu.xml <<'EOF'
<openbox_menu xmlns="http://openbox.org/3.4/menu"><menu id="root-menu" label="Workspace"/></openbox_menu>
EOF
Xvfb :99 -screen 0 1280x800x24 -nolisten tcp -ac &
for i in {1..50}; do xdpyinfo -display :99 >/dev/null 2>&1 && break; sleep .1; done
xdpyinfo -display :99 >/dev/null
xsetroot -solid '#202124'
openbox --sm-disable &
# View sockets are read-only at the VNC server, regardless of client settings.
x11vnc -display :99 -listen 127.0.0.1 -rfbport 5900 -viewonly -forever -shared -nopw -noxdamage -no6 -quiet &
x11vnc -display :99 -listen 127.0.0.1 -rfbport 5901 -forever -shared -nopw -noxdamage -no6 -quiet &
python3 /app/controller.py &
# Fail the container if an essential process exits; Docker applies bounded retries.
wait -n
exit 1
