#!/usr/bin/env python3
"""Lint the structure and evidence hygiene of a macOS design specification.

This tool cannot judge visual quality, runtime behavior, accessibility, or HIG
compliance. It only catches incomplete templates and common evidence mistakes.
"""

from __future__ import annotations

import argparse
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path


REQUIRED_HEADINGS = (
    ("context and assumptions", (("context", "assumption"), ("背景", "假设"), ("上下文", "假设"))),
    ("product intent", (("product", "intent"), ("design", "thesis"), ("产品", "意图"), ("设计", "主张"))),
    ("Apple reference prototype", (("apple", "reference", "prototype"), ("apple", "参照", "原型"), ("苹果", "参照", "原型"))),
    ("platform contract", (("platform", "contract"), ("平台", "契约"))),
    ("scene and window model", (("scene", "window"), ("window", "model"), ("场景", "窗口"), ("窗口", "模型"))),
    ("information architecture", (("information", "architecture"), ("信息", "架构"))),
    ("commands and input", (("command", "input"), ("命令", "输入"))),
    ("surface specifications", (("surface", "specification"), ("界面", "规格"), ("表面", "规格"))),
    ("visual system", (("visual", "system"), ("视觉", "系统"))),
    ("motion and feedback", (("motion", "feedback"), ("动效", "反馈"), ("动画", "反馈"))),
    ("accessibility and localization", (("accessibility", "localization"), ("无障碍", "本地化"), ("辅助功能", "本地化"))),
    ("SwiftUI/AppKit mapping", (("swiftui", "appkit", "mapping"), ("swiftui", "appkit", "映射"), ("swiftui", "映射"))),
    ("states and edge cases", (("state", "edge"), ("状态", "边界"), ("状态", "边缘"))),
    ("runtime screenshot matrix", (("runtime", "screenshot", "matrix"), ("运行", "截图", "矩阵"), ("运行时", "截图", "矩阵"))),
    ("interaction verification record", (("interaction", "verification", "record"), ("交互", "验证", "记录"), ("交互", "验收", "记录"))),
    ("verification plan", (("verification",), ("验证", "计划"))),
    ("sources and open risks", (("source", "risk"), ("来源", "风险"))),
)

WEB_ONLY_PATTERNS = (
    (r"\bTailwind\b", "Tailwind is Web implementation, not native macOS guidance"),
    (r"\bFramer Motion\b", "Framer Motion is Web implementation, not native macOS guidance"),
    (r"\bbackdrop-filter\b", "CSS backdrop-filter is not native Liquid Glass evidence"),
    (r"\baria-[a-z-]+\b", "ARIA attributes must be translated to native accessibility behavior"),
    (r"\brequestAnimationFrame\b", "requestAnimationFrame is a browser API"),
)

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
UNRESOLVED_RE = re.compile(
    r"\b(?:TODO|TBD|FIXME)\b|lorem\s+ipsum|待定|待补|占位|稍后补充",
    flags=re.IGNORECASE,
)


@dataclass(frozen=True)
class Heading:
    level: int
    text: str
    line_index: int


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Lint a macOS design specification for structure and evidence hygiene."
    )
    parser.add_argument("spec", type=Path, help="Markdown specification to validate")
    parser.add_argument(
        "--strict", action="store_true", help="Treat warnings as validation failures"
    )
    parser.add_argument(
        "--template",
        action="store_true",
        help="Validate a blank template's structure without requiring completed content",
    )
    return parser.parse_args()


def normalize_heading(value: str) -> str:
    heading = unicodedata.normalize("NFKC", value).casefold()
    heading = re.sub(r"[`*_]", "", heading)
    heading = re.sub(r"^[\d一二三四五六七八九十百]+(?:\.[\d]+)*[.)、．]?\s*", "", heading)
    heading = re.sub(r"[\s/_:：—–-]+", " ", heading)
    return heading.strip()


def parse_headings(lines: list[str]) -> list[Heading]:
    headings: list[Heading] = []
    for index, line in enumerate(lines):
        match = HEADING_RE.match(line)
        if match:
            headings.append(
                Heading(len(match.group(1)), normalize_heading(match.group(2)), index)
            )
    return headings


def heading_matches(heading: str, alternatives: tuple[tuple[str, ...], ...]) -> bool:
    return any(all(token.casefold() in heading for token in tokens) for tokens in alternatives)


def find_heading(
    headings: list[Heading], alternatives: tuple[tuple[str, ...], ...]
) -> tuple[int, Heading] | None:
    for index, heading in enumerate(headings):
        if heading_matches(heading.text, alternatives):
            return index, heading
    return None


def section_body(lines: list[str], headings: list[Heading], heading_index: int) -> str:
    heading = headings[heading_index]
    end = len(lines)
    for later in headings[heading_index + 1 :]:
        if later.level <= heading.level:
            end = later.line_index
            break
    return "\n".join(lines[heading.line_index + 1 : end])


def placeholders(text: str) -> list[str]:
    found: list[str] = []
    for match in re.finditer(r"\[([^\]\n]{1,120})\](?!\s*\()", text):
        value = match.group(1).strip()
        if value in {"", "x", "X"} or value.isdigit():
            continue
        found.append(value)
    return found


def meaningful_length(text: str) -> int:
    text = re.sub(r"\[([^\]\n]{1,120})\](?!\s*\()", "", text)
    text = re.sub(r"^#{1,6}\s+.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^\s*\|?\s*:?-{3,}:?.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"[`*_#>|-]", "", text)
    return len(re.sub(r"[^\w\u3400-\u9fff]+", "", text, flags=re.UNICODE))


def validate(path: Path, template: bool) -> tuple[list[str], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    notes: list[str] = []

    if not path.exists():
        return [f"File does not exist: {path}"], warnings, notes
    if not path.is_file():
        return [f"Not a file: {path}"], warnings, notes
    if path.suffix.lower() not in {".md", ".markdown"}:
        warnings.append("Specification does not use a Markdown extension")

    text = path.read_text(encoding="utf-8")
    if not text.strip():
        return ["Specification is empty"], warnings, notes

    lines = text.splitlines()
    headings = parse_headings(lines)
    matched_sections = 0
    for label, alternatives in REQUIRED_HEADINGS:
        found = find_heading(headings, alternatives)
        if found is None:
            errors.append(f"Missing required section: {label}")
            continue
        matched_sections += 1
        if not template:
            heading_index, _ = found
            body = section_body(lines, headings, heading_index)
            if meaningful_length(body) < 24:
                errors.append(f"Required section lacks substantive content: {label}")

    if not template:
        unresolved_placeholders = placeholders(text)
        if unresolved_placeholders:
            sample = ", ".join(unresolved_placeholders[:5])
            suffix = " …" if len(unresolved_placeholders) > 5 else ""
            errors.append(f"Unfilled bracket placeholders remain: {sample}{suffix}")

        unresolved = sorted(set(match.group(0) for match in UNRESOLVED_RE.finditer(text)))
        if unresolved:
            errors.append("Unresolved filler remains: " + ", ".join(unresolved[:8]))

        if len(text.strip()) < 1200:
            warnings.append("Specification is unusually short for the full decision record")

        has_apple_source = "https://developer.apple.com/" in text
        explicitly_unverified = bool(re.search(r"\bunverified\b|未验证", text, re.IGNORECASE))
        if not has_apple_source and not explicitly_unverified:
            errors.append(
                "No first-party Apple source URL or explicit unverified-source status was found"
            )
        if has_apple_source and not re.search(r"\b20\d{2}-\d{2}-\d{2}\b", text):
            errors.append("Apple source is present but no retrieval date was found")

        if re.search(r"\bHIG[- ]compliant\b|\bcomplies with (?:the )?HIG\b", text, re.IGNORECASE):
            if not has_apple_source:
                errors.append("HIG-compliance claim lacks a current first-party Apple source")
            warnings.append(
                "Prefer narrow, evidence-backed conclusions over a blanket HIG-compliance claim"
            )

        lower = text.casefold()
        mentions_glass = "liquid glass" in lower or "glasseffect" in lower
        rejects_glass = bool(re.search(r"(?:not used|do not use|不使用|无需).{0,30}(?:liquid glass|glasseffect)|(?:liquid glass|glasseffect).{0,30}(?:not used|do not use|不使用|无需)", lower))
        if mentions_glass and not rejects_glass:
            if "availability" not in lower and "deployment" not in lower and "可用性" not in text and "部署" not in text:
                errors.append("Liquid Glass is mentioned without availability/deployment treatment")
            if "fallback" not in lower and "降级" not in text and "回退" not in text:
                errors.append("Liquid Glass is mentioned without a functional fallback")

        if re.search(r"#available\s*\(\s*ios\b", text, re.IGNORECASE):
            warnings.append("An iOS availability guard appears in a macOS design specification")

        if re.search(r"fake\s+traffic\s+lights?|simulated\s+traffic\s+lights?", text, re.IGNORECASE):
            warnings.append("Custom/fake traffic-light language requires removal or explicit rejection")

        for pattern, message in WEB_ONLY_PATTERNS:
            if re.search(pattern, text, re.IGNORECASE):
                warnings.append(message)

    notes.append(f"Found {len(headings)} Markdown headings")
    notes.append(f"Matched {matched_sections}/{len(REQUIRED_HEADINGS)} required section groups")
    notes.append("This result is structural/evidence lint, not design-quality or HIG certification")
    return errors, warnings, notes


def main() -> int:
    args = parse_args()
    errors, warnings, notes = validate(args.spec, args.template)

    for note in notes:
        print(f"INFO: {note}")
    for warning in warnings:
        print(f"WARN: {warning}")
    for error in errors:
        print(f"ERROR: {error}")

    failed = bool(errors or (args.strict and warnings))
    if failed:
        print(f"FAIL: {len(errors)} error(s), {len(warnings)} warning(s)", file=sys.stderr)
        return 1

    print(f"PASS: {len(warnings)} warning(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
