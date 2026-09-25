#!/usr/bin/env python3
"""Record and recheck the published setup commit and its GitHub Actions result."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "ChenZeBin/agent-config"
RECEIPT = ROOT / ".agent-config-setup-remote.json"
SHA = re.compile(r"[0-9a-f]{40}")
ALLOWED_ORIGINS = {
    "git@github.com:ChenZeBin/agent-config.git",
    f"ssh://git{chr(64)}ssh.github.com:443/{REPOSITORY}.git",
    "https://github.com/ChenZeBin/agent-config.git",
}


def output(argv: list[str]) -> str:
    result = subprocess.run(argv, cwd=ROOT, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def observe() -> dict:
    origin = output(["git", "remote", "get-url", "origin"])
    if origin not in ALLOWED_ORIGINS:
        raise ValueError("origin is not the expected GitHub repository")
    local_head = output(["git", "rev-parse", "HEAD"])
    remote_line = output(["git", "ls-remote", "origin", "refs/heads/main"])
    remote_head = remote_line.split()[0] if remote_line else ""
    if not SHA.fullmatch(local_head) or remote_head != local_head:
        raise ValueError("GitHub main does not match the local commit")

    runs = json.loads(output([
        "gh", "run", "list", "-R", REPOSITORY, "--workflow", "validate",
        "--commit", local_head, "--limit", "10",
        "--json", "databaseId,headSha,status,conclusion,url",
    ]))
    matching = [run for run in runs if run.get("headSha") == local_head]
    if not matching:
        raise ValueError("no validation run found for the published commit")
    latest = max(matching, key=lambda run: int(run["databaseId"]))
    if latest.get("status") != "completed" or latest.get("conclusion") != "success":
        raise ValueError("the latest validation run has not passed")
    return {
        "observed_at": datetime.now(timezone.utc).isoformat(),
        "repository": REPOSITORY,
        "origin": origin,
        "local_head": local_head,
        "remote_head": remote_head,
        "workflow_id": latest["databaseId"],
        "workflow_url": latest["url"],
        "workflow_conclusion": latest["conclusion"],
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["capture", "verify"])
    args = parser.parse_args()
    try:
        current = observe()
        if args.action == "capture":
            RECEIPT.write_text(json.dumps(current, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        else:
            saved = json.loads(RECEIPT.read_text(encoding="utf-8"))
            captured = datetime.fromisoformat(saved["observed_at"])
            if captured.tzinfo is None or not 0 <= (datetime.now(timezone.utc) - captured).total_seconds() <= 1800:
                raise ValueError("remote verification receipt is stale")
            for key in ("repository", "origin", "local_head", "remote_head", "workflow_id", "workflow_url", "workflow_conclusion"):
                if saved.get(key) != current[key]:
                    raise ValueError(f"remote verification receipt differs on {key}")
        print(json.dumps(current, sort_keys=True))
        return 0
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError, json.JSONDecodeError) as error:
        print(f"remote setup verification failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
