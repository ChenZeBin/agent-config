#!/usr/bin/env python3
"""Fail-closed scanner for secrets and personal identifiers in public files."""

from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess


PATTERNS = {
    "private-key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----"),
    "github-token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
    "openai-key": re.compile(r"\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b"),
    "aws-access-key": re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    "bearer-token": re.compile(r"(?i)authorization\s*[:=]\s*['\"]?bearer\s+[A-Za-z0-9._~+/=-]{20,}"),
    "basic-auth-url": re.compile(r"https?://[^\s/@:]+:[^\s/@]+@[^\s/]+"),
    "personal-home-path": re.compile(r"/(?:Users|home)/(?!example(?:/|\b)|user(?:/|\b)|runner(?:/|\b)|tmp(?:/|\b))[A-Za-z0-9._-]+/"),
    "non-example-email": re.compile(r"\b(?!git@github\.com\b)[A-Za-z0-9._%+-]+@(?!example\.(?:com|org|net)\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    "private-network-url": re.compile(r"https?://(?!(?:host\.docker\.internal)(?:[:/]|$))[^/\s]+\.(?:internal|corp)(?:[:/\s]|$)", re.I),
    "secret-assignment": re.compile(
        r"(?i)\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|cookie|client[_-]?secret)"
        r"\s*[:=]\s*['\"](?!example|placeholder|dummy|redacted|your[_-]|<)[A-Za-z0-9%._~+/=-]{20,}['\"]"
    ),
}

TEXT_SUFFIXES = {
    "", ".md", ".txt", ".py", ".sh", ".zsh", ".bash", ".js", ".ts", ".tsx",
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".xml", ".html",
    ".css", ".scss", ".sql", ".go", ".rs", ".rb", ".java", ".kt", ".swift",
}


def repository_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [root / item.decode() for item in result.stdout.split(b"\0") if item]


def scan_text(text: str, label: str) -> list[str]:
    findings: list[str] = []
    for line_number, line in enumerate(text.splitlines(), 1):
        for rule_id, pattern in PATTERNS.items():
            if pattern.search(line):
                findings.append(f"{label}:{line_number}: {rule_id}")
    return findings


def scan(root: Path) -> list[str]:
    findings: list[str] = []
    for path in repository_files(root):
        if not path.is_file() or path.suffix.lower() not in TEXT_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        findings.extend(scan_text(text, str(path.relative_to(root))))
    return findings


def scan_staged(root: Path) -> list[str]:
    result = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    findings: list[str] = []
    for raw_path in result.stdout.split(b"\0"):
        if not raw_path:
            continue
        relative = raw_path.decode("utf-8", errors="surrogateescape")
        if Path(relative).suffix.lower() not in TEXT_SUFFIXES:
            continue
        content = subprocess.run(
            ["git", "show", f":{relative}"], cwd=root, check=False, capture_output=True
        )
        if content.returncode:
            continue
        try:
            text = content.stdout.decode("utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(text, f"index:{relative}"))
    return findings


def history_blob_entries(root: Path) -> list[tuple[str, str]]:
    commits = subprocess.run(
        ["git", "rev-list", "--all"], cwd=root, check=True, text=True, capture_output=True
    ).stdout.splitlines()
    entries: list[tuple[str, str]] = []
    seen: set[str] = set()
    for commit in commits:
        tree = subprocess.run(
            ["git", "ls-tree", "-r", "-z", "--full-tree", commit],
            cwd=root,
            check=True,
            capture_output=True,
        ).stdout
        for record in tree.split(b"\0"):
            if not record:
                continue
            metadata, separator, raw_path = record.partition(b"\t")
            fields = metadata.split()
            if not separator or len(fields) != 3 or fields[1] != b"blob":
                continue
            sha = fields[2].decode("ascii")
            path = raw_path.decode("utf-8", errors="surrogateescape")
            if sha in seen or Path(path).suffix.lower() not in TEXT_SUFFIXES:
                continue
            entries.append((sha, path))
            seen.add(sha)
    return entries


def scan_history(root: Path) -> list[str]:
    findings: list[str] = []
    for sha, path in history_blob_entries(root):
        content = subprocess.run(["git", "cat-file", "blob", sha], cwd=root, check=True, capture_output=True).stdout
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        findings.extend(scan_text(text, f"history:{sha[:12]}:{path}"))
    return findings


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--staged", action="store_true")
    parser.add_argument("--git-history", action="store_true")
    args = parser.parse_args()
    root = args.root.resolve()
    findings = scan_staged(root) if args.staged else scan(root)
    if args.git_history:
        findings.extend(scan_history(root))
    if findings:
        print("privacy scan failed (values redacted):")
        for finding in findings:
            print(f"  {finding}")
        return 1
    print("privacy scan passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
