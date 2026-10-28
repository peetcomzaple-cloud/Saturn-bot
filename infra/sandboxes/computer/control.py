#!/usr/bin/env python3
"""Token-auth desktop control for the Rakazo supervisor."""

import base64
import ctypes
from datetime import datetime, timezone
import hmac
import json
import os
import posixpath
import re
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("RAKAZO_COMPUTER_CONTROL_TOKEN", "")
MAX_BODY_BYTES = 256 * 1024
MAX_ARGV = 32
MAX_ARG_LEN = 16_384
KNOWN_LAUNCH = frozenset(
    {
        "rakazo-browser",
        "xterm",
    }
)
# Focus-or-launch wraps KNOWN_LAUNCH launchers: rakazo-focus-or-launch <launcher> [uri].
FOCUS_OR_LAUNCH = "rakazo-focus-or-launch"
CONTROL_TIMEOUT_SEC = 10
LAUNCH_SPAWN_POLL_SEC = 0.2
# A live browser opens a URL in this process, then exits. rakazo-browser caps the
# profile scan at 0.4s and that forward at 1.6s. This poll outlasts both, plus a
# little shell, so a forward that fails after the scan is not reported as success.
BROWSER_OPEN_POLL_SEC = 2.4
NATIVE_CAPTURES = {}
NATIVE_LOCK = threading.Lock()
DISPLAY_LOCKS = {}
DISPLAY_LOCKS_GUARD = threading.Lock()


def display_lock(display):
    with DISPLAY_LOCKS_GUARD:
        lock = DISPLAY_LOCKS.get(display)
        if lock is None:
            lock = threading.Lock()
            DISPLAY_LOCKS[display] = lock
        return lock


class NativeCapture:
    """Persistent MIT-SHM frame source with native lossless PNG encoding."""

    def __init__(self, display):
        library = ctypes.CDLL("/usr/local/lib/librakazo-xcapture.so")
        library.rakazo_xcapture_open.argtypes = [ctypes.c_char_p]
        library.rakazo_xcapture_open.restype = ctypes.c_void_p
        library.rakazo_xcapture_png.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.POINTER(ctypes.c_ubyte)),
            ctypes.POINTER(ctypes.c_size_t),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        library.rakazo_xcapture_png.restype = ctypes.c_int
        library.rakazo_xcapture_damage.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
            ctypes.POINTER(ctypes.c_int),
        ]
        library.rakazo_xcapture_damage.restype = ctypes.c_int
        library.rakazo_xinput_argv.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_char_p)]
        library.rakazo_xinput_argv.restype = ctypes.c_int
        context = library.rakazo_xcapture_open(display.encode("utf-8"))
        if not context:
            raise RuntimeError("MIT-SHM capture is unavailable")
        self.library = library
        self.context = context

    def copy(self):
        png = ctypes.POINTER(ctypes.c_ubyte)()
        png_size = ctypes.c_size_t()
        width, height = ctypes.c_int(), ctypes.c_int()
        if self.library.rakazo_xcapture_png(
            self.context, ctypes.byref(png), ctypes.byref(png_size), ctypes.byref(width), ctypes.byref(height)
        ):
            raise RuntimeError("MIT-SHM screen capture failed")
        damage = (ctypes.c_int(), ctypes.c_int(), ctypes.c_int(), ctypes.c_int())
        changed = self.library.rakazo_xcapture_damage(
            self.context, *(ctypes.byref(value) for value in damage)
        )
        return (
            ctypes.string_at(png, png_size.value),
            width.value,
            height.value,
            ({"x": damage[0].value, "y": damage[1].value, "width": damage[2].value, "height": damage[3].value}
             if changed else None),
        )

    def act(self, argv):
        encoded = (ctypes.c_char_p * len(argv))(*(value.encode("utf-8") for value in argv))
        return self.library.rakazo_xinput_argv(self.context, len(argv), encoded)


def native_capture(display):
    existing = NATIVE_CAPTURES.get(display)
    if existing is not None:
        return existing
    try:
        capture = NativeCapture(display)
    except (OSError, RuntimeError):
        return None
    NATIVE_CAPTURES[display] = capture
    return capture


def drop_native_capture(display):
    NATIVE_CAPTURES.pop(display, None)


def _is_int_string(value):
    if not value or value[0] == "-":
        return value[1:].isdigit() if len(value) > 1 else False
    return value.isdigit()


def allowed_xdotool_argv(argv):
    """Only xdotool forms emitted by containerActionStep / xdotoolCommand."""
    if len(argv) < 4 or argv[2] != "xdotool":
        return False
    op = argv[3]
    if op == "key":
        return len(argv) == 6 and argv[4] == "--clearmodifiers" and argv[5] != ""
    if op == "mousemove":
        if len(argv) == 7 and argv[4] == "--" and _is_int_string(argv[5]) and _is_int_string(argv[6]):
            return True
        return (
            len(argv) == 9
            and argv[4] == "--"
            and _is_int_string(argv[5])
            and _is_int_string(argv[6])
            and argv[7] in ("mousedown", "click")
            and argv[8] in ("1", "3")
        )
    if op == "mouseup":
        return len(argv) == 5 and argv[4] in ("1", "3")
    if op == "type":
        return len(argv) == 7 and argv[4] == "--clearmodifiers" and argv[5] == "--"
    if op == "click":
        return (
            len(argv) == 7
            and argv[4] == "--repeat"
            and argv[5].isdigit()
            and 1 <= int(argv[5]) <= 20
            and argv[6] in ("4", "5")
        )
    return False


def control_command_index(argv):
    """Locate the executable after the optional supervisor-owned browser profile."""
    return 3 if len(argv) > 2 and argv[2].startswith("RAKAZO_BROWSER_PROFILE=") else 2


def allowed_control_argv(argv, display):
    """Only supervisor-shaped argv for the locked display."""
    if not isinstance(argv, list) or not (3 <= len(argv) <= MAX_ARGV):
        return False
    if any(not isinstance(value, str) or len(value) > MAX_ARG_LEN or "\0" in value for value in argv):
        return False
    if argv[0] != "env" or argv[1] != f"DISPLAY={display}":
        return False
    index = control_command_index(argv)
    if index >= len(argv):
        return False
    command = argv[index]
    if index == 3:
        profile = argv[2].removeprefix("RAKAZO_BROWSER_PROFILE=")
        if not re.fullmatch(r"/home/rakazo/\.browser-profiles/chromium-bot-[a-f0-9]{32}", profile):
            return False
        if command not in ("xdg-open", "rakazo-browser", FOCUS_OR_LAUNCH):
            return False
    if command == "xdotool":
        return allowed_xdotool_argv(argv)
    if command == "xdg-open":
        return len(argv) == index + 2
    if command == FOCUS_OR_LAUNCH:
        return (
            len(argv) in (index + 2, index + 3)
            and argv[index + 1] in KNOWN_LAUNCH
            and (index == 2 or argv[index + 1] == "rakazo-browser")
        )
    if "/" in command or command not in KNOWN_LAUNCH:
        return False
    return len(argv) in (index + 1, index + 2)


# The wrapper bounds each wmctrl call at 5s and may also wait out a browser
# forward. Wait for it to exit so a slow listing is not reported as success.
# computerControlTimeoutMs adds this per focus step on top of its 15s base.
FOCUS_COMPLETION_SEC = 5 + BROWSER_OPEN_POLL_SEC + 5 + 1


def is_long_lived_control(argv):
    """Apps and openers that must not be waited on under display_lock.

    The focus wrapper exits after it raises a window or detaches a spawn, so
    the caller waits for that exit instead of treating the wrapper as the app.
    """
    command = argv[control_command_index(argv)]
    if command == FOCUS_OR_LAUNCH:
        return False
    return command == "xdg-open" or command in KNOWN_LAUNCH


def launch_spawn_poll_sec(argv):
    index = control_command_index(argv)
    command = argv[index]
    if command == FOCUS_OR_LAUNCH:
        # The wrapped launcher keeps its own poll bound through the wrapper.
        command = argv[index + 1] if len(argv) > index + 1 else ""
    if command == "rakazo-browser":
        return BROWSER_OPEN_POLL_SEC
    return LAUNCH_SPAWN_POLL_SEC


def run_control_argv(argv, display):
    """Run a fallback control command without holding the lock forever."""
    env = {**os.environ, "DISPLAY": display}
    if argv[control_command_index(argv)] == FOCUS_OR_LAUNCH:
        try:
            result = subprocess.run(argv, env=env, timeout=FOCUS_COMPLETION_SEC)
        except subprocess.TimeoutExpired as error:
            raise RuntimeError("computer action timed out") from error
        if result.returncode:
            raise RuntimeError("computer action failed")
        return
    if is_long_lived_control(argv):
        child = subprocess.Popen(argv, env=env, start_new_session=True)
        try:
            code = child.wait(timeout=launch_spawn_poll_sec(argv))
        except subprocess.TimeoutExpired:
            threading.Thread(target=child.wait, daemon=True).start()
            return
        if code:
            raise RuntimeError("computer action failed")
        return
    try:
        result = subprocess.run(argv, env=env, timeout=CONTROL_TIMEOUT_SEC)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("computer action timed out") from error
    if result.returncode:
        raise RuntimeError("computer action failed")


def iso_utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def normalize_window_id(raw_id):
    value = (raw_id or "").strip()
    if not value:
        return ""
    try:
        num = int(value, 16) if value.lower().startswith("0x") else int(value, 10)
        return f"0x{num:08x}" if num > 0 else ""
    except ValueError:
        return ""


def resolve_browser_profile(display, browser_profile=None):
    if isinstance(browser_profile, str) and browser_profile.strip():
        return browser_profile.strip()
    display_num = display.lstrip(":").split(".", 1)[0]
    if display_num.isdigit():
        try:
            with open(f"/tmp/rakazo/browser-profile-{int(display_num)}", "r", encoding="utf-8") as handle:
                profile = handle.read().strip()
                if profile:
                    return profile
        except OSError:
            pass
    return None


def cmdline_matches_profile(raw_cmdline, browser_profile):
    if not browser_profile:
        return False
    target = posixpath.normpath(browser_profile.strip())
    if not target or target == ".":
        return False
    if isinstance(raw_cmdline, bytes):
        raw_cmdline = raw_cmdline.decode("utf-8", "replace")
    args = [arg for arg in raw_cmdline.split("\0") if arg]
    for index, arg in enumerate(args):
        if arg.startswith("--user-data-dir="):
            value = arg.split("=", 1)[1].strip()
            if value and posixpath.normpath(value) == target:
                return True
        elif arg == "--user-data-dir" and index + 1 < len(args):
            value = args[index + 1].strip()
            if value and posixpath.normpath(value) == target:
                return True
    return False


def window_matches_profile(pid_int, browser_profile):
    if not browser_profile or not pid_int or pid_int <= 0:
        return False
    try:
        with open(f"/proc/{pid_int}/cmdline", "rb") as handle:
            raw = handle.read()
    except OSError:
        return False
    return cmdline_matches_profile(raw, browser_profile)


def collect_window_inventory(env, browser_profile=None):
    freshness = iso_utc_now()
    try:
        proc = subprocess.run(
            ["wmctrl", "-lxp"],
            env=env,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return "unknown", freshness, None
    if proc.returncode != 0 or not isinstance(proc.stdout, str):
        return "unknown", freshness, None
    windows = []
    seen = set()
    for raw_line in proc.stdout.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        parts = line.split(None, 5)
        if len(parts) < 5:
            return "unknown", freshness, None
        wid = normalize_window_id(parts[0])
        if not wid or wid in seen:
            return "unknown", freshness, None
        try:
            int(parts[1], 10)
            pid_num = int(parts[2], 10)
        except ValueError:
            return "unknown", freshness, None
        if pid_num < 0:
            return "unknown", freshness, None
        wm_class = parts[3].strip()
        client_host = parts[4].strip()
        if not wm_class or not client_host:
            return "unknown", freshness, None
        seen.add(wid)
        pid_val = pid_num if pid_num > 0 else None
        title = parts[5].strip() if len(parts) >= 6 else ""
        entry = {
            "id": wid,
            "wmClass": wm_class,
            "isCurrentProfile": window_matches_profile(pid_val, browser_profile),
        }
        if pid_val is not None:
            entry["pid"] = pid_val
        if title:
            entry["title"] = title
        windows.append(entry)
    status = "validnonempty" if windows else "validempty"
    return status, freshness, windows


def capture(display, browser_profile=None):
    env = {**os.environ, "DISPLAY": display}

    def output(argv, fallback=""):
        return subprocess.run(argv, env=env, capture_output=True, text=True).stdout.strip() or fallback

    resolved_profile = resolve_browser_profile(display, browser_profile)
    inv_status, inv_freshness, windows = collect_window_inventory(env, resolved_profile)
    geometry = output(["xdotool", "getdisplaygeometry"], "1280 800").split()
    cursor = output(["xdotool", "getmouselocation", "--shell"])
    raw_window = output(["xdotool", "getactivewindow"])
    title = output(["xdotool", "getwindowname", raw_window]) if raw_window else ""
    normalized_active_id = normalize_window_id(raw_window) if raw_window else ""
    matched_active = (
        next((w for w in (windows or []) if w.get("id") == normalized_active_id), None)
        if normalized_active_id
        else None
    )
    active_window = None
    if raw_window:
        active_id = matched_active["id"] if matched_active else (normalized_active_id or raw_window)
        active_title = title or (matched_active.get("title", "") if matched_active else "")
        active_window = {
            "id": active_id,
            **({"title": active_title} if active_title else {}),
            **({"wmClass": matched_active["wmClass"]} if matched_active and "wmClass" in matched_active else {}),
            **({"pid": matched_active["pid"]} if matched_active and "pid" in matched_active else {}),
            **(
                {"isCurrentProfile": matched_active["isCurrentProfile"]}
                if matched_active and "isCurrentProfile" in matched_active
                else {}
            ),
        }
    image = None
    width = height = damage = None
    with NATIVE_LOCK:
        source = native_capture(display)
        if source:
            try:
                encoded, width, height, damage = source.copy()
                image = subprocess.CompletedProcess([], 0, encoded, b"")
            except RuntimeError:
                drop_native_capture(display)
    if image is None:
        image = subprocess.run(
            ["import", "-define", "png:compression-level=3", "-window", "root", "png:-"],
            env=env,
            capture_output=True,
        )
        width, height, damage = (int(geometry[0]), int(geometry[1]), None)
    if image.returncode:
        raise RuntimeError(image.stderr.decode("utf-8", "replace") or "screen capture failed")
    captured_at = iso_utc_now()
    fields = dict(line.split("=", 1) for line in cursor.splitlines() if "=" in line)
    return {
        "image": base64.b64encode(image.stdout).decode("ascii"),
        "mimeType": "image/png",
        "width": width,
        "height": height,
        "display": display,
        "capturedAt": captured_at,
        "windowInventoryStatus": inv_status,
        "windowInventoryFreshness": inv_freshness,
        **({"windows": windows} if windows is not None else {}),
        **({"cursor": {"x": int(fields["X"]), "y": int(fields["Y"])}} if "X" in fields and "Y" in fields else {}),
        **({"activeWindow": active_window} if active_window else {}),
        **({"damage": damage} if damage else {}),
    }


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        if self.path != "/v1/desktop" or not TOKEN or not hmac.compare_digest(
            self.headers.get("Authorization", "").removeprefix("Bearer "), TOKEN
        ):
            self.send_error(401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0 or length > MAX_BODY_BYTES:
                raise RuntimeError("request body too large")
            body = json.loads(self.rfile.read(length))
            display = body.get("display", ":1")
            if not isinstance(display, str) or not re.fullmatch(r":[0-9]+", display):
                raise RuntimeError("invalid display")
            browser_profile = body.get("browserProfile")
            if browser_profile is not None and not isinstance(browser_profile, str):
                browser_profile = None
            with display_lock(display):
                for step in body.get("steps", []):
                    if "waitMs" in step:
                        time.sleep(max(0, min(int(step["waitMs"]), 5000)) / 1000)
                        continue
                    argv = step.get("argv")
                    if not allowed_control_argv(argv, display):
                        raise RuntimeError("unsupported computer action")
                    with NATIVE_LOCK:
                        source = native_capture(display)
                        handled = source.act(argv) if source else 0
                        if handled < 0:
                            drop_native_capture(display)
                            handled = 0
                    if not handled:
                        run_control_argv(argv, display)
                settle_ms = max(0, min(int(body.get("settleMs", 0)), 5000))
                if settle_ms:
                    time.sleep(settle_ms / 1000)
                response = {"completed": len(body.get("steps", []))}
                if body.get("observe", True):
                    response["observation"] = capture(display, browser_profile)
            encoded = json.dumps(response, separators=(",", ":")).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)
        except Exception as error:
            encoded = json.dumps({"error": str(error)}).encode("utf-8")
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", 7070), Handler).serve_forever()
