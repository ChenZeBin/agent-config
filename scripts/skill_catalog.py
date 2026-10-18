"""Read the manifest catalog without executing skills or following symlinks.

Frontmatter uses a deliberately limited YAML subset: block mappings, scalar
sequences, single-line plain/quoted scalars and literal/folded blocks with
optional +/- chomping. Only empty flow collections are supported. Anchors,
aliases, tags, multiline quoted/plain scalars and explicit block indentation
indicators are rejected. This is not a general YAML parser.
"""

from __future__ import annotations

from contextlib import contextmanager
import html
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
from urllib.parse import quote, urlsplit


class CatalogError(ValueError):
    pass


NAME = re.compile(r"[a-z0-9]+(?:-[a-z0-9]+)*\Z")
CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\ud800-\udfff]")
NOT_DECLARED = "not declared; no permission inferred"


def safe_parts(value: str) -> tuple[str, ...]:
    if (
        not isinstance(value, str) or not value or "\\" in value
        or CONTROL.search(value) or PurePosixPath(value).is_absolute()
        or any(part in {"", ".", ".."} for part in value.split("/"))
    ):
        raise CatalogError(f"unsafe repository path: {value!r}")
    return tuple(value.split("/"))


class Repository:
    """Anchor all data access to directory descriptors with O_NOFOLLOW."""

    def __init__(self, root: Path):
        self.fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)

    def __enter__(self):
        return self

    def __exit__(self, *unused):
        os.close(self.fd)

    @contextmanager
    def directory(self, relative: str):
        fd = os.dup(self.fd)
        try:
            for part in safe_parts(relative):
                child = os.open(
                    part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd,
                )
                os.close(fd)
                fd = child
            yield fd
        finally:
            os.close(fd)

    @contextmanager
    def file(self, relative: str):
        parts = safe_parts(relative)
        parent = "/".join(parts[:-1])
        with self.directory(parent) if parent else self.root_directory() as directory:
            fd = os.open(
                parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                dir_fd=directory,
            )
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise CatalogError(f"not a regular file: {relative}")
                yield fd
            finally:
                os.close(fd)

    @contextmanager
    def root_directory(self):
        yield self.fd

    def read(self, relative: str) -> str:
        with self.file(relative) as fd:
            with os.fdopen(os.dup(fd), encoding="utf-8", newline="") as stream:
                return stream.read()

    def check_file(self, relative: str) -> None:
        with self.file(relative):
            pass

    def skill_names(self) -> set[str]:
        with self.directory("profile/skills") as fd:
            with os.scandir(fd) as children:
                names = set()
                for child in children:
                    if child.is_symlink():
                        raise CatalogError(f"symlink in profile/skills: {child.name}")
                    if child.is_dir(follow_symlinks=False):
                        names.add(child.name)
                return names


def unique_object(pairs: list) -> dict:
    result = {}
    for key, value in pairs:
        if key in result:
            raise CatalogError(f"duplicate key: {key}")
        result[key] = value
    return result


def invalid_constant(value: str):
    raise CatalogError(f"invalid JSON constant: {value}")


def finite_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number):
        raise CatalogError(f"non-finite JSON number: {value}")
    return number


def read_json(repo: Repository, path: str) -> dict:
    try:
        data = json.loads(
            repo.read(path), object_pairs_hook=unique_object,
            parse_constant=invalid_constant, parse_float=finite_float,
        )
    except (ValueError, OSError, UnicodeError) as exc:
        raise CatalogError(f"{path}: {exc}") from exc
    if not isinstance(data, dict) or type(data.get("schema_version")) is not int or data["schema_version"] != 1:
        raise CatalogError(f"{path}: expected object with schema_version 1")
    return data


def scalar(value: str):
    if value.startswith('"'):
        try:
            decoded, end = json.JSONDecoder().raw_decode(value)
        except ValueError as exc:
            raise CatalogError("invalid double-quoted scalar (use JSON escapes)") from exc
        tail = value[end:]
        if tail.strip() and not re.fullmatch(r"\s+#.*", tail):
            raise CatalogError("unexpected text after quoted scalar")
        return decoded
    if value.startswith("'"):
        match = re.fullmatch(r"'((?:[^']|'')*)'(?:\s+#.*|\s*)", value)
        if not match:
            raise CatalogError("invalid single-quoted scalar")
        return match[1].replace("''", "'")
    value = re.split(r"\s+#", value, maxsplit=1)[0].rstrip()
    if not value or value in {"~", "null", "Null", "NULL"}:
        return None
    if value in {"true", "True", "TRUE", "false", "False", "FALSE"}:
        return value.lower() == "true"
    if value in {"[]", "{}"}:
        return [] if value == "[]" else {}
    if re.fullmatch(r"[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?", value):
        return float(value) if any(c in value for c in ".eE") else int(value)
    if re.fullmatch(r"[-+]?(?:0x[0-9a-fA-F]+|0o[0-7]+|\.(?:inf|Inf|INF|nan|NaN|NAN))", value):
        raise CatalogError("unsupported numeric scalar; quote it to use as text")
    if (
        value[0] in "[]{}&*!|>'\"%@`"
        or re.match(r"[-?:](?:\s|$)", value)
        or re.search(r":(?:\s|$)", value)
    ):
        raise CatalogError("unsupported or invalid scalar")
    return value


class Frontmatter:
    def __init__(self, text: str):
        lines = text.split("\n")
        if lines[0].rstrip("\r") != "---":
            raise CatalogError("missing frontmatter delimiter")
        end = next((i for i, line in enumerate(lines[1:], 1) if line.rstrip("\r") == "---"), None)
        if end is None:
            raise CatalogError("unterminated frontmatter")
        self.lines = [line.rstrip("\r") for line in lines[1:end]]
        if any(CONTROL.search(line) or re.match(r" *\t", line) for line in self.lines):
            raise CatalogError("control character or tab indentation in frontmatter")
        self.index = 0

    def peek(self):
        while self.index < len(self.lines):
            line = self.lines[self.index]
            if line.strip() and not line.lstrip().startswith("#"):
                return len(line) - len(line.lstrip(" ")), line.lstrip(" ")
            self.index += 1
        return None

    def block(self, header: str, parent_indent: int) -> str:
        if not re.fullmatch(r"[>|][+-]?(?:\s+#.*|\s*)", header):
            raise CatalogError("unsupported block scalar header")
        mode = header[:2].strip()
        body = []
        indent = None
        while self.index < len(self.lines):
            line = self.lines[self.index]
            width = len(line) - len(line.lstrip(" "))
            if line.strip() and width <= parent_indent:
                break
            if line.strip():
                if indent is None:
                    indent = width
                if width < indent:
                    raise CatalogError("invalid block scalar indentation")
            body.append(line)
            self.index += 1
        body = [line[indent:] if line.strip() else "" for line in body] if indent else []
        if header[0] == "|":
            result = "\n".join(body) + ("\n" if body else "")
        else:
            nonempty = [i for i, line in enumerate(body) if line]
            result = ""
            previous = None
            for index in nonempty:
                if previous is None:
                    result += "\n" * index
                else:
                    gap = index - previous - 1
                    if body[previous].startswith((" ", "\t")) or body[index].startswith((" ", "\t")):
                        result += "\n" * (gap + 1)
                    else:
                        result += "\n" * gap if gap else " "
                result += body[index]
                previous = index
            if previous is not None:
                result += "\n" * (len(body) - previous)
            else:
                result = "\n" * len(body)
        if mode.endswith("-"):
            return result.rstrip("\n")
        if mode.endswith("+"):
            return result
        return result.rstrip("\n") + ("\n" if result.strip("\n") else "")

    def value(self, value: str, indent: int):
        if value.startswith((">", "|")):
            return self.block(value, indent)
        if not value or value.startswith("#"):
            next_line = self.peek()
            if next_line and next_line[0] > indent:
                return self.collection(next_line[0])
            return None
        return scalar(value)

    def collection(self, indent: int):
        first = self.peek()
        sequence = first is not None and re.match(r"-(?:\s|$)", first[1]) is not None
        result = [] if sequence else {}
        while (line := self.peek()) is not None:
            width, content = line
            if width < indent:
                break
            if width != indent:
                raise CatalogError("unsupported continuation or inconsistent indentation")
            self.index += 1
            if sequence:
                if not re.match(r"-(?:\s|$)", content):
                    raise CatalogError("mixed sequence and mapping")
                value = self.value(content[1:].strip(), indent)
                if isinstance(value, (dict, list)):
                    raise CatalogError("only scalar sequence items are supported")
                result.append(value)
            else:
                match = re.fullmatch(r"([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t]+(.*))?", content)
                if not match:
                    raise CatalogError("unsupported or invalid mapping entry")
                key, value = match.groups()
                if key in result:
                    raise CatalogError(f"duplicate key: {key}")
                result[key] = self.value(value or "", indent)
        return result

    def parse(self) -> dict:
        if self.peek() is None:
            raise CatalogError("empty frontmatter")
        result = self.collection(0)
        if not isinstance(result, dict):
            raise CatalogError("frontmatter must be a mapping")
        for field in ("name", "description"):
            value = result.get(field)
            if not isinstance(value, str) or not value.strip():
                raise CatalogError(f"{field} must be a non-empty string scalar")
            if CONTROL.search(value):
                raise CatalogError(f"control character in {field}")
        return result


def validate_metadata(repo: Repository, value, location: str) -> None:
    if isinstance(value, dict):
        for key, item in value.items():
            if CONTROL.search(key):
                raise CatalogError(f"{location}: control character in key")
            if key == "license_file":
                parts = safe_parts(item)
                if len(parts) < 2 or parts[0] != "third_party_licenses":
                    raise CatalogError(f"{location}: unsafe license_file")
                repo.check_file(item)
            validate_metadata(repo, item, f"{location}.{key}")
    elif isinstance(value, list):
        for item in value:
            validate_metadata(repo, item, location)
    elif isinstance(value, str) and CONTROL.search(value):
        raise CatalogError(f"{location}: control character in metadata")


def load_catalog(root: Path, skill: str | None = None) -> dict:
    try:
        with Repository(root) as repo:
            manifest = read_json(repo, "manifest.yaml")
            profile = manifest.get("profile")
            if not isinstance(profile, dict) or profile.get("agents") != "profile/AGENTS.md":
                raise CatalogError("manifest profile/agents is invalid")
            names = profile.get("skills")
            if not isinstance(names, list) or not names or any(
                not isinstance(name, str) or not NAME.fullmatch(name) for name in names
            ):
                raise CatalogError("manifest skills must be a non-empty list of safe skill names")
            if len(names) != len(set(names)):
                raise CatalogError("manifest has duplicate skill names")
            actual = repo.skill_names()
            if actual != set(names):
                raise CatalogError(
                    "manifest skill directories mismatch: "
                    f"undeclared={sorted(actual - set(names))}, missing={sorted(set(names) - actual)}"
                )
            lock = read_json(repo, "dependencies/skills.lock.yaml").get("skills")
            if not isinstance(lock, dict) or set(lock) != set(names):
                raise CatalogError("lock must list exactly the manifest skills")
            entries = []
            for name in sorted(names):
                metadata = lock[name]
                if not isinstance(metadata, dict):
                    raise CatalogError(f"{name}: lock metadata must be an object")
                for field in ("source", "version", "revision", "tracking", "license", "license_file"):
                    if field in metadata and (
                        not isinstance(metadata[field], str) or not metadata[field].strip()
                    ):
                        raise CatalogError(f"{name}: lock {field} must be a non-empty string")
                if not metadata.get("tracking"):
                    raise CatalogError(f"{name}: lock tracking is missing")
                if "revision" in metadata and not re.fullmatch(r"[0-9a-f]{40}", metadata["revision"]):
                    raise CatalogError(f"{name}: lock revision must be 40 lowercase hex characters")
                if "source" in metadata:
                    url = urlsplit(metadata["source"])
                    if url.scheme != "https" or not url.netloc or url.username or url.password or any(
                        c.isspace() for c in metadata["source"]
                    ):
                        raise CatalogError(f"{name}: lock source must be an HTTPS URL without credentials")
                    if not metadata.get("revision"):
                        raise CatalogError(f"{name}: source requires a pinned revision")
                validate_metadata(repo, metadata, name)
                path = f"profile/skills/{name}/SKILL.md"
                try:
                    frontmatter = Frontmatter(repo.read(path)).parse()
                except (CatalogError, OSError, UnicodeError) as exc:
                    raise CatalogError(f"{path}: {exc}") from exc
                if frontmatter["name"] != name:
                    raise CatalogError(f"{path}: frontmatter name does not match manifest")
                entry = {
                    "name": name,
                    "description": frontmatter["description"],
                    "path": path,
                    **{key: metadata.get(key) for key in (
                        "source", "version", "revision", "tracking", "license", "license_file",
                    )},
                    "license_status": "declared" if metadata.get("license") else "not-declared",
                    "lock": metadata,
                }
                entries.append(entry)
            if skill is not None:
                if skill not in names:
                    raise CatalogError(f"unknown skill: {skill!r} (use an exact manifest name)")
                entries = [entry for entry in entries if entry["name"] == skill]
            return {
                "schema_version": 1,
                "scope": "manifest.profile.skills",
                "manifest_count": len(names),
                "count": len(entries),
                "skills": entries,
            }
    except (OSError, UnicodeError, RecursionError) as exc:
        raise CatalogError(f"catalog input cannot be read safely: {exc}") from exc
    except ValueError as exc:
        if isinstance(exc, CatalogError):
            raise
        raise CatalogError(f"invalid catalog input: {exc}") from exc


def render_json(catalog: dict) -> str:
    return json.dumps(catalog, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


def summary(description: str) -> str:
    text = " ".join(description.split())
    first = re.split(r"(?<=[.!?])\s+(?=[A-Z])|(?<=[\u3002\uff01\uff1f])", text, maxsplit=1)[0]
    if len(first) <= 140:
        return first
    return first[:137].rstrip() + "..."


def render_human(catalog: dict) -> str:
    lines = [
        f"Skills catalog: {catalog['count']} of {catalog['manifest_count']} manifest skills",
        "Only manifest entries; nested fixtures are excluded.",
        "Provenance is not compatibility proof. Missing licenses grant no permission.",
        "Descriptions below are excerpts; use catalog --json for full descriptions and lock metadata.",
        "",
    ]
    for entry in catalog["skills"]:
        lines.extend([
            entry["name"],
            f"  Purpose: {summary(entry['description'])}",
            f"  Path: {entry['path']}",
            f"  Source: {entry['source'] or 'not declared'}",
            f"  Version: {entry['version'] or 'not declared'}",
            f"  Revision: {entry['revision'] or 'not declared'}",
            f"  Tracking: {entry['tracking']}",
            f"  License: {entry['license'] or NOT_DECLARED}",
            f"  License file: {entry['license_file'] or 'not declared'}",
            "",
        ])
    return "\n".join(lines)


def markdown_text(value: str) -> str:
    value = html.escape(" ".join(value.split()), quote=False)
    return re.sub(r"([\\`*_\[\]{}()|#!])", r"\\\1", value)


def markdown_link(label: str, target: str) -> str:
    return f"[{markdown_text(label)}]({quote(target, safe='/:#?=&%+')})"


def render_markdown(catalog: dict) -> str:
    lines = [
        "# Skill 目录",
        "",
        "<!-- Generated by scripts/build_skill_catalog.py; do not edit. -->",
        "",
        f"这里只列出 [manifest.yaml](../manifest.yaml) 声明的 **{catalog['manifest_count']} 个 Skill**，不收录嵌套评测夹具。",
        "用途列是描述摘要。点击名称读取完整指令；外部依赖和运行条件以各 Skill 为准。",
        "来源记录和安装成功不证明实际运行兼容。未声明许可证时，不推断已有使用或分发授权。",
        "依赖组件的许可证也不代表整个 Skill 的许可证。",
        "",
        "完整描述、版本、revision 和来源关系可用 CLI 查询，也可查看 [来源清单](../dependencies/skills.lock.yaml)。",
        "安装方式见 [README](../README.md)，更新目录见 [维护与发布](../CONTRIBUTING.md)。",
        "",
        "```sh",
        "bin/agent-config catalog",
        "bin/agent-config catalog --json",
        "bin/agent-config catalog --skill teach --json",
        "python3 -B scripts/build_skill_catalog.py",
        "python3 -B scripts/build_skill_catalog.py --check",
        "```",
        "",
        "| Skill | 用途摘要 | 来源 | 许可证 |",
        "| --- | --- | --- | --- |",
    ]
    for entry in catalog["skills"]:
        license_text = markdown_text(entry["license"] or NOT_DECLARED)
        if entry["license_file"]:
            license_text += " (" + markdown_link("license file", "../" + entry["license_file"]) + ")"
        cells = [
            markdown_link(entry["name"], "../" + entry["path"]),
            markdown_text(summary(entry["description"])),
            markdown_link(entry["source"], entry["source"]) if entry["source"] else "not declared",
            license_text,
        ]
        lines.append("| " + " | ".join(cells) + " |")
    lines.extend([
        "",
        "目录与 CLI 共用读取逻辑，名称按字典序排列。JSON 的 `schema_version` 为 1；",
        "`--skill` 精确筛选，保留 `manifest_count`，只改变 `count`。未知名称和无效输入返回非零退出码。",
        "`--check` 只检查，不写文件；缺文件或内容漂移均失败。",
        "",
        "frontmatter 读取器只支持本仓库使用的 YAML 子集：块映射、标量列表、单行普通或引号标量，",
        "以及 `>` / `|` 块（可带 `+` / `-`）。双引号采用 JSON 转义。流式集合只支持空集合。",
        "锚点、别名、标签、多行普通或引号标量、显式缩进指标会失败。它不是通用 YAML 解析器。",
        "`name` 和 `description` 必须为非空字符串；重复字段和不安全路径会失败。",
        "",
    ])
    return "\n".join(lines)
