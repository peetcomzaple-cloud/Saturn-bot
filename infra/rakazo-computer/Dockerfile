FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
ARG BOT_UID=1000
ARG BOT_GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 python3-aiohttp python3-pytest xvfb openbox xdotool scrot \
    chromium novnc x11vnc x11-utils x11-xserver-utils ca-certificates fonts-noto-core \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g "$BOT_GID" rakazo-computer \
    && useradd -u "$BOT_UID" -g "$BOT_GID" -M -d /tmp/home -s /usr/sbin/nologin rakazo-computer \
    && cp -Lr /usr/share/novnc /opt/novnc
WORKDIR /app
COPY controller.py policy.py entrypoint.sh /app/
COPY web /app/web
COPY tests /app/tests
RUN chmod 755 /app/entrypoint.sh
USER rakazo-computer
ENV DISPLAY=:99 HOME=/tmp/home PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
ENTRYPOINT ["/app/entrypoint.sh"]
