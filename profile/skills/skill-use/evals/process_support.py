"""Run a bounded evaluation process and retain its original output."""

import contextlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def run_logged(command, output, name, *, cwd=None, env=None, prompt=None, timeout=170):
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    (output / (name + '.command.json')).write_text(json.dumps(command))
    started = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, env=env, text=True,
                               stdin=subprocess.PIPE if prompt is not None else subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                               start_new_session=True)
    timed_out = False
    try:
        try:
            stdout, stderr = process.communicate(prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            with contextlib.suppress(ProcessLookupError):
                os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate(timeout=5)
    finally:
        # The group belongs only to this invocation; leave other sessions alone.
        with contextlib.suppress(ProcessLookupError):
            os.killpg(process.pid, signal.SIGKILL)
    (output / (name + '.stdout')).write_text(stdout)
    (output / (name + '.stderr')).write_text(stderr)
    (output / (name + '.process.json')).write_text(json.dumps({
        'exit_code': process.returncode, 'timed_out': timed_out,
        'elapsed_seconds': round(time.monotonic() - started, 3),
        'process_group': process.pid, 'group_cleanup': 'killpg after exit or timeout'
    }, indent=2))
    if timed_out:
        raise TimeoutError(f'{name}: exceeded {timeout}s; original output retained in {output}')
    return subprocess.CompletedProcess(command, process.returncode, stdout, stderr)
