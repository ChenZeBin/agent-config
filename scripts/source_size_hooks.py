#!/usr/bin/env python3
"""Install a reversible dispatcher without replacing existing Git hook files."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

HOOKS = ("applypatch-msg pre-applypatch post-applypatch pre-commit pre-merge-commit "
         "prepare-commit-msg commit-msg post-commit pre-rebase post-checkout post-merge "
         "pre-push pre-auto-gc post-rewrite sendemail-validate fsmonitor-watchman "
         "post-index-change reference-transaction push-to-checkout pre-receive update "
         "post-receive post-update proc-receive").split()
RUNTIME = ("source_size.py", "source_size_policy.py", "source_size_hooks.py")
MARKER = "# agent-config source-size dispatcher v1"


def read_record(path, fields):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError(f"record collision: {path}")
    if not path.exists():
        return None
    record = json.loads(path.read_text())
    if (not isinstance(record, dict) or set(record) != fields
            or type(record.get("version")) is not int or record["version"] != 1):
        raise ValueError(f"invalid ownership record: {path}")
    return record


def git(repo, *args, check=True):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True)
    if check and result.returncode:
        raise ValueError(result.stderr.strip())
    return result.stdout.strip()


def root_path():
    return Path.home() / ".local" / "share" / "agent-config" / "source-size"


def wrapper(runtime, name):
    return ("#!/usr/bin/env python3\n" + MARKER + "\nimport sys\n"
            f"sys.path.insert(0, {str(runtime)!r})\n"
            "from source_size_hooks import dispatch\n"
            f"raise SystemExit(dispatch({name!r}, sys.argv[1:], __file__))\n")


def install_runtime():
    source, dest = Path(__file__).resolve().parent, root_path()
    if dest.is_symlink():
        raise ValueError("runtime collision: symlink")
    record_path = dest / "managed.json"
    if record_path.is_symlink():
        raise ValueError("runtime collision: symlink ownership record")
    record = read_record(record_path, {"version", "files"})
    if record and (not isinstance(record["files"], dict) or set(record["files"]) != set(RUNTIME)
                   or any(not isinstance(value, str) or len(value) != 64
                          for value in record["files"].values())):
        raise ValueError("invalid runtime ownership record")
    for name in RUNTIME:
        target = dest / name
        if target.is_symlink() or (target.exists() and not target.is_file()):
            raise ValueError(f"runtime collision: {target}")
        if target.exists() and (not record or hashlib.sha256(target.read_bytes()).hexdigest()
                                != record.get("files", {}).get(name)):
            raise ValueError(f"runtime collision: unowned or locally modified file: {name}")
    if source == dest:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="source-size-update-", dir=dest.parent) as temporary:
        stage = Path(temporary)
        names = [*RUNTIME, "managed.json"]
        for name in RUNTIME:
            shutil.copy2(source / name, stage / name)
        (stage / "managed.json").write_text(json.dumps({"version": 1, "files": {
            name: hashlib.sha256((stage / name).read_bytes()).hexdigest() for name in RUNTIME
        }}) + "\n")
        backup = stage / "backup"
        backup.mkdir()
        for name in names:
            if (dest / name).is_file():
                shutil.copy2(dest / name, backup / name)
        dest.mkdir(parents=True, exist_ok=True)
        changed = []
        try:
            for name in names:
                os.replace(stage / name, dest / name)
                changed.append(name)
        except OSError:
            for name in reversed(changed):
                if (backup / name).exists():
                    os.replace(backup / name, dest / name)
                else:
                    (dest / name).unlink()
            raise
    return dest


def location(scope, repo):
    if scope == "global":
        return root_path() / "hooks"
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir"))
    return common / "source-size-hooks"


def config(repo, scope, value=None, unset=False):
    args = ["config", "--" + scope]
    if unset:
        git(repo, *args, "--unset-all", "core.hooksPath", check=False)
    elif value is not None:
        git(repo, *args, "core.hooksPath", value)
    else:
        values = git(repo, *args, "--get-all", "core.hooksPath", check=False).splitlines()
        if len(values) > 1:
            raise ValueError("multiple hooksPath values: resolve explicitly before installation")
        return values[0] if values else None


def install(scope, repo):
    hooks = location(scope, repo)
    current = config(repo, scope)
    record_path = hooks / "source-size-state.json"
    if hooks.is_symlink():
        raise ValueError("hook directory collision: symlink")
    record = read_record(record_path, {"version", "scope", "previous", "original", "runtime"})
    if record and (record["scope"] != scope or record["runtime"] != str(root_path())
                   or any(value is not None and (not isinstance(value, str) or not value)
                          for value in (record["previous"], record["original"]))):
        raise ValueError("invalid dispatcher ownership record")
    if record and record.get("scope") == scope and current in (str(hooks), record.get("original")):
        previous = record["previous"]
        original = record["original"]
    else:
        if hooks.exists():
            raise ValueError("hook directory collision: not the active managed installation")
        if scope == "global" and current:
            raise ValueError("existing global hooksPath: preserve it; use repository-local installation")
        original = current
        previous = current
        if scope == "local" and current is None:
            previous = git(repo, "config", "--get", "core.hooksPath", check=False) or None
    if previous and (Path(previous).expanduser().resolve() == hooks.resolve()
                     or Path(previous).expanduser().resolve() == hooks.parent.resolve()):
        raise ValueError("recursive hook chain")
    runtime = root_path()
    # Preflight every wrapper before installing or changing any configuration.
    for name in HOOKS:
        path = hooks / name
        if path.is_symlink() or (path.exists() and path.read_text() != wrapper(runtime, name)):
            raise ValueError(f"hook collision: {path}")
    runtime = install_runtime()
    hooks.mkdir(parents=True, exist_ok=True)
    for name in HOOKS:
        path = hooks / name
        path.write_text(wrapper(runtime, name))
        path.chmod(0o755)
    record_path.write_text(json.dumps({"version": 1, "scope": scope, "previous": previous, "original": original,
                                       "runtime": str(runtime)}, indent=2) + "\n")
    config(repo, scope, str(hooks))
    print(f"source-size: installed {scope} dispatcher; prior hooks preserved")


def uninstall(scope, repo):
    hooks = location(scope, repo)
    if hooks.is_symlink():
        raise ValueError("hook directory collision: symlink")
    record = read_record(hooks / "source-size-state.json",
                         {"version", "scope", "previous", "original", "runtime"})
    if (not record or config(repo, scope) != str(hooks) or record["scope"] != scope
            or (record["original"] is not None and not isinstance(record["original"], str))):
        raise ValueError("configuration changed; refusing to overwrite it")
    if record["original"] is None:
        config(repo, scope, unset=True)
    else:
        config(repo, scope, record["original"])
    print("source-size: original configuration restored; hook files retained for recovery")


def default_hooks():
    # During git init's first reference transaction, HEAD does not exist yet.
    # A nested Git command rejects that directory, but Git exports its location.
    common = os.environ.get("GIT_COMMON_DIR")
    if common:
        return Path(common) / "hooks"
    directory = os.environ.get("GIT_DIR")
    if directory:
        directory = Path(directory)
        link = directory / "commondir"
        common = directory / link.read_text().strip() if link.is_file() else directory
        return common / "hooks"
    return Path(git(".", "rev-parse", "--path-format=absolute", "--git-common-dir")) / "hooks"


def dispatch(name, args, launcher):
    try:
        state = json.loads((Path(launcher).parent / "source-size-state.json").read_text())
        if name == "pre-commit":
            from source_size import main
            result = main(["--staged"])
            if result:
                return result
        previous = state["previous"]
        if previous:
            target = Path(previous).expanduser() / name
        else:
            target = default_hooks() / name
        if target.resolve() == Path(launcher).resolve():
            raise ValueError("recursive hook chain")
        if target.is_file() and os.access(target, os.X_OK):
            return subprocess.run([str(target.absolute()), *args]).returncode
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"source-size: hook dispatch failed: {exc}", file=sys.stderr)
        return 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["install", "uninstall"])
    parser.add_argument("--scope", choices=["global", "local"], default="local")
    parser.add_argument("--repo", default=".")
    args = parser.parse_args()
    try:
        (install if args.action == "install" else uninstall)(args.scope, args.repo)
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"source-size: installation failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
