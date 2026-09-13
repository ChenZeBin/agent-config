"""Portable package and machine-local trust policy regression tests."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "evidence_gate.py"

class PortableInstallTests(unittest.TestCase):
    def test_policy_is_machine_local_and_missing_policy_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            env = dict(os.environ, CODEX_HOME=tmp)
            code = "import importlib.util,json; s=importlib.util.spec_from_file_location('gate'," + repr(str(SCRIPT)) + "); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(str(m.TRUST_POLICY)))"
            path = json.loads(subprocess.check_output([sys.executable, "-B", "-c", code], env=env))
            self.assertEqual(path, str(Path(tmp) / "evidence-gate" / "reviewer-policy.json"))
            root = Path(tmp) / "project"
            root.mkdir()
            (root / "a.txt").write_text("fixture")
            contract = {"version": 1, "user_request": "verify fixture", "root": str(root), "inputs": ["a.txt"], "artifacts": {"a": "a.txt"}, "checks": [{"id": "read", "argv": [sys.executable, "-c", "print('fixture')"], "cwd": ".", "timeout": 5}], "evidence": [], "criteria": [{"id": "a", "requirement": "fixture readable", "refs": ["check:read", "artifact:a"]}]}
            file = Path(tmp) / "contract.json"
            file.write_text(json.dumps(contract))
            result = subprocess.run([sys.executable, "-B", str(SCRIPT), "--session", "missing-policy", "init", "--contract", str(file)], env=env, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("reviewer-policy.json", result.stdout + result.stderr)
            self.assertNotIn('"status": "accepted"', result.stdout)
            self.assertFalse((SCRIPT.parents[1] / "reviewer-policy.json").exists())

if __name__ == "__main__":
    unittest.main()
