"""Exercise the real sealed-runtime resolver with filesystem-backed manifests."""
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

import pm.store as store


class SealedTargetContract(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="sshs3-target-")
        self.payload = Path(self.temp.name)
        self.root = self.payload / "hermes-agent"
        self.root.mkdir()
        shutil.copy2(sys.executable, self.payload / "python.exe")
        self.manifest = {"repo": "hermes-agent", "venv": "venv", "store": "tools",
                         "target": "win32-x64", "runtime": {"commands": {"hermes": "bin/hermes.exe"},
                         "storePython": "python.exe"}}
        self.stamp = {"distribution": "sshs3", "updateMechanism": "external", "payload": "bundled"}
        self.write()
        self.root_patch = patch("pm.paths.repo_root", return_value=self.root)
        self.machine_patch = patch("pm.store._native_machine", return_value="arm64")
        self.root_patch.start()
        self.machine_patch.start()

    def tearDown(self):
        self.machine_patch.stop()
        self.root_patch.stop()
        self.temp.cleanup()

    def write(self):
        (self.payload / "manifest.json").write_text(json.dumps(self.manifest))
        (self.root / "install-stamp.json").write_text(json.dumps(self.stamp))

    def test_owned_payload_uses_executable_abi_and_keeps_native_facts(self):
        self.assertEqual(store.current_target(), "win32-x64")
        self.assertEqual(store._native_machine(), "arm64")

    def test_external_owner_is_required(self):
        self.stamp["updateMechanism"] = "self"
        self.write()
        self.assertEqual(store.current_target(), "win32-arm64")

    def test_standalone_hermes_is_not_changed(self):
        self.stamp["distribution"] = "desktop-app"
        self.write()
        self.assertEqual(store.current_target(), "win32-arm64")

    def test_manifest_must_own_this_exact_repo(self):
        self.manifest["repo"] = "another-repo"
        self.write()
        self.assertEqual(store.current_target(), "win32-arm64")

    def test_cross_platform_target_is_rejected(self):
        self.manifest["target"] = "linux-x64"
        self.write()
        self.assertEqual(store.current_target(), "win32-arm64")

    def test_interpreter_path_cannot_escape_payload(self):
        self.manifest["runtime"]["storePython"] = str(sys.executable)
        self.write()
        self.assertEqual(store.current_target(), "win32-arm64")

    def test_missing_manifest_keeps_native_target(self):
        (self.payload / "manifest.json").unlink()
        self.assertEqual(store.current_target(), "win32-arm64")


if __name__ == "__main__":
    if sys.platform != "win32":
        raise SystemExit("Run this Windows executable-ABI contract on Windows")
    unittest.main()
