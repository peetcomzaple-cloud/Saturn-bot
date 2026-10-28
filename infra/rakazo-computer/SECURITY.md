# Security boundary

- Source code is public; `.env`, workspace, screenshots and deployment data are not
  committed. No API key is needed by this deterministic computer console.
- Port 16080 binds only to loopback and the host's Tailscale IPv4. Remote access
  requires an authorized device on the same tailnet. Scoped INPUT and Docker DNAT
  rules accept that port only from tailscale0; SSH loopback access is retained.
  No wildcard binding, public tunnel, Funnel or host reverse-proxy change is made.
- Console cookies are random, HttpOnly and SameSite=Strict. Requests enforce exact
  localhost hostnames, same-origin WebSockets and CSRF headers. Framing is denied.
- Viewing uses a separate read-only VNC server. A modified browser cannot turn a
  viewing connection into a control connection. The control WebSocket validates
  approval and mode on every message; stopping revokes and closes live streams.
- There is no shell execution endpoint or host API. Actions are explicit typed
  operations. Workspace paths use descriptor-relative no-follow opens to reject
  traversal, symlinks and directory replacement races. Read/write files are limited
  to 64 KiB. Every requested file write requires explicit approval.
- The container is a non-root user with all capabilities dropped,
  no-new-privileges, read-only root, bounded RAM/CPU/processes and no host socket,
  devices or home mount. Runtime browser data is ephemeral in the container tmpfs.
- Firewall rules match **only br-rakazo-cmp**, blocking new access to the host and
  private/link-local/metadata destinations. Private DNS results are rejected before
  URL launch; the firewall also covers redirects and DNS rebinding. IPv6 is disabled
  in this container. The host's configured public/NAT IP addresses are also blocked,
  with the list kept in an ignored runtime file. No existing web-service firewall
  policy is replaced.
- Chromium runs with `--no-sandbox` because its setuid sandbox is incompatible with
  the dropped capabilities and no-new-privileges configuration. Docker is the outer
  isolation boundary, not a separate-kernel VM. Keep the host and browser security
  packages updated; rebuild the image for browser updates.
- Running an untrusted agent is not equivalent to trusting the container: use one
  bot, do not place host secrets in its workspace, and keep Docker administrative
  access outside the container. A future model adapter must go through the same
  approval and stop gate; this console does not silently connect one.
