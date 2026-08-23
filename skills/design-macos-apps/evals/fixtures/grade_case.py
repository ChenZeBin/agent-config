#!/usr/bin/env python3
"""Deterministic rubric for the design-macos-apps behavioral evals."""

from __future__ import annotations

import os
import hashlib
import re
import subprocess
import sys
from pathlib import Path


def matches(text: str, *patterns: str) -> bool:
    return any(re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE) for pattern in patterns)


READONLY_HASHES: dict[str, dict[str, str]] = {
    "design-research-library-directions": {
        ".eval-case": "b9ca8283074e755b22f6c337bd4bd8ea0da7dbd3c081ac80cc23567a0229285f",
    },
    "review-evidence-gate-readonly": {
        ".eval-case": "bce79872303d50147a23b1751af98343be2ed30708a8f55b1c8b6d63b0817fb7",
        "evidence/screenshot-notes.md": "9962170e57e3e02dce915c754ef0546bda84d0c7d73fde8eddd1b2260b9a420e",
        "Sources/ReviewApp/MainView.swift": "db3e1a0f547fa9c7b2e730db0509969dd611a36def913595911e8fb47faab86e",
        "eval-original/MainView.swift": "db3e1a0f547fa9c7b2e730db0509969dd611a36def913595911e8fb47faab86e",
    },
    "translate-ios-figma-to-mac": {
        ".eval-case": "c92f61e9325188e260a482b9449c6f168066a7f43cc2b4f8c1e63673ce0fe670",
    },
    "boundary-electron-not-native-hig": {
        ".eval-case": "efaa7f2bfa1ab12af47fc85be47b2289fff4d62a9a3493a8e5e73030f57df382",
        "evidence/apple-contract.md": "e0443b9a1b29cc279c6382a419b34a3fb5d410717ea6dbdfdc450f0d2b6109ee",
    },
    "negative-pure-swift-debug": {
        ".eval-case": "3e45a737c94a54ff89447a522ebf6caec49ad60f766ddb3026ded8f13cd17892",
    },
    "design-liquid-glass-brand-boundary": {
        ".eval-case": "f1649f81b6a849efb270d7da7c8416a5d807b506618e7d5caccde1e9d87a889f",
        "brand/brief.md": "9c1772c8efb2c66c06bdf1229a27bc384ed155966b1c2945d3a58ff98ccdaed3",
    },
    "review-audit-false-positive-calibration": {
        ".eval-case": "902350e174565f77e6c5441b8ac466a9e5af7a5c875d01f018e9a38922bf33fe",
        "brand/brief.md": "a0e89e4797fd9a5df79679201e867c7eac43d9c590c46992d98987c16765d56c",
        "evidence/runtime.md": "93e1d2a3dd8934b740bf359e71f9bce3bf83b2e8bac0dcd397f06c41fbe0aa24",
        "Sources/AuditApp/MainView.swift": "0624adac5ad73a296eed46975e74c6e5c7cc17d482383b9388f484cba773db2c",
    },
    "design-menubar-permission-recovery": {
        ".eval-case": "e6be4b0fd041dc3184c4b845e086ea65c93765037b74d84bb40af62cbd16ae89",
        "ProductBrief.md": "e361a892499c4ff4ac0b394cc344b58202bc618cf26a3f8b28bf14c0128073b3",
    },
    "design-quick-export-placement": {
        ".eval-case": "3492ed05bcaee243dfea259b87b88c3ed0090f303d743cb6eac30c6199878abf",
        "evidence/product-brief.md": "f8b3a4bf7cf6dc89401a269f349cc4672ea6071eceb19f0354f18f8fac6df92c",
        "Sources/QuickLibrary/LibraryView.swift": "edbffca6a8baa729d330631e092b6705e55671204aa221e1891fab5b12d80221",
    },
    "review-build-evidence-boundary": {
        ".eval-case": "0fc990fc4e62ed7e3714b0786ee7d6eddc91f4c0ccc27f9051b7317dc392a8dc",
        "evidence/build.log": "58af85f6f8e7636084f3c5a3dcae9dd862656896266ca084016580b15e7bb5c5",
        "Sources/BoundaryApp/MainView.swift": "db59f4a72b2641219de12b5246d7c704b2922a9c956fee2e2054e09392a0c39d",
    },
    "design-apple-native-completion-gate": {
        ".eval-case": "705dd75bc5b72f95cb543d11b4ab7a6f42c70bad0daca53ed4f07488813efb9b",
    },
    "review-apple-native-fit-evidence": {
        ".eval-case": "6d3e99f477384590f4ea4a778cd77d93aa8c0590af8437657b9a59dcc2f08291",
        "evidence/reference-map.md": "c78464c1bf9cee91eca59a69ef8ade9ab3a6a9404644f35dfde92cd1ad89b678",
        "evidence/screenshot-manifest.md": "26af27da8754034920383df9de6442de3241ec84c7c7df92cd6603813093fd47",
        "evidence/interaction-notes.md": "fd227e7e0f427b22331ecfc87601dcdf3a3ef56e089aa0302e66cb3140cf60af",
        "evidence/build.log": "83578032bde852d98fb25f2e4f5b403576707883bbd85122f4979d36e226fd64",
    },
}


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def verify_readonly_workspace(case_id: str, workspace: Path) -> bool:
    configured = READONLY_HASHES.get(case_id)
    if configured is None:
        return True
    expected = dict(configured)
    frozen_contract = workspace / "evidence/apple-contract.md"
    if frozen_contract.exists():
        expected["evidence/apple-contract.md"] = "e0443b9a1b29cc279c6382a419b34a3fb5d410717ea6dbdfdc450f0d2b6109ee"

    actual_files: set[str] = set()
    for path in workspace.rglob("*"):
        if not path.is_file():
            continue
        relative = path.relative_to(workspace).as_posix()
        if relative.startswith((".skill-up/", ".codex/", ".git/", ".build/")):
            continue
        actual_files.add(relative)

    if actual_files != set(expected):
        print("ERROR: read-only case changed the workspace file set")
        print("ERROR: added=" + ", ".join(sorted(actual_files - set(expected))))
        print("ERROR: missing=" + ", ".join(sorted(set(expected) - actual_files)))
        return False

    for relative, digest in expected.items():
        path = workspace / relative
        if not path.exists() or sha256(path) != digest:
            print(f"ERROR: read-only fixture changed: {relative}")
            return False
    return True


def strip_swift_comments_and_strings(text: str) -> str:
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    text = re.sub(r"//[^\n]*", "", text)
    return re.sub(r'"(?:\\.|[^"\\])*"', '""', text)


def braced_body(text: str, opening_brace: int) -> str | None:
    depth = 0
    for index in range(opening_brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[opening_brace + 1 : index]
    return None


def nominal_body(code: str, kind: str, name: str) -> str | None:
    match = re.search(rf"\b{kind}\s+{re.escape(name)}\b[^{{]*\{{", code)
    if match is None:
        return None
    return braced_body(code, match.end() - 1)


def app_state_objects_avoid_window_selection(code: str) -> bool:
    app_match = re.search(r"@main\s+struct\s+(\w+)\s*:\s*App\b[^\{]*\{", code)
    if app_match is None:
        return False
    app_body = braced_body(code, app_match.end() - 1)
    if app_body is None:
        return False
    state_types = set(
        re.findall(
            r"@StateObject\s+(?:private\s+)?var\s+\w+(?:\s*:\s*(\w+)|\s*=\s*(\w+)\s*\()",
            app_body,
        )
    )
    for explicit_type, inferred_type in state_types:
        type_name = explicit_type or inferred_type
        body = nominal_body(code, r"(?:final\s+)?class", type_name)
        if body and re.search(r"\bvar\s+(?:selected\w*|selection\w*)\b", body, flags=re.IGNORECASE):
            return False
    return True


def has_window_local_selection(code: str) -> bool:
    for view_match in re.finditer(r"\bstruct\s+(\w+)\s*:\s*View\b[^\{]*\{", code):
        body = braced_body(code, view_match.end() - 1)
        if body is None:
            continue
        if re.search(
            r"@(?:State|SceneStorage)\b[^\n]*\bvar\s+(?:selected\w*|selection\w*)\b",
            body,
            flags=re.IGNORECASE,
        ):
            return True
        state_object_types = re.findall(
            r"@StateObject\s+(?:private\s+)?var\s+\w+(?:\s*:\s*(\w+)|\s*=\s*(\w+)\s*\()",
            body,
        )
        for explicit_type, inferred_type in state_object_types:
            type_name = explicit_type or inferred_type
            state_body = nominal_body(code, r"(?:final\s+)?class", type_name)
            if state_body and re.search(
                r"\bvar\s+(?:selected\w*|selection\w*)\b",
                state_body,
                flags=re.IGNORECASE,
            ):
                return True
    return False


def run_swift_build(workspace: Path) -> bool:
    build_environment = os.environ.copy()
    try:
        developer_dir = subprocess.run(
            ["xcode-select", "-p"],
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
        ).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        developer_dir = ""
    xcode_sdk = Path(developer_dir) / "Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk"
    if xcode_sdk.exists():
        build_environment["SDKROOT"] = str(xcode_sdk)
    build_environment["CLANG_MODULE_CACHE_PATH"] = str(workspace / ".build/ModuleCache")
    try:
        result = subprocess.run(
            ["swift", "build"],
            cwd=workspace,
            text=True,
            capture_output=True,
            timeout=90,
            check=False,
            env=build_environment,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        print(f"ERROR: swift build could not complete: {exc}")
        return False
    output = (result.stdout + "\n" + result.stderr).strip()
    if output:
        print("INFO: swift build tail:\n" + output[-2000:])
    if result.returncode != 0:
        print(f"ERROR: swift build exited {result.returncode}")
        return False
    return True


def reports_build_success(text: str) -> bool:
    return matches(
        text,
        r"swift build[\s\S]{0,240}(?:成功|通过|succeed(?:ed)?|pass(?:ed)?|exit(?: code)?\s*0|完成(?:编译|构建|链接)|产物生成)",
        r"(?:构建|编译|链接)[\s\S]{0,100}(?:成功|通过|succeed(?:ed)?|pass(?:ed)?|完成)",
    )


def require_groups(text: str, groups: list[tuple[str, tuple[str, ...]]], minimum: int) -> list[str]:
    passed: list[str] = []
    missing: list[str] = []
    for label, patterns in groups:
        if matches(text, *patterns):
            passed.append(label)
        else:
            missing.append(label)
    print(f"INFO: rubric groups {len(passed)}/{len(groups)}; required {minimum}")
    print("INFO: passed=" + ", ".join(passed))
    if len(passed) < minimum:
        print("ERROR: missing=" + ", ".join(missing))
        return missing
    if missing:
        print("WARN: optional missing=" + ", ".join(missing))
    return []


def reject_blanket_hig_claim(text: str) -> bool:
    patterns = (
        r"(?:完全|全面|百分之百|100\s*%).{0,25}(?:符合|遵循|通过|compliant).{0,20}(?:HIG|Human Interface Guidelines)",
        r"(?:已经|可以|可对外|能够).{0,25}(?:原生\s*)?(?:HIG|Human Interface Guidelines).{0,20}(?:合规|compliant)",
        r"(?:原生\s*)?(?:HIG|Human Interface Guidelines).{0,20}(?:完全)?(?:合规|compliant)",
    )
    negation = (
        r"不能|不应|不可|无法|不要|拒绝|不代表|不等于|并非|未必|"
        r"未验证|尚未验证|未知|证据不足|不足以支持|不作|不宣称|未.{0,12}宣称|"
        r"尚待.{0,20}(?:验证|核验)|需要.{0,30}(?:验证|核验|审查|评估)|"
        r"若?要(?:写|宣称)?.{0,40}(?:仍需|还需|需要|必须)|只有.{0,40}(?:才能|方可)|"
        r"(?:限于|限定|仅限于).{0,30}(?:范围|已验证|已审查)|not|cannot|can't|must not"
    )
    for pattern in patterns:
        for match in re.finditer(pattern, text, flags=re.IGNORECASE | re.MULTILINE):
            window = text[max(0, match.start() - 80) : min(len(text), match.end() + 120)]
            if not re.search(negation, window, flags=re.IGNORECASE):
                print("ERROR: output makes an unsupported blanket HIG-compliance claim")
                return False
    return True


def grade_design(text: str, workspace: Path) -> bool:
    groups = [
        (
            "模式与假设",
            (
                r"(?:设计|design).{0,20}(?:模式|mode)",
                r"假设|unknown|未知",
                r"(?:产品)?设计决策",
                r"(?:当前|现有).{0,30}(?:没有|无).{0,30}(?:代码|截图|运行)",
                r"设计提案|结论.{0,20}提案",
            ),
        ),
        (
            "实质不同的多个方向",
            (
                r"方向\s*[一二三123]|方案\s*[一二三123]",
                r"(?:方向|方案).{0,40}(?:方向|方案)",
                r"方向(?:比较|对比|取舍|选择)",
                r"(?:^|\n)\s*[-*]\s*\*{0,2}[ABC一二三123][.、：:\s「]",
                r"(?:阅读器|画布|卡片|表格|三栏|列表)[\s\S]{0,220}(?:却|但|而|取舍|替代)[\s\S]{0,220}(?:阅读器|画布|卡片|表格|三栏|列表)",
            ),
        ),
        ("推荐与取舍", (r"推荐|首选", r"取舍|trade-?off|拒绝|未选")),
        ("场景与窗口模型", (r"WindowGroup|DocumentGroup|Settings|MenuBarExtra", r"场景.{0,20}窗口|窗口.{0,20}状态")),
        ("信息架构与选择", (r"NavigationSplitView|sidebar|侧边栏|表格|Table|检查器|inspector",)),
        ("命令与桌面输入", (r"菜单|menu bar", r"工具栏|toolbar", r"键盘|快捷键|keyboard")),
        ("关键状态", (r"空状态|无数据", r"加载|loading", r"错误|离线|恢复")),
        ("无障碍与偏好", (r"VoiceOver|全键盘|Full Keyboard Access|Reduce Motion|减弱动态|Reduce Transparency|降低透明度",)),
        ("官方证据或明确未验证", (r"https://developer\.apple\.com/", r"未验证|unverified")),
        (
            "验证边界",
            (
                r"未运行|未渲染|没有运行|待验证|验证计划|manual check|人工检查",
                r"验证边界|发布前.{0,80}(?:验证|实测|检查)",
                r"运行(?:结果)?.{0,30}未验证",
                r"不能宣称.{0,30}(?:验收|合规)",
                r"验证等级.{0,30}(?:Proposed|提案)|未达到.{0,35}(?:accepted|验收)",
            ),
        ),
    ]
    ok = not require_groups(text, groups, 8)
    return ok and reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "design-research-library-directions", workspace
    )


def grade_review(text: str, workspace: Path) -> bool:
    if not verify_readonly_workspace("review-evidence-gate-readonly", workspace):
        return False
    groups = [
        ("证据覆盖与结论先行", (r"证据.{0,30}结论|结论.{0,30}证据|总体.{0,20}结论|(?:^|\n)结论\s*[：:]",)),
        ("观察与推断分开", (r"观察|observed|截图可见|已确认", r"推断|inferred|源码显示|需运行验证|待发布验证|不能.{0,30}断言")),
        ("严重度与状态", (r"严重度|blocker|high|medium|polish|高|中|低", r"confirmed|已确认|待运行验证|needs runtime")),
        ("证据定位", (r"MainView\.swift|screenshot-notes|截图",)),
        ("用户影响", (r"用户影响|影响|用户会", r"(?:点击|触发).{0,30}(?:不会|无结果|无反馈)|(?:无法|不能|不可).{0,30}(?:删除|发现|执行|完成)|删除不可发现")),
        ("最小修正", (r"最小修正|最小改动|smallest correction",)),
        ("验证方法与未知项", (r"验证|待验证|未知|无法确认",)),
        ("菜单键盘与辅助功能", (r"菜单|menu", r"键盘|快捷键|VoiceOver|全键盘")),
        ("官方来源或未验证", (r"https://developer\.apple\.com/", r"未验证|unverified|冻结(?:合约|证据)|离线证据|apple-contract")),
    ]
    ok = not require_groups(text, groups, 7)
    if not matches(text, r"最小(?:修正|改动|修复)|修复建议|建议(?:新增|实现|提供|将|把)|应(?:新增|实现|提供|将|把)"):
        print("ERROR: review findings do not include a concrete smallest correction")
        return False
    return ok and reject_blanket_hig_claim(text)


def grade_implement(text: str, workspace: Path) -> bool:
    source = workspace / "Sources/LibraryApp/LibraryApp.swift"
    package = workspace / "Package.swift"
    if not source.exists():
        print("ERROR: implementation source is missing")
        return False
    if not package.exists() or sha256(package) != "917b5d1318fdfa9228e8d2898773ff9595b24b6c22e242094df7f12613db1295":
        print("ERROR: Package.swift or the macOS 14 deployment target changed")
        return False
    code = strip_swift_comments_and_strings(source.read_text(encoding="utf-8"))
    checks = [
        ("保留原生窗口场景", matches(code, r"\bWindowGroup\b")),
        ("应用级共享状态不含窗口选择", app_state_objects_avoid_window_selection(code)),
        ("每窗口选择状态", has_window_local_selection(code)),
        ("菜单命令路径", matches(code, r"\.commands\s*\{") and matches(code, r"(?:CommandGroup|CommandMenu)\s*\(")),
        ("键盘发现路径", matches(code, r"keyboardShortcut|DeleteCommand|deleteBackward")),
        ("确认或撤销恢复", matches(code, r"confirmationDialog|\.alert\s*\(|undoManager|registerUndo|\brestore\w*|\bundo\w*")),
        ("移除假交通灯", not (matches(code, r"Circle\(\)\.fill\(\.red\)") and matches(code, r"Circle\(\)\.fill\(\.yellow\)") and matches(code, r"Circle\(\)\.fill\(\.green\)"))),
        ("没有 iOS 可用性守卫", not matches(code, r"#available\s*\(\s*iOS")),
        ("保留品牌强调", matches(code, r"\.tint\s*\(")),
        ("准确报告构建成功", reports_build_success(text)),
        ("诚实列出运行时缺口", matches(text, r"未执行|尚未|人工检查|运行时|VoiceOver|全键盘")),
    ]
    passed = [label for label, ok in checks if ok]
    missing = [label for label, ok in checks if not ok]
    print(f"INFO: implementation checks {len(passed)}/{len(checks)}; required {len(checks)}")
    print("INFO: passed=" + ", ".join(passed))
    if len(passed) < len(checks):
        print("ERROR: missing=" + ", ".join(missing))
        return False
    return run_swift_build(workspace)


def grade_translate(text: str, workspace: Path) -> bool:
    groups = [
        ("意图映射", (r"\|\s*(?:源|source|Figma\s*元素).{0,80}\|", r"源元素.{0,20}(?:意图|任务).{0,20}Mac", r"意图.{0,30}(?:→|->|映射)|(?:→|->).{0,30}Mac")),
        ("底部标签语义映射", (r"(?:底部|tab).{0,35}(?:侧边栏|sidebar|工具栏|窗口|菜单)",)),
        ("push 层级映射", (r"(?:push|逐屏).{0,35}(?:列表|详情|split|侧边栏|检查器|inspector)",)),
        ("sheet 与批量操作映射", (r"(?:底部\s*sheet|sheet).{0,45}(?:检查器|inspector|popover|弹出|工具栏|菜单|sheet)",)),
        ("滑动删除的替代路径", (r"(?:左滑|swipe).{0,45}(?:菜单|context|上下文|键盘|工具栏|inline|行内)",)),
        ("明确丢弃手机假设", (r"(?:丢弃|不沿用|移除|舍弃).{0,50}(?:44|safe area|安全区|触控|底部)", r"不逐像素|避免.{0,20}底部\s*(?:Tab|标签)|(?:44|safe area|安全区|触控).{0,40}(?:丢弃|避免|不固定|桌面硬规则)")),
        ("窗口与命令输入", (r"窗口|WindowGroup|DocumentGroup", r"菜单|工具栏|快捷键|键盘")),
        ("状态与无障碍", (r"空状态|加载|错误|离线|选择", r"VoiceOver|全键盘|Reduce Motion|减弱动态")),
        ("语义视觉映射", (r"语义.{0,20}(?:颜色|字体|符号|material|材质)|SF Symbols", r"系统(?:控件|文字|样式|颜色|层级)|(?:深浅色|Increased Contrast|Reduce Transparency).{0,50}(?:可读|层级|对比)", r"(?:安静|克制).{0,30}(?:可信|高可读|长期研究)")),
        ("API 可用性与降级", (r"可用性|availability|部署", r"fallback|降级|备用|移除.{0,30}(?:未验证|API)|标准控件")),
        ("Figma 只读边界", (r"(?:不|未)修改.{0,20}Figma|Figma.{0,20}(?:只读|不修改|未修改|不写入)",)),
    ]
    ok = not require_groups(text, groups, 9)
    return ok and reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "translate-ios-figma-to-mac", workspace
    )


def grade_boundary(text: str, workspace: Path) -> bool:
    groups = [
        ("明确非原生边界", (r"不是原生|非原生|Tauri|Electron", r"不能证明.{0,40}(?:AppKit|SwiftUI|原生)", r"(?:Web|桌面壳).{0,30}(?:实现|应用)")),
        ("拒绝 HIG 合规背书", (r"(?:不能|不应|无法|不可以).{0,30}(?:HIG|合规)", r"(?:HIG|合规).{0,30}(?:不能|不应|无法|不可以)")),
        ("Web 技术边界", (r"CSS|Tailwind|React|Web",)),
        ("ARIA 不等于原生辅助功能", (r"ARIA.{0,120}(?:不等于|不能|无法|Web|原生辅助|原生合规|native accessibility)",)),
        ("玻璃效果不是原生证据", (r"(?:backdrop-filter|玻璃|glass).{0,120}(?:不等于|不能|无法|不是|不构成|证据|原生)",)),
        ("允许按真实平台标准审查", (r"Web 可访问|桌面壳|平台边界|分别评估|可用性",)),
    ]
    ok = not require_groups(text, groups, 5)
    return ok and reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "boundary-electron-not-native-hig", workspace
    )


def grade_pure_swift(text: str, workspace: Path) -> bool:
    groups = [
        ("识别共享可变状态竞态", (r"竞态|data race|共享.{0,20}(?:可变|字典|状态)",)),
        ("并发隔离修复", (r"\bactor\b|锁|Mutex|串行|隔离",)),
        ("重复请求策略或原子性", (r"重复请求|同一 key|原子|in-?flight|任务缓存|二次检查",)),
        ("并发测试", (r"测试|TaskGroup|withTaskGroup|并发调用|Thread Sanitizer|TSan",)),
    ]
    if require_groups(text, groups, 3):
        return False
    off_topic = r"(?:^|\n)#{0,3}\s*(?:macOS|界面|窗口|视觉).{0,20}(?:设计|方案)|Liquid Glass|Figma"
    if matches(text, off_topic):
        print("ERROR: pure Swift debugging answer drifted into macOS UI design")
        return False
    return verify_readonly_workspace("negative-pure-swift-debug", workspace)


def grade_glass_brand(text: str, workspace: Path) -> bool:
    groups = [
        ("明确拒绝全内容玻璃", (r"拒绝|不应|不能|不建议", r"内容层.{0,40}(?:不|避免).{0,20}(?:玻璃|Liquid Glass)")),
        ("区分内容与功能层", (r"内容层", r"功能.{0,12}层|控制.{0,12}层")),
        ("区分瞬时层", (r"瞬时|临时|popover|sheet|菜单",)),
        ("保留深绿的语义角色", (r"深.{0,4}绿.{0,50}(?:专注|同步|语义|状态|有限)",)),
        ("系统控件优先", (r"系统.{0,20}(?:控件|材质|语义)|原生.{0,20}控件|SwiftUI.{0,20}控件|standard controls|system material",)),
        ("透明度偏好", (r"Reduce Transparency|降低透明度|减少透明度",)),
        ("对比度与外观", (r"Increased Contrast|提高对比度|高对比度", r"light|dark|浅色|深色")),
        ("证据或未验证", (r"https://developer\.apple\.com/|未验证|unverified",)),
        ("非玻璃功能降级", (r"fallback|降级|备用.{0,20}(?:系统|语义|不透明)|不依赖.{0,15}玻璃",)),
    ]
    if require_groups(text, groups, 8):
        return False
    if not matches(text, r"拒绝|不应|不能|不建议"):
        print("ERROR: output did not reject or narrow the all-glass demand")
        return False
    return reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "design-liquid-glass-brand-boundary", workspace
    )


def grade_api_fallback(text: str, workspace: Path) -> bool:
    source = workspace / "Sources/GlassNotes/GlassNotes.swift"
    package = workspace / "Package.swift"
    if not source.exists() or not package.exists():
        print("ERROR: implementation files are missing")
        return False
    if sha256(package) != "0b3b4dd7b513a4fc3e9316d703292160efe062d74f62ae1feb1303ff94c53b34":
        print("ERROR: Package.swift or the macOS 14 deployment target changed")
        return False
    code = strip_swift_comments_and_strings(source.read_text(encoding="utf-8"))
    checks = [
        ("移除 iOS guard", not matches(code, r"#available\s*\(\s*iOS")),
        ("保留 NavigationSplitView", matches(code, r"NavigationSplitView")),
        ("保留可用按钮功能", matches(code, r"Button\s*\(")),
        ("没有不必要 AppKit", not matches(code, r"import\s+AppKit|NSViewRepresentable|NSViewControllerRepresentable")),
        ("语义色仍在", matches(code, r"\.tint\s*\(")),
        (
            "glass API 有 Mac guard 与 fallback 或被移除",
            not matches(code, r"glassEffect\s*\(")
            or (
                matches(code, r"#available\s*\(\s*macOS")
                and matches(code, r"\}\s*else\s*\{")
            ),
        ),
        ("准确报告构建成功", reports_build_success(text)),
        ("报告运行态缺口", matches(text, r"未执行|尚未|运行时|人工检查|VoiceOver|外观|仍需.{0,60}(?:确认|验证)|实际\s*App.{0,30}确认")),
        (
            "来源或未验证",
            matches(
                text,
                r"https://developer\.apple\.com/|未验证|unverified|无法核实|未核实|证据包|apple-contract|冻结.{0,12}(?:Apple|苹果).{0,12}证据",
            ),
        ),
    ]
    missing = [label for label, ok in checks if not ok]
    print(f"INFO: API fallback checks {len(checks) - len(missing)}/{len(checks)}")
    if missing:
        print("ERROR: missing=" + ", ".join(missing))
        return False
    return run_swift_build(workspace)


def grade_false_positive_review(text: str, workspace: Path) -> bool:
    if not verify_readonly_workspace("review-audit-false-positive-calibration", workspace):
        return False
    groups = [
        ("A 不是固定 44pt 平台缺陷", (r"A.{0,100}(?:不成立|非缺陷|不是.{0,20}规则|不应.{0,20}缺陷|建议)", r"44\s*(?:pt|点).{0,100}(?:不成立|非.{0,20}规则|不是.{0,20}要求|建议)")),
        ("B 遵循品牌语义", (r"B.{0,100}(?:不成立|非缺陷|系统语义|品牌.{0,20}同步)", r"深绿色.{0,100}(?:不要求|已同步|系统语义|非缺陷)")),
        ("C 已有菜单与快捷键", (r"C.{0,120}(?:不成立|已有|Edit\s*>\s*Delete|Command-Delete|⌘)", r"runtime\.md.{0,120}(?:Delete|快捷键|菜单)")),
        ("证据定位", (r"runtime\.md", r"MainView\.swift", r"brand/brief\.md|品牌规则")),
        ("分离证据等级", (r"confirmed|已确认|source-confirmed|源码确认", r"inferred|推断|suggestion|建议", r"unknown|未知|待验证")),
        ("保留真实未知项", (r"VoiceOver|Full Keyboard Access|全键盘", r"窄窗口|多选")),
    ]
    if require_groups(text, groups, 6):
        return False
    no_confirmed_finding = matches(
        text,
        r"(?:没有|无).{0,40}(?:确认|已证实|confirmed).{0,40}(?:finding|问题|缺陷)",
        r"confirmed\s*(?:\n|[:：])\s*无",
    )
    has_verification = matches(text, r"发布前|复测|验证方法|待验证|如何验证|回归|手测|录制|(?:验证|验收)\s*[：:]|补录")
    has_smallest_correction = matches(
        text,
        r"最小修正|最小改动|无需修正|最小验证|最小动作|修复建议",
    )
    if not has_verification or (not no_confirmed_finding and not has_smallest_correction):
        print("ERROR: review needs verification and, for a real finding, a smallest correction")
        return False
    return reject_blanket_hig_claim(text)


def grade_menubar(text: str, workspace: Path) -> bool:
    groups = [
        ("MenuBarExtra 角色", (r"MenuBarExtra",)),
        ("主窗口与 Settings 分工", (r"主窗口|历史窗口|WindowGroup", r"Settings|设置窗口")),
        ("用户动作时请求权限", (r"用户.{0,20}(?:点击|发起|开始).{0,30}(?:请求|麦克风权限)|首次录音.{0,30}请求", r"开始录音.{0,20}(?:唯一|才|时).{0,25}(?:请求|麦克风权限)")),
        ("拒绝自动打开系统设置", (r"不.{0,20}自动.{0,20}(?:系统设置|权限设置)|显式.{0,20}(?:按钮|操作).{0,30}系统设置", r"自动打开系统设置.{0,100}(?:缺少|夺走|不建议|仅在用户点击|用户控制)", r"(?:系统设置|权限设置).{0,50}(?:用户触发|由用户触发|用户点击|不自动)")),
        ("关闭 popover 不终止录音", (r"关闭.{0,20}(?:popover|弹窗).{0,100}(?:录音持续|持续显示|只隐藏|只关闭界面|停止必须|不.{0,20}(?:停止|终止)|不改变)", r"(?:popover|弹窗).{0,20}关闭.{0,60}(?:录音继续|不.{0,20}(?:停止|终止)|只关闭界面)", r"(?:popover|弹窗).{0,20}关闭.{0,50}(?:不改变|独立于).{0,30}(?:录音|任务).{0,15}生命周期")),
        ("权限拒绝或撤销恢复", (r"拒绝|撤销权限|permission denied", r"引导|重试|重新授权")),
        ("磁盘失败恢复", (r"(?:磁盘|空间).{0,30}(?:不足|失败).{0,80}(?:保留|恢复|重试|另存|清理|释放空间|更换位置)",)),
        ("离线与设备丢失", (r"离线|转写服务", r"拔出|设备丢失|麦克风断开|USB")),
        ("重启或崩溃恢复", (r"重启|崩溃|重新打开|启动.{0,30}恢复|恢复.{0,20}(?:录音|临时文件|未完成)",)),
        ("Dock 策略是产品决策", (r"Dock.{0,80}(?:产品决策|可选|权衡|不应|不能|显示|隐藏|未验证|实测)", r"(?:显示|隐藏)\s*Dock.{0,80}(?:采用|未验证|实测|权衡)")),
        ("键盘与 VoiceOver", (r"键盘|快捷键", r"VoiceOver")),
        ("显示偏好", (r"Reduce Motion|减弱动态", r"Reduce Transparency|降低透明度")),
        ("运行验证边界", (r"待验证|未验证|未运行|运行时|发布前.{0,40}(?:实机|验证|核实)|权限流程.{0,20}测试|设备变化.{0,20}测试",)),
    ]
    if require_groups(text, groups, 11):
        return False
    return reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "design-menubar-permission-recovery", workspace
    )


def grade_quick_export(text: str, workspace: Path) -> bool:
    if not verify_readonly_workspace("design-quick-export-placement", workspace):
        return False
    groups = [
        ("结论先行", (r"(?:建议|结论|决定).{0,80}(?:Export|导出)", r"(?:Export|导出).{0,80}(?:移出|不再|保留|放在)")),
        ("菜单发现路径", (r"File\s*>\s*Export|文件.{0,20}导出|File.{0,20}Export",)),
        ("工具栏频率取舍", (r"(?:低频|每周).{0,60}(?:默认工具栏|工具栏)|(?:默认工具栏|工具栏).{0,60}(?:低频|每周)",)),
        ("活动窗口选择范围", (r"(?:当前|活动|active).{0,25}(?:窗口|window).{0,45}(?:选择|selection|选中)",)),
        ("禁用条件", (r"(?:无|没有|为空).{0,20}(?:选择|selection|选中).{0,30}(?:禁用|disabled)", r"(?:禁用|disabled).{0,30}(?:无|没有|为空).{0,20}(?:选择|selection|选中)", r"(?:选择|selection|选中).{0,25}(?:为空|empty).{0,40}(?:禁用|disabled)")),
        ("进行中与失败恢复", (r"进度|进行中|progress", r"失败|destination|目标不可用", r"重试|取消|retry|cancel")),
        ("最小验证", (r"验证|检查", r"菜单|禁用|窗口|失败")),
        ("证据边界", (r"未运行|没有运行|源码|产品简报|现有证据|待运行验证",)),
    ]
    if require_groups(text, groups, 7):
        return False
    if len(text) > 5000:
        print(f"ERROR: quick decision is too long ({len(text)} characters)")
        return False
    if matches(text, r"##\s*(?:1\.?\s*)?(?:Context and assumptions|背景与假设)"):
        print("ERROR: bounded quick decision expanded into a full specification")
        return False
    return reject_blanket_hig_claim(text)


def grade_build_evidence_boundary(text: str, workspace: Path) -> bool:
    if not verify_readonly_workspace("review-build-evidence-boundary", workspace):
        return False
    groups = [
        ("拒绝发布过度声明", (r"不能发布|不应发布|不可发布|不能这样写|不成立|不支持",)),
        ("实际证据定位", (r"build\.log|MainView\.swift",)),
        ("构建证据范围", (r"(?:build|构建|编译).{0,50}(?:只|仅).{0,40}(?:编译|构建|通过|成功)", r"(?:只|仅).{0,40}(?:证明|说明).{0,60}(?:build|编译|构建)", r"(?:现有|当前)证据(?:只|仅)证明[\s\S]{0,120}(?:build|编译|构建)", r"(?:最高)?证据级别.{0,40}(?:build|构建).{0,40}(?:不足|不等于|不能)", r"build\.log[\s\S]{0,160}构建成功[\s\S]{0,160}仍无法证明", r"已完成.{0,30}(?:build|构建)[\s\S]{0,140}(?:UI|界面|视觉)[\s\S]{0,100}(?:尚待|未验证)")),
        ("视觉仍未知", (r"(?:视觉|界面|UI|渲染).{0,50}(?:未验证|未知|没有|不能证明|尚待.{0,10}验证)", r"(?:不证明|不能证明|仍无法证明)[\s\S]{0,200}(?:视觉|界面|UI|渲染|实际窗口|App 能启动)", r"(?:未启动|未渲染|没有截图)", r"仍未知[\s\S]{0,180}(?:视觉|界面|UI|渲染)")),
        ("键盘交互仍未知", (r"(?:键盘|菜单|快捷键|焦点).{0,80}(?:未验证|未知|没有|不能证明|尚待.{0,10}验证)", r"(?:不证明|不能证明|仍无法证明)[\s\S]{0,320}(?:键盘|菜单|快捷键|焦点)", r"仍未知[\s\S]{0,260}(?:键盘|菜单|快捷键|焦点)")),
        ("VoiceOver 仍未知", (r"VoiceOver.{0,70}(?:未验证|未知|没有|不能证明|尚待.{0,10}验证)", r"(?:不证明|不能证明|仍无法证明)[\s\S]{0,380}VoiceOver", r"仍未知[\s\S]{0,360}VoiceOver")),
        ("最小运行验证", (r"启动|launch|运行 app", r"菜单|快捷键|焦点", r"VoiceOver|全键盘")),
        ("分层完成状态", (r"build-verified|构建已验证|build only|仅构建|(?:现有|当前)证据(?:只|仅)证明.{0,60}(?:build|构建|编译)|已完成.{0,25}(?:build|构建)", r"runtime pending|运行时待验证|仍需运行|仍未知|尚待运行验证|不证明")),
    ]
    if not (matches(text, r"build\.log") and matches(text, r"MainView\.swift")):
        print("ERROR: response did not cite both inspected evidence paths")
        return False
    if require_groups(text, groups, 7):
        return False
    if len(text) > 4500:
        print(f"ERROR: focused release judgment is too long ({len(text)} characters)")
        return False
    return reject_blanket_hig_claim(text)


def grade_apple_native_completion_gate(text: str, workspace: Path) -> bool:
    groups = [
        (
            "具体 Apple 参照原型",
            (
                r"Finder|Mail|Notes|Preview|Photos|System Settings|Numbers|Music|QuickTime|Reminders|Calendar|Freeform|访达|邮件|备忘录|预览|照片|系统设置|数字表格|音乐|快速时间|提醒事项|日历|无边记",
            ),
        ),
        ("采用映射", (r"adopt|采用|借用|沿用",)),
        ("适配映射", (r"adapt|适配|调整|改写|改造",)),
        ("避免复制", (r"avoid|不复制|避免|不照搬|拒绝",)),
        (
            "三种窗口宽度",
            (
                r"(?:最小|最低可用|minimum(?: usable)?)[\s\S]{0,800}(?:默认|default)[\s\S]{0,800}(?:宽|宽屏|wide)",
            ),
        ),
        ("明暗外观", (r"(?:浅色|light)[\s\S]{0,300}(?:深色|dark)|深浅色",)),
        ("活动与非活动", (r"活动.{0,12}非活动|active.{0,12}inactive|非活动|非活跃|inactive",)),
        (
            "真实运行证据边界",
            (
                r"(?:Figma|Preview|预览|生成.{0,8}(?:图|mockup)).{0,50}(?:不能|不等于|不可|不算).{0,30}(?:运行|截图|证据)",
                r"实际启动|真实启动|launched target|actual launched.{0,12}\.app|no runnable target|真实 app|实际 app|实际.{0,12}\.app|实际.{0,18}目标程序|真实.{0,18}目标程序|无.{0,24}可(?:运行|启动)目标",
            ),
        ),
        (
            "交互记录结构",
            (
                r"(?:路径|命令|path).{0,20}(?:输入|input).{0,20}(?:预期|expected).{0,20}(?:观察|实际|observed).{0,20}(?:证据|evidence).{0,20}(?:状态|status)",
            ),
        ),
        (
            "命令键盘焦点",
            (r"菜单.{0,30}工具栏|menu.{0,30}toolbar", r"键盘.{0,30}焦点|keyboard.{0,30}focus"),
        ),
        (
            "窗口恢复与撤销",
            (r"缩放|resize", r"恢复|restoration", r"撤销|Undo|recovery"),
        ),
        (
            "明确未完成",
            (
                r"不能.{0,45}(?:Apple 原生感|原生感).{0,35}(?:已验证|验收|发布)",
                r"(?:Apple 原生感|原生感).{0,35}(?:尚未|未完成|不能).{0,30}(?:验证|验收|发布)",
                r"最高.{0,20}(?:Proposed|提案|设计推理)|待运行|pending|runtime blocked",
            ),
        ),
    ]
    # Every group is part of this acceptance gate; unlike broader design rubrics,
    # none of these artifacts is optional or substitutable.
    if require_groups(text, groups, len(groups)):
        return False
    if len(text) > 6000:
        print(f"ERROR: Apple-native design gate response is too long ({len(text)} characters)")
        return False
    return reject_blanket_hig_claim(text) and verify_readonly_workspace(
        "design-apple-native-completion-gate", workspace
    )


def grade_apple_native_fit_review(text: str, workspace: Path) -> bool:
    if not verify_readonly_workspace("review-apple-native-fit-evidence", workspace):
        return False
    required_paths = (
        "reference-map.md",
        "screenshot-manifest.md",
        "interaction-notes.md",
        "build.log",
    )
    missing_paths = [path for path in required_paths if path not in text]
    if missing_paths:
        print("ERROR: review omitted evidence paths=" + ", ".join(missing_paths))
        return False
    groups = [
        ("拒绝发布验收", (r"不能批准|不批准|不可批准|不能发布|不应发布|证据不足",)),
        (
            "参照原型缺口",
            (
                r"(?:版本|日期|来源).{0,80}(?:缺|没有|未记录)",
                r"(?:缺|没有|未记录).{0,80}(?:版本|日期|来源)",
                r"adopt.{0,20}adapt.{0,20}avoid",
                r"采用.{0,20}适配.{0,20}(?:避免|不复制)",
            ),
        ),
        ("截图文件缺失", (r"PNG.{0,40}(?:未.{0,8}提供|不存在|缺失)|清单.{0,40}(?:不等于|不能证明).{0,25}截图",)),
        ("缺少窄与宽", (r"最小|窄", r"wide|宽")),
        ("缺少非活动窗口", (r"非活动|inactive",)),
        ("截图元数据缺口", (r"build.{0,30}(?:标识|版本)|macOS.{0,25}版本|显示缩放|数据状态|窗口尺寸",)),
        ("菜单键盘焦点缺口", (r"菜单|menu", r"快捷键|键盘|keyboard", r"焦点|focus")),
        ("缩放恢复撤销缺口", (r"缩放|resize", r"恢复|restoration", r"Undo|撤销")),
        ("构建边界", (r"build-verified|仅.{0,12}(?:构建|build)|构建.{0,40}(?:不能|不证明|不足)|build\.log.{0,60}(?:只|仅).{0,30}(?:构建|build)|L3.{0,25}构建验证",)),
        ("三类交付物逐项状态", (r"参照[\s\S]{0,500}截图[\s\S]{0,500}交互|reference[\s\S]{0,500}screenshot[\s\S]{0,500}interaction",)),
        ("最小下一轮验证", (r"最小.{0,25}(?:下一轮|验证|补齐)|下一轮.{0,25}(?:运行|验证)",)),
        ("未通过原生感完成门", (r"Apple-native fit.{0,35}(?:未通过|不能|pending)|原生感.{0,50}(?:未通过|不能验收|尚未验收|待完成|待运行验证)|(?:不能|不足以).{0,40}(?:Apple 原生感|原生感).{0,35}(?:验收|已验收)",)),
    ]
    if require_groups(text, groups, 11):
        return False
    if len(text) > 5000:
        print(f"ERROR: Apple-native evidence review is too long ({len(text)} characters)")
        return False
    return reject_blanket_hig_claim(text)


def main() -> int:
    workspace = Path.cwd()
    marker = workspace / ".eval-case"
    if not marker.exists():
        print("ERROR: missing .eval-case marker")
        return 1
    case_id = marker.read_text(encoding="utf-8").strip()
    text = os.environ.get("EVAL_FINAL_MESSAGE", "")
    if not text.strip():
        print("ERROR: EVAL_FINAL_MESSAGE is empty")
        return 1

    graders = {
        "design-research-library-directions": lambda: grade_design(text, workspace),
        "review-evidence-gate-readonly": lambda: grade_review(text, workspace),
        "implement-window-scoped-commands": lambda: grade_implement(text, workspace),
        "translate-ios-figma-to-mac": lambda: grade_translate(text, workspace),
        "boundary-electron-not-native-hig": lambda: grade_boundary(text, workspace),
        "negative-pure-swift-debug": lambda: grade_pure_swift(text, workspace),
        "design-liquid-glass-brand-boundary": lambda: grade_glass_brand(text, workspace),
        "implement-api-availability-fallback": lambda: grade_api_fallback(text, workspace),
        "review-audit-false-positive-calibration": lambda: grade_false_positive_review(text, workspace),
        "design-menubar-permission-recovery": lambda: grade_menubar(text, workspace),
        "design-quick-export-placement": lambda: grade_quick_export(text, workspace),
        "review-build-evidence-boundary": lambda: grade_build_evidence_boundary(text, workspace),
        "design-apple-native-completion-gate": lambda: grade_apple_native_completion_gate(text, workspace),
        "review-apple-native-fit-evidence": lambda: grade_apple_native_fit_review(text, workspace),
    }
    grader = graders.get(case_id)
    if grader is None:
        print(f"ERROR: unknown case id {case_id}")
        return 1
    print(f"INFO: grading {case_id}")
    return 0 if grader() else 1


if __name__ == "__main__":
    raise SystemExit(main())
