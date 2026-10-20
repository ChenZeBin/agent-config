#!/usr/bin/env python3
"""Exercise actual Git entrypoints. Run only after the test-plan review."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CHECKER = ROOT / "scripts" / "source_size.py"
INSTALLER = ROOT / "scripts" / "source_size_hooks.py"
sys.path.insert(0, str(ROOT / "scripts"))
from source_size_hooks import HOOKS, RUNTIME, wrapper


def run(argv, cwd, env, *, ok=True, data=None):
    result = subprocess.run([str(a) for a in argv], cwd=cwd, env=env, input=data,
                            capture_output=True, text=True)
    if ok:
        assert result.returncode == 0, (argv, result.returncode, result.stdout, result.stderr)
    return result


class Fixture:
    def __init__(self, base, *, live=False, install=True):
        self.base = base
        self.repo = base / "repo"
        self.repo.mkdir()
        self.env = dict(os.environ)
        for key in list(self.env):
            if key.startswith("GIT_"):
                self.env.pop(key)
        if not live:
            self.env.update(HOME=str(base / "home"), GIT_CONFIG_NOSYSTEM="1",
                            GIT_CONFIG_GLOBAL=str(base / "gitconfig"))
            (base / "home").mkdir()
        self.git("init", "-q")
        self.git("config", "user.name", "Source Size Test")
        self.git("config", "user.email", "source-size@example.com")
        self.git("config", "commit.gpgsign", "false")
        if install and not live:
            self.install("global")

    def git(self, *args, ok=True, data=None):
        return run(["git", *args], self.repo, self.env, ok=ok, data=data)

    def install(self, scope):
        return run([sys.executable, "-B", INSTALLER, "install", "--scope", scope],
                   self.repo, self.env)

    def file(self, name, data):
        path = self.repo / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data if isinstance(data, bytes) else data.encode())
        return path

    def stage(self, *names):
        self.git("add", "--", *names)

    def commit(self, *, ok=True):
        return self.git("commit", "-q", "-m", "synthetic source size case", ok=ok)

    def policy(self, *, generated=None, baseline=None):
        self.file(".source-size.json", json.dumps({"version": 1, "generated": generated or [],
                                                   "baseline": baseline or {}}))
        self.stage(".source-size.json")


def limit_boundary(f):
    f.file("module.py", b"#" + b"x" * 20000)
    f.stage("module.py")
    blocked = f.commit(ok=False)
    assert blocked.returncode != 0
    assert f.git("rev-parse", "--verify", "HEAD", ok=False).returncode != 0
    for text in ("module.py", "20001 bytes", "5001 tokens", "20000", "responsibilities",
                 "interfaces", "tests", "git add", "shells", "circular", "duplicate", "minify"):
        assert text in blocked.stderr, (text, blocked.stderr)
    f.file("module.py", b"#" + b"x" * 19999)
    f.stage("module.py")
    f.commit()
    assert len(f.git("show", "HEAD:module.py").stdout.encode()) == 20000


def index_not_worktree(f):
    f.file("part.py", "x = 1\n")
    f.stage("part.py")
    f.file("part.py", b"#" * 21000)
    f.commit()
    assert f.git("show", "HEAD:part.py").stdout == "x = 1\n"
    f.stage("part.py")
    f.file("part.py", "x = 2\n")
    before = f.git("rev-parse", "HEAD").stdout
    rejected = f.commit(ok=False)
    assert rejected.returncode != 0 and "21000 bytes" in rejected.stderr
    assert f.git("rev-parse", "HEAD").stdout == before
    f.stage("part.py")
    f.commit()
    for name in ("space name.py", "line\nbreak.py", "\u6a21\u5757.py", "$(touch injected).py"):
        f.file(name, b"#" * 21000)
        f.stage(name)
        before = f.git("rev-parse", "HEAD").stdout
        rejected = f.commit(ok=False)
        assert rejected.returncode != 0 and repr(name) in rejected.stderr
        assert f.git("rev-parse", "HEAD").stdout == before
        assert not (f.repo / "injected").exists()
        assert f.git("cat-file", "-s", ":" + name).stdout.strip() == "21000"
        f.git("rm", "--cached", "--", name)


def exempt_and_policy_snapshot(f):
    assert "does not infer whether a human or an agent authored a file" in (ROOT / "docs/source-size.md").read_text()
    assert f.git("rev-parse", "--verify", "HEAD").returncode == 0
    assert f.git("cat-file", "-s", "HEAD:hand.py").stdout.strip() == "21000"
    f.file("package-lock.json", b"x" * 40000)
    f.file("image.dat", b"\x00" * 40000)
    f.file("schema.generated.ts", b"//" * 12000)
    f.policy(generated=[{"path": "schema.generated.ts", "reason": "Schema compiler output"}])
    f.stage("package-lock.json", "image.dat", "schema.generated.ts")
    f.commit()
    for name in ("package-lock.json", "image.dat", "schema.generated.ts"):
        assert f.git("cat-file", "-s", "HEAD:" + name).stdout.strip() in {"40000", "24000"}
    f.policy(generated=[{"path": "**/*.ts", "reason": "Too broad even with a reason"}])
    rejected = f.commit(ok=False)
    assert rejected.returncode != 0 and "no globs" in rejected.stderr
    f.policy(generated=[{"path": "schema.generated.ts", "reason": "Schema compiler output"}])
    f.file("hand.py", b"x" * 21000)
    f.stage("hand.py")
    f.file(".source-size.json", json.dumps({"version": 1, "generated": [
        {"path": "hand.py", "reason": "Unstaged exemption must not apply"}]}))
    assert f.commit(ok=False).returncode != 0
    f.policy(generated=[{"path": "schema.generated.ts", "reason": "Schema compiler output"}],
             baseline={"hand.py": {"max_bytes": 21000, "reason": "Legacy no-growth ceiling"}})
    f.commit()
    f.file("hand.py", b"#" * 21001)
    f.stage("hand.py")
    assert f.commit(ok=False).returncode != 0
    f.file("hand.py", b"#" * 20500)
    f.stage("hand.py")
    f.commit()
    f.file("another.py", b"#" * 20500)
    f.stage("another.py")
    assert f.commit(ok=False).returncode != 0


def rename_delete_recover(f):
    f.file("legacy.py", b"#" * 21000)
    f.file("small.py", "x = 1\n")
    f.policy(baseline={"legacy.py": {"max_bytes": 21000, "reason": "Legacy source"}})
    f.stage("legacy.py", "small.py")
    f.commit()
    f.git("mv", "legacy.py", "renamed.py")
    assert f.commit(ok=False).returncode != 0
    f.git("rm", "--force", "--", "renamed.py")
    f.commit()
    f.file("large.py", b"#" * 21000)
    f.stage("large.py")
    assert f.commit(ok=False).returncode != 0
    f.file("large.py", b"#" * 10000)
    f.file("helper.py", b"#" * 11000)
    f.stage("large.py", "helper.py")
    f.commit()
    assert f.git("ls-tree", "--name-only", "HEAD").stdout.splitlines() == [
        ".source-size.json", "helper.py", "large.py", "small.py"]


def hook_chain_and_uninstall(f):
    hook = f.file("custom-hooks/pre-commit", "#!/bin/sh\nprintf 'prior\\n' >> prior.log\n[ ! -f reject ]\n")
    hook.chmod(0o755)
    push = f.file("custom-hooks/pre-push", "#!/bin/sh\nprintf '%s\\n' \"$@\" > push.args\ncat > push.stdin\nexit 7\n")
    push.chmod(0o755)
    before = (hook.read_bytes(), push.read_bytes())
    f.git("config", "core.hooksPath", "custom-hooks")
    f.install("local")
    all_hook_forwarding(f, "custom-hooks")
    f.file("part.py", "x = 1\n")
    f.stage("part.py")
    accepted = f.commit()
    assert "source-size: checked" in accepted.stdout + accepted.stderr
    assert (f.repo / "prior.log").read_text() == "prior\n"
    f.file("probe.py", b"#" * 20001)
    f.stage("probe.py")
    rejected = f.commit(ok=False)
    assert rejected.returncode != 0 and "20001 bytes" in rejected.stderr
    assert (f.repo / "prior.log").read_text() == "prior\n"
    f.git("rm", "--force", "--", "probe.py")
    f.file("reject", "reject")
    f.file("part.py", "x = 2\n")
    f.stage("part.py")
    assert f.commit(ok=False).returncode != 0
    stdin_path = f.file("push-input.txt", "ref old new\n")
    result = f.git("hook", "run", "--to-stdin=" + str(stdin_path), "pre-push", "--",
                   "test-remote", "test-url", ok=False)
    assert result.returncode == 7, (result.returncode, result.stderr)
    assert (f.repo / "push.args").read_text() == "test-remote\ntest-url\n"
    assert (f.repo / "push.stdin").read_text() == "ref old new\n"
    run([sys.executable, "-B", INSTALLER, "uninstall", "--scope", "local"], f.repo, f.env)
    assert f.git("config", "--local", "--get", "core.hooksPath").stdout.strip() == "custom-hooks"
    assert before == (hook.read_bytes(), push.read_bytes())


def collision_and_default_hooks(f):
    f.git("config", "--global", "core.hooksPath", "unknown-hooks")
    assert run([sys.executable, "-B", INSTALLER, "install", "--scope", "global"],
               f.repo, f.env, ok=False).returncode != 0
    assert f.git("config", "--global", "--get", "core.hooksPath").stdout.strip() == "unknown-hooks"
    f.git("config", "--global", "--unset", "core.hooksPath")
    f.install("global")
    all_hook_forwarding(f, ".git/hooks")
    for name in ("pre-commit", "commit-msg", "pre-push"):
        extra = ""
        if name == "commit-msg":
            extra = "printf '%s\\n' \"$1\" > message.args\n"
        if name == "pre-push":
            extra = "printf '%s\\n' \"$@\" > push.args\ncat > push.stdin\nexit 9\n"
        target = f.file(".git/hooks/" + name,
                        f"#!/bin/sh\nprintf '{name}\\n' >> default-hooks.log\n" + extra)
        target.chmod(0o755)
    f.file("small.py", "x = 1\n")
    f.stage("small.py")
    f.commit()
    assert (f.repo / "message.args").read_text().strip().endswith("COMMIT_EDITMSG")
    stdin_path = f.file("push-input.txt", "default-input\n")
    pushed = f.git("hook", "run", "--to-stdin=" + str(stdin_path), "pre-push", "--", "remote", "url", ok=False)
    assert pushed.returncode == 9
    assert (f.repo / "push.args").read_text() == "remote\nurl\n"
    assert (f.repo / "push.stdin").read_text() == "default-input\n"
    assert (f.repo / "default-hooks.log").read_text().splitlines() == ["pre-commit", "commit-msg", "pre-push"]
    default_repository_lifecycle(f)
    wrapper = Path(f.git("config", "--global", "--get", "core.hooksPath").stdout.strip()) / "pre-commit"
    wrapper.write_text("unknown original\n")
    assert run([sys.executable, "-B", INSTALLER, "install", "--scope", "global"],
               f.repo, f.env, ok=False).returncode != 0
    assert wrapper.read_text() == "unknown original\n"
    run([sys.executable, "-B", INSTALLER, "uninstall", "--scope", "global"], f.repo, f.env)
    assert f.git("config", "--global", "--get", "core.hooksPath", ok=False).returncode != 0
    assert (f.repo / ".git/hooks/pre-push").read_text().endswith("exit 9\n")
    f.git("config", "core.hooksPath", "custom-hooks")
    original = f.file("custom-hooks/pre-commit", "#!/bin/sh\nexit 0\n")
    common = Path(f.git("rev-parse", "--path-format=absolute", "--git-common-dir").stdout.strip())
    collision = common / "source-size-hooks/pre-commit"
    collision.parent.mkdir()
    collision.write_text("unknown local wrapper\n")
    assert run([sys.executable, "-B", INSTALLER, "install", "--scope", "local"],
               f.repo, f.env, ok=False).returncode != 0
    assert collision.read_text() == "unknown local wrapper\n"
    assert original.read_text() == "#!/bin/sh\nexit 0\n"
    assert f.git("config", "--local", "--get", "core.hooksPath").stdout.strip() == "custom-hooks"


def default_repository_lifecycle(f):
    bare = f.base / "bare.git"
    run(["git", "init", "--bare", "-q", bare], f.base, f.env)
    receive = bare / "hooks/pre-receive"
    receive.write_text("#!/bin/sh\nprintf '%s\\n' \"$@\" > receive.args\ncat > receive.stdin\nexit 13\n")
    receive.chmod(0o755)
    payload = f.file("receive-input.txt", "receive input\n")
    result = run(["git", "hook", "run", "--to-stdin=" + str(payload), "pre-receive", "--", "one"],
                 bare, f.env, ok=False)
    assert result.returncode == 13, result.stderr
    assert (bare / "receive.args").read_text() == "one\n"
    assert (bare / "receive.stdin").read_text() == "receive input\n"
    linked = f.base / "linked"
    f.git("worktree", "add", "--detach", str(linked), "HEAD")
    try:
        result = run(["git", "hook", "run", "--to-stdin=" + str(payload), "pre-push", "--", "remote", "url"],
                     linked, f.env, ok=False)
        assert result.returncode == 9, result.stderr
        assert (linked / "push.args").read_text() == "remote\nurl\n"
        assert (linked / "push.stdin").read_text() == "receive input\n"
    finally:
        f.git("worktree", "remove", "--force", str(linked))
    assert not linked.exists()
    assert str(linked) not in f.git("worktree", "list", "--porcelain").stdout


def all_hook_forwarding(f, directory):
    """The generic dispatcher must forward every hook it installs."""
    for name in HOOKS:
        target = f.repo / directory / name
        prior = target.read_bytes() if target.is_file() else None
        prior_mode = target.stat().st_mode if target.is_file() else None
        try:
            f.file(directory + "/" + name,
                   "#!/bin/sh\nprintf '%s\\n' \"$@\" > all.args\ncat > all.stdin\nexit 11\n").chmod(0o755)
            payload = f.file("all-input.txt", "hook input\n")
            result = f.git("hook", "run", "--to-stdin=" + str(payload), name, "--", "one", "two words", ok=False)
            assert result.returncode == 11, (name, result.stderr)
            assert (f.repo / "all.args").read_text() == "one\ntwo words\n", name
            assert (f.repo / "all.stdin").read_text() == "hook input\n", name
        finally:
            if prior is None:
                target.unlink(missing_ok=True)
            else:
                target.write_bytes(prior)
                target.chmod(prior_mode)


def ci_tree_parity(f):
    f.file("part.py", "x = 1\n")
    f.stage("part.py")
    f.commit()
    run([sys.executable, "-B", CHECKER, "--tree", "HEAD"], f.repo, f.env)
    f.file("part.py", b"#" * 21000)
    f.stage("part.py")
    tree = f.git("write-tree").stdout.strip()
    assert run([sys.executable, "-B", CHECKER, "--tree", tree], f.repo, f.env, ok=False).returncode != 0
    f.file("part.py", "x = 2\n")
    assert run([sys.executable, "-B", CHECKER, "--tree", tree], f.repo, f.env, ok=False).returncode != 0
    workflow = (ROOT / ".github/workflows/validate.yml").read_text()
    for text in ("scripts/source_size.py --tree HEAD", "bin/agent-config validate",
                 "privacy_scan.py --root . --git-history", "gitleaks/gitleaks-action@v3",
                 "build_skill_catalog.py --check", "unittest discover -s tests -v"):
        assert text in workflow
    hook = (ROOT / ".githooks/pre-commit").read_text()
    for text in ("scripts/source_size.py", "--staged", "validate", "privacy_scan.py", "gitleaks protect"):
        assert text in hook
    f.policy(generated=[{"path": "part.py", "reason": "Synthetic parity fixture only"}])
    tree = f.git("write-tree").stdout.strip()
    f.file(".source-size.json", "not the staged policy\n")
    for args in (("--staged",), ("--tree", tree)):
        allowed = run([sys.executable, "-B", CHECKER, *args], f.repo, f.env)
        assert "checked 0 source" in allowed.stdout
    f.policy()
    tree = f.git("write-tree").stdout.strip()
    for args in (("--staged",), ("--tree", tree)):
        rejected = run([sys.executable, "-B", CHECKER, *args], f.repo, f.env, ok=False)
        assert rejected.returncode == 1 and "21000 bytes" in rejected.stderr


def live_global_entrypoint(f):
    before = f.git("config", "--global", "--get", "core.hooksPath").stdout
    assert "source-size/hooks" in before
    hooks = Path(before.strip())
    runtime = hooks.parent
    for name in RUNTIME:
        assert (runtime / name).read_bytes() == (ROOT / "scripts" / name).read_bytes(), name
    for name in HOOKS:
        assert (hooks / name).read_text() == wrapper(runtime, name), name
    state = json.loads((hooks / "source-size-state.json").read_text())
    assert state["scope"] == "global" and state["runtime"] == str(runtime)
    assert state["previous"] is None
    limit_boundary(f)
    assert f.git("config", "--global", "--get", "core.hooksPath").stdout == before


CASES = [
    ("limit-boundary", limit_boundary, True),
    ("index-not-worktree", index_not_worktree, True),
    ("exempt-and-policy-snapshot", exempt_and_policy_snapshot, True),
    ("rename-delete-recover", rename_delete_recover, True),
    ("hook-chain-and-uninstall", hook_chain_and_uninstall, False),
    ("collision-and-default-hooks", collision_and_default_hooks, False),
    ("ci-tree-parity", ci_tree_parity, True),
    ("live-global-entrypoint", live_global_entrypoint, False),
]


def main():
    failures = 0
    for case_id, function, install in CASES:
        live = case_id == "live-global-entrypoint"
        try:
            with tempfile.TemporaryDirectory(prefix="source-size-e2e-") as temporary:
                fixture = Fixture(Path(temporary), live=live,
                                  install=install and case_id != "exempt-and-policy-snapshot")
                if case_id == "exempt-and-policy-snapshot":
                    fixture.file("hand.py", b"#" * 21000)
                    fixture.stage("hand.py")
                    fixture.commit()
                    fixture.install("global")
                function(fixture)
            assert not Path(temporary).exists(), "temporary HOME/repository not cleaned"
            status, actual = "pass", "Actual Git assertions passed; temporary HOME/repository removed: " + case_id
        except Exception as exc:
            status, actual = "fail", str(exc)
            failures += 1
        print("EVIDENCE_GATE_CASE " + json.dumps({"id": case_id, "status": status,
              "environment_id": "local-default-git" if live else "isolated-git", "actual": actual}), flush=True)
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
