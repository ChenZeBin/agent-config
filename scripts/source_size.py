#!/usr/bin/env python3
"""Check immutable Git blobs, not the working-tree copy of a staged file."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys

from source_size_policy import LIMIT, POLICY, ignored, is_source, load, permitted


def git(repo, *args, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True)
    if check and result.returncode:
        raise ValueError(result.stderr.decode("utf-8", "replace").strip())
    return result


def entries(repo, tree=None):
    if tree:
        data = git(repo, "ls-tree", "-rz", "--full-tree", tree).stdout
    else:
        data = git(repo, "ls-files", "--stage", "-z").stdout
    result = {}
    for row in data.split(b"\x00"):
        if not row:
            continue
        metadata, path = row.split(b"\t", 1)
        mode, middle, end = metadata.decode("ascii").split()
        if not tree and end != "0":
            raise ValueError("resolve unmerged index entries before committing")
        result[os.fsdecode(path)] = (mode, end if tree else middle)
    return result


def blob(repo, oid):
    return git(repo, "cat-file", "blob", oid).stdout


def snapshot_policy(repo, files):
    item = files.get(POLICY)
    if item and item[0] not in {"100644", "100755"}:
        raise ValueError(".source-size.json must be a regular file")
    return load(blob(repo, item[1]) if item else None)


def validate_baselines(repo, files, policy, tree=None):
    """Check each ceiling's first-parent origin, including inherited bypasses."""
    active = set(policy["baseline"])
    if not active:
        return
    cache, sizes = {}, {}

    def snapshot(revision):
        if revision is None:
            return {}, load(None)
        if revision not in cache:
            items = entries(repo, revision)
            cache[revision] = items, snapshot_policy(repo, items)
        return cache[revision]

    def parent(revision):
        raw = git(repo, "cat-file", "-p", revision).stdout.split(b"\n\n", 1)[0]
        return next((line[7:].decode("ascii") for line in raw.splitlines()
                     if line.startswith(b"parent ")), None)

    def size(items, path):
        item = items.get(path)
        if not item or item[0] not in {"100644", "100755"}:
            return None
        prefix = blob(repo, item[1])[:2] if not Path(path).suffix else b""
        if not is_source(path, prefix, item[0]):
            return None
        if item[1] not in sizes:
            sizes[item[1]] = int(git(repo, "cat-file", "-s", item[1]).stdout)
        return sizes[item[1]]

    def transition(current, rules, previous, old_rules):
        for path in tuple(active):
            ceiling = rules["baseline"].get(path)
            if ceiling is None:
                raise ValueError(f"baseline ancestry missing for {path!r}")
            old = old_rules["baseline"].get(path)
            previous_size = size(previous, path)
            current_size = size(current, path)
            if current_size is not None and current_size > LIMIT and previous_size is None:
                raise ValueError(f"baseline cannot exempt new source: {path!r}; split the file")
            if old:
                if ceiling["max_bytes"] > old["max_bytes"]:
                    raise ValueError(f"baseline cannot increase: {path!r}; split the file")
            else:
                if (previous_size is None or previous_size <= LIMIT
                        or ceiling["max_bytes"] > previous_size):
                    raise ValueError(f"baseline requires pre-existing oversized source: {path!r}")
                active.remove(path)

    if tree and git(repo, "cat-file", "-t", tree).stdout.strip() == b"commit":
        revision = git(repo, "rev-parse", "--verify", tree).stdout.decode().strip()
    else:
        result = git(repo, "rev-parse", "--verify", "--quiet", "HEAD", check=False)
        revision = result.stdout.decode().strip() if result.returncode == 0 else None
        transition(files, policy, *snapshot(revision))
    if active and revision:
        paths = [":(literal)" + path for path in [POLICY, *sorted(active)]]
        history = git(repo, "log", "--first-parent", "--format=%H", revision, "--", *paths).stdout
        for commit in history.decode("ascii").splitlines():
            current, rules = snapshot(commit)
            transition(current, rules, *snapshot(parent(commit)))
            if not active:
                return
    if active:
        raise ValueError("baseline history unavailable; fetch full first-parent history before checking")


def inspect(repo, tree=None, *, all_files=False):
    files = entries(repo, tree)
    policy = snapshot_policy(repo, files)
    validate_baselines(repo, files, policy, tree)
    if tree or all_files:
        selected = files
    else:
        paths = git(repo, "diff", "--cached", "--name-only", "--no-renames",
                    "--diff-filter=ACMT", "-z").stdout
        selected = {os.fsdecode(p): files[os.fsdecode(p)] for p in paths.split(b"\x00")
                    if p and os.fsdecode(p) in files}
    bad, sources = [], []
    for path, (mode, oid) in selected.items():
        if mode not in {"100644", "100755"} or ignored(path, policy):
            continue
        size = int(git(repo, "cat-file", "-s", oid).stdout)
        # Extensionless executable scripts need only a shebang to be classified.
        prefix = blob(repo, oid)[:2] if not Path(path).suffix else b""
        if not is_source(path, prefix, mode):
            continue
        sources.append((path, size))
        if not permitted(path, size, policy):
            bad.append((path, size))
    return bad, sources


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=".")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--staged", action="store_true", help="check changed index blobs (default)")
    mode.add_argument("--tree", help="check every source blob in this commit/tree (CI)")
    mode.add_argument("--baseline", action="store_true", help="print an explicit baseline proposal from HEAD")
    args = parser.parse_args(argv)
    try:
        repo = git(args.repo, "rev-parse", "--show-toplevel").stdout.decode().strip()
        bad, sources = inspect(repo, "HEAD" if args.baseline else args.tree)
        if args.baseline:
            print(json.dumps({"version": 1, "generated": [], "baseline": {
                path: {"max_bytes": size, "reason": "Pre-existing source; no growth allowed. Split when touched."}
                for path, size in sources if size > LIMIT
            }}, indent=2, sort_keys=True))
            return 0
        if not bad:
            print(f"source-size: checked {len(sources)} source file(s); limit {LIMIT} bytes (~5000 tokens)")
            return 0
        print("source-size: commit/check blocked; source file exceeds its byte limit.", file=sys.stderr)
        for path, size in bad:
            print(f"  {path!r}: {size} bytes (~{(size + 3) // 4} tokens); default limit {LIMIT} bytes", file=sys.stderr)
        print("1. Identify independent responsibilities: parsing, storage, validation, UI, orchestration.\n"
              "2. Extract cohesive modules; keep public interfaces stable and dependencies one-way.\n"
              "3. Update imports and tests; run the relevant checks, then git add the split files and retry.\n"
              "Do not minify, remove useful comments, create empty forwarding shells, duplicate code,\n"
              "or introduce circular dependencies to evade this check. Generated code needs an explicit\n"
              ".source-size.json generated path + reason. Do not increase baselines just to pass.\n"
              "bytes/4 is an estimate, not a model-specific tokenizer.", file=sys.stderr)
        return 1
    except (ValueError, OSError, KeyError) as exc:
        print(f"source-size: check failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
