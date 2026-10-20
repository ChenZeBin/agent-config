"""Baseline bypass counterexamples, called only by the reviewed Git cases."""

import json
from pathlib import Path
import subprocess
import sys

CHECKER = Path(__file__).resolve().parents[1] / "scripts/source_size.py"


def check(f, revision):
    result = subprocess.run([sys.executable, "-B", str(CHECKER), "--tree", revision],
                            cwd=f.repo, env=f.env, text=True, capture_output=True)
    assert result.returncode != 0 and "baseline" in result.stderr, result


def counterexamples(f):
    before = f.git("rev-parse", "HEAD").stdout.strip()
    original = json.loads((f.repo / ".source-size.json").read_text())
    for name, size, ceiling in (("new.py", 21000, 21000),
                                ("hand.py", 22000, 22000)):
        changed = dict(original["baseline"])
        changed[name] = {"max_bytes": ceiling, "reason": "Attempted same-change bypass"}
        f.policy(generated=original["generated"], baseline=changed)
        f.file(name, b"#" * size)
        f.stage(name)
        denied = f.commit(ok=False)
        assert denied.returncode != 0 and "baseline" in denied.stderr, denied
        assert f.git("rev-parse", "HEAD").stdout.strip() == before
        tree = f.git("write-tree").stdout.strip()
        check(f, tree)
        # commit-tree creates an unattached synthetic object, not a branch update.
        # This gives CI a bypassed commit without skipping any installed hook.
        bad = f.git("commit-tree", tree, "-p", before, data="synthetic invalid baseline\n").stdout.strip()
        check(f, bad)
        inherited = f.git("commit-tree", tree, "-p", bad, data="inherited invalid baseline\n").stdout.strip()
        check(f, inherited)
        f.policy(generated=original["generated"], baseline=original["baseline"])
        if name == "new.py":
            f.git("rm", "--force", "--", name)
        else:
            f.file(name, f.git("show", before + ":" + name).stdout)
            f.stage(name)
    allowed = subprocess.run([sys.executable, "-B", str(CHECKER), "--tree", "HEAD"],
                             cwd=f.repo, env=f.env, text=True, capture_output=True)
    assert allowed.returncode == 0, allowed
    shallow = f.base / "shallow"
    result = subprocess.run(["git", "clone", "--quiet", "--depth", "1", f.repo.as_uri(), str(shallow)],
                            env=f.env, text=True, capture_output=True)
    assert result.returncode == 0, result
    shallow_flag = subprocess.run(["git", "rev-parse", "--is-shallow-repository"],
                                  cwd=shallow, env=f.env, text=True, capture_output=True)
    assert shallow_flag.returncode == 0 and shallow_flag.stdout.strip() == "true"
    denied = subprocess.run([sys.executable, "-B", str(CHECKER), "--tree", "HEAD"],
                            cwd=shallow, env=f.env, text=True, capture_output=True)
    assert denied.returncode != 0 and "source-size: check failed" in denied.stderr, denied
    assert "parent" in denied.stderr or "object" in denied.stderr or "history" in denied.stderr, denied


def initial_counterexample(f):
    f.file("new.py", b"#" * 20001)
    f.policy(baseline={"new.py": {"max_bytes": 20001, "reason": "No parent exists"}})
    f.stage("new.py")
    denied = f.commit(ok=False)
    assert denied.returncode != 0 and "baseline" in denied.stderr, denied
    assert f.git("rev-parse", "--verify", "HEAD", ok=False).returncode != 0
    f.git("rm", "--force", "--", "new.py", ".source-size.json")
