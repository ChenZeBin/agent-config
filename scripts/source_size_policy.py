"""Validate snapshot-local file-size policy. No code from a repository is run."""

import json
from pathlib import PurePosixPath

LIMIT = 20_000
POLICY = ".source-size.json"
SUFFIXES = frozenset((
    ".py .pyi .js .jsx .mjs .cjs .ts .tsx .mts .cts .swift .m .mm .h .hpp "
    ".c .cc .cpp .cxx .rs .go .java .kt .kts .cs .fs .php .rb .r .R .sh "
    ".bash .zsh .fish .ps1 .lua .pl .ex .exs .erl .hrl .clj .cljs .scala "
    ".dart .vue .svelte .css .scss .sass .less .sql .proto .graphql .gql"
).split())
LOCKS = frozenset((
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
    "bun.lock", "bun.lockb", "Cargo.lock", "Gemfile.lock", "poetry.lock",
    "uv.lock", "Pipfile.lock", "composer.lock", "go.sum", "Package.resolved",
    "Podfile.lock", "flake.lock",
))


def path_ok(value):
    return (isinstance(value, str) and value and not value.startswith("/")
            and ".." not in value.split("/") and "\x00" not in value)


def load(raw):
    if raw is None:
        return {"generated": [], "baseline": {}}
    data = json.loads(raw)
    if (not isinstance(data, dict) or set(data) - {"version", "generated", "baseline"}
            or type(data.get("version")) is not int or data["version"] != 1):
        raise ValueError("expected policy version 1 with generated/baseline fields")
    generated = data.get("generated", [])
    baseline = data.get("baseline", {})
    if not isinstance(generated, list) or not isinstance(baseline, dict):
        raise ValueError("generated must be a list; baseline must be an object")
    for item in generated:
        if (not isinstance(item, dict) or set(item) != {"path", "reason"}
                or not path_ok(item["path"]) or any(c in item["path"] for c in "*?[")
                or not isinstance(item["reason"], str)
                or not item["reason"].strip()):
            raise ValueError("each generated exemption needs an exact relative path and reason; no globs")
    for path, item in baseline.items():
        if (not path_ok(path) or any(c in path for c in "*?[")
                or not isinstance(item, dict) or set(item) != {"max_bytes", "reason"}
                or type(item["max_bytes"]) is not int or item["max_bytes"] <= LIMIT
                or not isinstance(item["reason"], str) or not item["reason"].strip()):
            raise ValueError("each baseline needs an exact path, max_bytes > 20000 and reason")
    return {"generated": generated, "baseline": baseline}


def ignored(path, policy):
    return (PurePosixPath(path).name in LOCKS
            or any(path == item["path"] for item in policy["generated"]))


def is_source(path, prefix=b"", mode="100644"):
    if mode not in {"100644", "100755"}:
        return False
    return (PurePosixPath(path).suffix in SUFFIXES
            or (not PurePosixPath(path).suffix and prefix.startswith(b"#!")))


def permitted(path, size, policy):
    return size <= max(LIMIT, policy["baseline"].get(path, {}).get("max_bytes", LIMIT))
