#!/usr/bin/env python3
"""Exercise the pinned public installer in an isolated home and project."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


ROOT = Path(__file__).resolve().parents[1]
PACKAGE = "skills@1.7.2"
REMOTE_REVISION = "93b86f619151e19228efb725f1a1ad581e1dc052"
REMOTE_SOURCE = (
    "https://github.com/ChenZeBin/agent-config/tree/"
    f"{REMOTE_REVISION}/profile/skills/teach"
)
LICENSE_SOURCE = (
    "https://raw.githubusercontent.com/ChenZeBin/agent-config/"
    f"{REMOTE_REVISION}/third_party_licenses/teach-LICENSE.txt"
)
ANSI = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")


def inventory(root: Path) -> dict[str, str]:
    files = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"unexpected symlink: {path.relative_to(root)}")
        if path.is_file():
            files[path.relative_to(root).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return files


def invoke(source: str, arguments: list[str], project: Path, env: dict[str, str]) -> str:
    command = ["npx", "--yes", PACKAGE, "add", source, *arguments]
    result = subprocess.run(
        command, cwd=project, env=env, text=True, capture_output=True, timeout=90
    )
    output = ANSI.sub("", result.stdout + result.stderr)
    print(json.dumps({
        "command": command,
        "returncode": result.returncode,
        "output": output,
    }, ensure_ascii=False), flush=True)
    if result.returncode:
        raise RuntimeError("the real skills installer failed")
    return output


def listed_names(output: str) -> set[str]:
    return set(re.findall(r"^\s*[|\u2502]    ([a-z0-9][a-z0-9-]*)\s*$", output, re.MULTILINE))


def assert_installed(project: Path, expected: dict[str, str], label: str) -> None:
    skill_root = project / ".agents" / "skills"
    if not skill_root.is_dir() or {p.name for p in skill_root.iterdir()} != {"teach"}:
        raise RuntimeError(f"{label}: unexpected installed skills")
    if not (skill_root / "teach" / "LICENSE").is_file():
        raise RuntimeError(f"{label}: license notification missing")
    if inventory(skill_root / "teach") != expected:
        raise RuntimeError(f"{label}: installed files do not match the reviewed source")
    for path in project.rglob("*"):
        if path.name in {"AGENTS.md", "config.toml", ".githooks"}:
            raise RuntimeError(f"{label}: unexpected environment file: {path.name}")
    if not (project / "skills-lock.json").is_file():
        raise RuntimeError(f"{label}: installer did not record its project lock")


def finish_install(project: Path, expected: dict[str, str], env: dict[str, str], label: str) -> None:
    try:
        assert_installed(project, expected, label)
    except RuntimeError as exc:
        if str(exc) != f"{label}: license notification missing":
            raise
        print(json.dumps({"negative_check": "missing license rejected", "source": label}))
    else:
        raise RuntimeError("the negative control unexpectedly had a license")
    command = [
        "curl", "--fail", "--silent", "--show-error", "--location",
        "--proto", "=https", "--proto-redir", "=https",
        "--output", ".agents/skills/teach/LICENSE", LICENSE_SOURCE,
    ]
    result = subprocess.run(command, cwd=project, env=env, capture_output=True, text=True, timeout=60)
    print(json.dumps({"command": command, "returncode": result.returncode, "stderr": result.stderr}))
    if result.returncode:
        raise RuntimeError("license retrieval failed; installation is incomplete")
    assert_installed(project, expected, label)
    license_path = project / ".agents" / "skills" / "teach" / "LICENSE"
    license_bytes = license_path.read_bytes()
    license_path.write_text("incomplete notice\n")
    try:
        assert_installed(project, expected, label)
    except RuntimeError as exc:
        if "installed files do not match" not in str(exc):
            raise
        print(json.dumps({"negative_check": "incorrect license rejected", "source": label}))
    else:
        raise RuntimeError("the negative control accepted an incorrect license")
    finally:
        license_path.write_bytes(license_bytes)
    assert_installed(project, expected, label)
    print(json.dumps({
        "license_source": LICENSE_SOURCE,
        "license_sha256": hashlib.sha256(license_bytes).hexdigest(),
        "source": label,
        "copyright_and_permission_notice_retained": True,
    }))


def main() -> int:
    if not shutil.which("npx") or not shutil.which("curl"):
        raise RuntimeError("Node.js >=22.20.0, npx and curl are required")
    declared = set(json.loads((ROOT / "manifest.yaml").read_text())["profile"]["skills"])
    source = ROOT / "profile" / "skills" / "teach"
    source_files = inventory(source)
    license_bytes = (ROOT / "third_party_licenses" / "teach-LICENSE.txt").read_bytes()
    if b"Copyright" not in license_bytes or b"Permission is hereby granted" not in license_bytes:
        raise RuntimeError("the reviewed license is missing its copyright or permission notice")
    expected = source_files | {"LICENSE": hashlib.sha256(license_bytes).hexdigest()}
    with tempfile.TemporaryDirectory(prefix="agent-config-skills-install-") as temporary:
        base = Path(temporary).resolve()
        home = base / "home"
        home.mkdir()
        env = {
            key: os.environ[key]
            for key in ("PATH", "TMPDIR", "LANG", "LC_ALL")
            if key in os.environ
        }
        env.update({
            "HOME": str(home),
            "CODEX_HOME": str(base / "codex"),
            "XDG_CONFIG_HOME": str(base / "config"),
            "XDG_STATE_HOME": str(base / "state"),
            "XDG_CACHE_HOME": str(base / "cache"),
            "npm_config_cache": str(base / "npm-cache"),
            "npm_config_ignore_scripts": "true",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_TERMINAL_PROMPT": "0",
            "DISABLE_TELEMETRY": "1",
            "DO_NOT_TRACK": "1",
            "CI": "1",
        })
        local_project = base / "local-project"
        local_project.mkdir()
        all_skills = invoke(str(ROOT), ["--list"], local_project, env)
        if listed_names(all_skills) != declared:
            raise RuntimeError("installer discovery differs from manifest; possible missing skills or fixtures")
        single = invoke(str(source), ["--list"], local_project, env)
        if listed_names(single) != {"teach"} or any(local_project.iterdir()):
            raise RuntimeError("single-skill listing was incorrect or wrote to the project")
        arguments = ["--skill", "teach", "--agent", "codex", "--yes"]
        invoke(str(source), arguments, local_project, env)
        finish_install(local_project, expected, env, "local")

        remote_project = base / "remote-project"
        remote_project.mkdir()
        invoke(REMOTE_SOURCE, arguments, remote_project, env)
        finish_install(remote_project, expected, env, "remote")
        if inventory(source) != source_files:
            raise RuntimeError("the source changed during installation")
        for location in (home / ".agents", home / ".codex", base / "codex"):
            if location.exists():
                raise RuntimeError("project-scoped installation wrote global agent configuration")
        print(json.dumps({
            "status": "passed",
            "package": PACKAGE,
            "discovered_skills": len(declared),
            "installed_skill": "teach",
            "verified_files": len(expected),
            "remote_revision": REMOTE_REVISION,
            "scope": "isolated project installation including license retention; skill execution and other hosts are not tested",
        }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
