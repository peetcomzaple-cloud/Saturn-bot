"""Deterministic computer tools. No model, host shell, or Docker API access."""
import ipaddress
import os
from pathlib import Path
import re
import socket
from urllib.parse import urlsplit


def validate_url(value, lookup=socket.getaddrinfo):
    parts = urlsplit(value)
    if parts.scheme != "https" or not parts.hostname or parts.username or parts.password:
        raise ValueError("Only public HTTPS URLs without embedded credentials are allowed")
    if parts.port not in (None, 443):
        raise ValueError("Only HTTPS port 443 is allowed")
    addresses = lookup(parts.hostname, 443, type=socket.SOCK_STREAM)
    if not addresses or any(not ipaddress.ip_address(a[4][0]).is_global for a in addresses):
        raise ValueError("Private networks and cloud metadata are blocked")
    return value


def parse_command(text):
    text = text.strip()
    if text.lower() in ("list files", "ls", "รายการไฟล์", "ลิสต์ไฟล์"):
        return {"tool": "list_files"}
    if text.startswith("open "):
        return {"tool": "open", "url": text[5:].strip()}
    match = re.fullmatch(r"click\s+(\d+)\s+(\d+)", text)
    if match:
        x, y = map(int, match.groups())
        if x >= 1280 or y >= 800:
            raise ValueError("Click must be inside the 1280×800 screen")
        return {"tool": "click", "x": x, "y": y}
    if text.startswith("type ") and len(text[5:]) <= 4096:
        return {"tool": "type", "text": text[5:]}
    if text.startswith("read "):
        return {"tool": "read_file", "path": text[5:].strip()}
    if text.startswith("write ") and "\n" in text:
        header, content = text.split("\n", 1)
        if len(content.encode()) > 65536:
            raise ValueError("File contents exceed 64 KiB")
        return {"tool": "write_file", "path": header[6:].strip(), "content": content}
    raise ValueError("Use: list files, open https://…, click X Y, type TEXT, read PATH, or write PATH followed by a new line and contents")


def needs_approval(action, approved_inputs):
    return action["tool"] == "write_file" or (
        action["tool"] in {"open", "click", "type", "human_control"} and not approved_inputs
    )


class Workspace:
    def __init__(self, root):
        self.root = Path(root)

    def _open(self, name, flags):
        # Walk directory descriptors: no symlink traversal or resolve/open race.
        if "\x00" in name or "\\" in name:
            raise ValueError("Invalid workspace path")
        parts = name.split("/")
        if not name or any(p in ("", ".", "..") for p in parts):
            raise ValueError("Path must be relative to the bot workspace")
        directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            for part in parts[:-1]:
                child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
                os.close(directory)
                directory = child
            return os.open(parts[-1], flags | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=directory)
        finally:
            os.close(directory)

    def list_files(self):
        return "\n".join(sorted(
            item.name + ("/" if item.is_dir(follow_symlinks=False) else "")
            for item in os.scandir(self.root) if not item.is_symlink()
        )) or "Workspace is empty"

    def read(self, name):
        import stat
        fd = self._open(name, os.O_RDONLY)
        with os.fdopen(fd, "rb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("Only regular workspace files can be read")
            content = stream.read(65537)
        if len(content) > 65536:
            raise ValueError("File exceeds 64 KiB")
        return content.decode("utf-8")

    def write(self, name, content):
        import stat
        fd = self._open(name, os.O_WRONLY | os.O_CREAT)
        with os.fdopen(fd, "wb") as stream:
            if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
                raise ValueError("Only regular workspace files can be written")
            os.ftruncate(stream.fileno(), 0)
            stream.write(content.encode("utf-8"))
        return "Saved " + name
