---
name: my-wiki-link
description: 旧 my-wiki-link 命令的兼容入口，委托独立 link-archive 采集工具，不再依赖 my-wiki 项目。
---

# 兼容链接入口

使用 [link-archive](../link-archive/SKILL.md) 的独立归档流程。旧 `my-wiki-link` 命令兼容 `doctor`、`classify`、`capture`、`verify`；`--repo` 是 `--output` 的别名，不扫描或定位旧项目。

`queue scan` 属于已移除的 Wiki 编译流程，不再提供；不能把 capture 称为完整炼化。安装或修复全局命令运行 `node ../link-archive/scripts/install.mjs`。仅判断支持范围时用 `my-wiki-link classify 'URL' --json`，不得提前采集。
