import os
from pathlib import Path
import socket

import pytest
from policy import Workspace, needs_approval, parse_command, validate_url


def addresses(ip):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443))]


@pytest.mark.parametrize("command", ["list files", "ls", "ลิสต์ไฟล์", "รายการไฟล์"])
def test_list_is_read_only_without_approval(command):
    action = parse_command(command)
    assert action == {"tool": "list_files"}
    assert not needs_approval(action, False)


@pytest.mark.parametrize("tool", ["click", "type", "open", "human_control"])
def test_inputs_need_first_approval(tool):
    assert needs_approval({"tool": tool}, False)
    assert not needs_approval({"tool": tool}, True)


def test_every_write_requires_approval():
    assert needs_approval({"tool": "write_file"}, True)
    assert not needs_approval({"tool": "read_file"}, False)


@pytest.mark.parametrize("ip", ["127.0.0.1", "10.0.0.1", "172.30.160.1", "192.168.1.1", "169.254.169.254", "100.90.1.2", "::1", "fc00::1", "fe80::1"])
def test_private_and_metadata_urls_are_rejected(ip):
    with pytest.raises(ValueError, match="Private networks"):
        validate_url("https://example.com", lambda *a, **k: addresses(ip))


@pytest.mark.parametrize("url", ["http://example.com", "file:///etc/passwd", "https://user:secret@example.com", "https://example.com:9000", "javascript:alert(1)"])
def test_invalid_schemes_credentials_and_ports_are_rejected(url):
    with pytest.raises(ValueError):
        validate_url(url, lambda *a, **k: addresses("93.184.216.34"))


def test_public_https_url_is_allowed():
    assert validate_url("https://example.com", lambda *a, **k: addresses("93.184.216.34")) == "https://example.com"


@pytest.mark.parametrize("name", ["../secret", "/etc/passwd", "nested/../../secret", "a//b", "a\\b", "", "./secret"])
def test_workspace_escape_rejected(tmp_path, name):
    workspace = Workspace(tmp_path)
    with pytest.raises(ValueError):
        workspace.write(name, "bad")


def test_symlinks_and_parent_symlinks_rejected(tmp_path):
    root = tmp_path / "workspace"
    root.mkdir()
    outside = tmp_path / "private"
    outside.mkdir()
    secret = outside / "secret"
    secret.write_text("unchanged")
    (root / "link").symlink_to(secret)
    (root / "directory").symlink_to(outside, target_is_directory=True)
    workspace = Workspace(root)
    for name in ("link", "directory/secret"):
        with pytest.raises(OSError):
            workspace.write(name, "bad")
        with pytest.raises(OSError):
            workspace.read(name)
    assert secret.read_text() == "unchanged"
    assert workspace.list_files() == "Workspace is empty"


def test_workspace_files_and_real_missing_file_error(tmp_path):
    workspace = Workspace(tmp_path)
    workspace.write("note.txt", "first")
    workspace.write("note.txt", "second")
    assert workspace.read("note.txt") == "second"
    assert workspace.list_files() == "note.txt"
    with pytest.raises(FileNotFoundError):
        workspace.read("missing.txt")


def test_fifo_and_oversized_file_are_rejected(tmp_path):
    workspace = Workspace(tmp_path)
    os.mkfifo(tmp_path / "pipe")
    with pytest.raises(ValueError, match="regular"):
        workspace.read("pipe")
    (tmp_path / "large").write_bytes(b"a" * 65537)
    with pytest.raises(ValueError, match="64 KiB"):
        workspace.read("large")


def test_command_parser_never_accepts_shell_or_offscreen_inputs():
    for command in ("bash -c whoami", "click 1280 800", "click -1 2", "rm -rf /", "type " + "x" * 4097):
        with pytest.raises(ValueError):
            parse_command(command)
