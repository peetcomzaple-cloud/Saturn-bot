# Isolated computer console

A standalone inspection console for one Docker computer, in a fresh Rakazo checkout.
This does not modify the Rakazo web dashboard or start the main application stack.
It contains no legacy dashboard code and no LLM or paid model dependency. The console
executes explicit tools; integrating a model agent is a separate step.

## Install on a Linux Docker host

```bash
git clone --branch main https://github.com/YOUR_ACCOUNT/rakazo.git
cd rakazo/infra/rakazo-computer
bash prepare-assets.sh
sudo env HOST_BLOCKED_IPS=203.0.113.10 bash install.sh # replace with this host's public IPv4
```

The extension lives on the fork's main branch. Clone that fork to obtain it; the
upstream repository does not include this directory. `prepare-assets.sh` reads
Rakazo's existing UI tokens rather than keeping another palette.

The installer reserves `/opt/rakazo-computer`, a nologin system account
`rakazo-computer`, and Docker network `rakazo_computer`. It rejects occupied port
16080 and overlapping network subnets. Docker Engine 28+ and Docker Compose with
`--wait` are required. No host reverse proxy, other container, or existing web
service is changed. All application files and workspace data stay in the project
directory. Only the workspace is mounted; no host home, Docker socket or devices
are exposed. Re-running an update requires stopping this computer first.
`HOST_BLOCKED_IPS` is a comma-separated list of this host's public/NAT IPv4 addresses,
stored only in an ignored runtime file. This also blocks reaching the host through
its public address. Updates preserve that file when the variable is omitted.

The desktop is Xvfb `:99`, 1280×800, with Openbox, Chromium, xdotool, scrot and noVNC.
It boots to an empty desktop. Port **16080** is bound only to loopback and this
host's Tailscale IPv4. Installation requires a running Tailscale connection.
Internal listeners are 172.30.160.2:8080 and loopback VNC 5900/5901; none bind a
wildcard address. VNC 5900 is view-only at the server, and 5901 requires an approved
human-control session through the console.

## Open from a client

From any authorized device on the same tailnet, open `http://TAILSCALE_IP:16080`.
The installer discovers the host IP and MagicDNS names and keeps them only in the
ignored `.env`; the controller accepts these exact hosts for HTTP and WebSockets.
Firewall rules allow remote TCP 16080 only from `tailscale0`, including Docker
forwarding after DNAT. They reject other host interfaces. No Funnel is enabled.

The original SSH tunnel also remains available. Use a privately configured alias:

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:16080:127.0.0.1:16080 YOUR_SSH_ALIAS
```

Then open **http://127.0.0.1:16080** in a browser. There is no public tunnel, hostname,
or authentication secret in the URL. Tailscale device authorization or the SSH
account is the access boundary. No application password is introduced.

## Acceptance

1. The initial desktop is empty. `ดูจอ` connects in view mode.
2. Send `list files`: results return without a model call or approval.
3. Send `open https://example.com`: click **Approve**, then see the page and a screen
   capture in chat. A purple status dot appears during the tool run.
4. `click X Y` and `type TEXT` require approval before the first computer input in
   that console session. `เข้าควบคุม` shares that approval boundary.
5. `คืนให้บอต` closes human control streams. **หยุด** cancels a running tool, closes
   live VNC streams, releases held keys/buttons, and revokes input approvals.
6. `read PATH` is read-only. `write PATH` followed by a newline and file contents
   always requires approval. Paths are confined to the workspace, including symlink
   and traversal checks. Tool failures include the actual error message.
7. Compare existing service PIDs and HTTP results before/after; unrelated services
   must be unchanged. Check `ss -lptn` and `docker ps` for loopback and tailnet bindings.

Stop only this container:

```bash
sudo bash /opt/rakazo-computer/stop.sh
```

Start it again using `sudo bash /opt/rakazo-computer/start.sh`. Automatic restarts
are bounded to three failures. It stays stopped after a host/Docker-daemon restart;
the start script reinstalls scoped network protection before it becomes available.
Do not bypass that script with `docker start` after a reboot.

## Tests

`install.sh` builds the image and runs the offline policy/controller tests without
network access before starting the computer. Tests exercise real approval gating,
read-only commands, error reporting, session/origin enforcement, cancellation and
workspace escape attempts. No model credentials are required.
