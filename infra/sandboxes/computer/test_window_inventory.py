"""Execute the supervisor's actual embedded inventory script with offline X11 fixtures."""
import contextlib
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace


SOURCE = Path(__file__).parents[1] / 'supervisor/src/index.ts'
BLOCK = SOURCE.read_text(encoding='utf-8').split('const inventoryPy = [', 1)[1].split('].join("\\n");', 1)[0]
SCRIPT = '\n'.join(json.loads(line.strip().rstrip(',')) for line in BLOCK.splitlines() if line.strip())


class WindowInventoryTests(unittest.TestCase):
    def inventory(self, broken_class=False):
        def run(argv, **kwargs):
            if argv == ['wmctrl', '-lp']:
                return SimpleNamespace(returncode=0, stdout='0x00000001 0 123 host Fixture with spaces\n0x00000002 0 456 host Bot window\n')
            if argv[0] == 'xprop':
                if broken_class:
                    return SimpleNamespace(returncode=1, stdout='')
                return SimpleNamespace(returncode=0, stdout='WM_CLASS = "chromium (profile with spaces)", "Chromium"\n')
            raise AssertionError(argv)
        output = io.StringIO()
        with patch('sys.argv', ['inventory', '/bot-profile']), patch('subprocess.run', side_effect=run), patch('builtins.open', return_value=io.BytesIO(b'chromium\0--user-data-dir=/bot-profile\0')), contextlib.redirect_stdout(output):
            exec(compile(SCRIPT, '<supervisor inventory>', 'exec'), {})
        return output.getvalue()

    def test_class_spaces_do_not_shift_title_or_hide_windows(self):
        result = self.inventory()
        self.assertIn('INVENTORY_STATUS validnonempty', result)
        windows = json.loads(next(line.removeprefix('WINDOWS_JSON ') for line in result.splitlines() if line.startswith('WINDOWS_JSON ')))
        self.assertEqual([window['title'] for window in windows], ['Fixture with spaces', 'Bot window'])
        self.assertEqual(windows[0]['wmClass'], 'chromium (profile with spaces).Chromium')
        self.assertEqual([window['pid'] for window in windows], [123, 456])

    def test_unreadable_class_is_unknown_not_incomplete_success(self):
        result = self.inventory(broken_class=True)
        self.assertIn('INVENTORY_STATUS unknown', result)
        self.assertNotIn('WINDOWS_JSON', result)


if __name__ == '__main__':
    unittest.main()
