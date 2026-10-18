#!/usr/bin/env python3
"""Build or check the deterministic manifest-only skill catalog."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import stat
import sys

sys.dont_write_bytecode = True

from skill_catalog import CatalogError, Repository, load_catalog, render_markdown


ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail on drift without writing")
    args = parser.parse_args()
    try:
        expected = render_markdown(load_catalog(ROOT))
        with Repository(ROOT) as repo:
            if args.check:
                if repo.read("docs/skills.md") != expected:
                    print("catalog: drift; run python3 -B scripts/build_skill_catalog.py", file=sys.stderr)
                    return 1
                print("catalog is up to date")
                return 0
            try:
                os.mkdir("docs", dir_fd=repo.fd)
            except FileExistsError:
                pass
            with repo.directory("docs") as directory:
                fd = os.open(
                    "skills.md", os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK,
                    0o644, dir_fd=directory,
                )
                with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
                    info = os.fstat(stream.fileno())
                    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
                        raise CatalogError("docs/skills.md must be a regular file with one link")
                    stream.truncate(0)
                    stream.write(expected)
        print("generated docs/skills.md")
        return 0
    except (CatalogError, OSError, UnicodeError) as exc:
        print(f"catalog: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
