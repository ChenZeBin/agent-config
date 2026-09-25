#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import unittest
from unittest import mock


SCRIPT = Path(__file__).with_name("verify_remote_setup.py")
SPEC = importlib.util.spec_from_file_location("verify_remote_setup_test", SCRIPT)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load remote setup verifier")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
HEAD = "a" * 40
ORIGIN = next(origin for origin in MODULE.ALLOWED_ORIGINS if origin.startswith("ssh://"))


class RemoteSetupTests(unittest.TestCase):
    def test_rejects_origin_pointing_to_another_repository(self) -> None:
        with mock.patch.object(MODULE, "output", return_value="https://github.com/other/repo.git") as command:
            with self.assertRaisesRegex(ValueError, "origin"):
                MODULE.observe()
        self.assertEqual(command.call_count, 1)

    def test_requires_published_head_and_successful_actions(self) -> None:
        successful_run = {
            "databaseId": 123,
            "headSha": HEAD,
            "status": "completed",
            "conclusion": "success",
            "url": "https://github.com/ChenZeBin/agent-config/actions/runs/123",
        }
        with mock.patch.object(MODULE, "output", side_effect=[
            ORIGIN, HEAD, f"{HEAD}\trefs/heads/main", json.dumps([successful_run]),
        ]):
            observation = MODULE.observe()
        self.assertEqual(observation["remote_head"], HEAD)
        self.assertEqual(observation["workflow_id"], 123)

        with mock.patch.object(MODULE, "output", side_effect=[
            ORIGIN, HEAD, f"{HEAD}\trefs/heads/main",
            json.dumps([successful_run | {"conclusion": "failure"}]),
        ]):
            with self.assertRaisesRegex(ValueError, "not passed"):
                MODULE.observe()


if __name__ == "__main__":
    unittest.main()
