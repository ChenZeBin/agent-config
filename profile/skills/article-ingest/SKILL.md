---
name: article-ingest
description: 将支持的文章和视频链接路由到独立 link-archive；只有用户明确指定现有 Wiki 时才使用该项目的知识编译流程。
---

# Article Ingest

全局链接采集已独立为 [link-archive](../link-archive/SKILL.md)。用户要求抓取、保存或归档支持的链接时，使用该 Skill，不查找旧 my-wiki 项目。采集器、校验器、请求去重均随工具分发。

只有用户明确指定某个仍存在的 Wiki 仓库并要求知识入库时，才遵循该仓库的 AGENTS.md 与项目级 article-ingest Skill。缺少目标仓库时，归档不等于完整炼化，不自动创建知识库或寻找已删除的项目。
