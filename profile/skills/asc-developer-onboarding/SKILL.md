---
name: asc-developer-onboarding
description: 使用 asc 安全处理 Apple Developer Program 组织团队的成员邀请与测试设备注册；适用于新员工入组、UDID 登记、重复核对、邀请/注册状态验证，以及设计内部自助入口。不是 Apple Account 创建、TestFlight 测试者管理或 Enterprise Program 写入工具。
---

# Apple 开发者团队入组

把团队成员邀请和测试设备注册当作两项独立的外部写入。先确认计划类型、目标团队和现状，再分别执行、验证和报告；一项成功不能代表另一项成功。

## 路由

1. 先确定会员类型：Apple Developer Program 组织、个人，或 Apple Developer Enterprise Program。信息不足且会改变写入端点时，先问清，不试探写入。
2. 标准组织账号走本 Skill 的 `asc` 流程。执行前阅读 [标准流程与命令](references/commands.md)。
3. 个人账号可邀请 App Store Connect 用户，但被邀请者不是 Developer Program 团队成员。设备注册由 Account Holder 的团队凭据集中处理。
4. Enterprise Program 使用独立的 Enterprise Program API、`https://api.enterprise.developer.apple.com` 域名和密钥。只做诊断与交接，阅读 [计划类型与能力边界](references/program-routing.md)，不得拿 App Store Connect 凭据尝试 Enterprise 写入。
5. App Store Connect API 和 `asc` 不能直接创建 Apple Account。“创建 Apple Account”、Managed Apple Account、TestFlight 测试者邀请不属于本流程；说明正确入口，不用相似命令代替。

## 安全约束

- 任何真实邀请、设备注册、设备启停或用户权限变化，都是外部状态变更。先完成只读预检，展示目标团队、成员邮箱、姓名、角色、App 范围、设备名称、平台和 UDID，再取得一次针对这批精确写入的明确确认。
- 单设备 `asc devices register` 和 `asc users invite` 没有内置 `--confirm`；不能因此跳过会话级确认。批量设备必须先 `--dry-run`，再用同一文件执行 `--confirm`。
- 注册设备会消耗会员年度设备名额；禁用设备不会返还当年名额。遇到已有 UDID 时不重复注册；已有设备处于 `DISABLED` 时，提出重新启用方案并单独确认。
- 邀请只会发送激活邮件，不会创建 Apple Account，也不代表用户已经加入。邀请成功后状态是 pending；用户接受后再以 `asc users list --email` 验证。
- 不邀请或修改 `ACCOUNT_HOLDER`。Account Holder 转移有独立的法律与身份验证流程。
- 不输出 `.p8`、JWT、`ASC_PRIVATE_KEY` 或完整认证配置。优先使用 Keychain 或命名 profile；指定 `--profile` 并启用 `--strict-auth`，避免拼接多个凭据来源。不要为排障调用会打印 JWT 的 `asc auth token`。
- Team API key 跨所有 App；角色越高，影响范围越大。使用专用、最小权限 key。当前 `asc users invite` 不提供 `provisioningAllowed` 参数；需要 Certificates, Identifiers & Profiles 权限时，不声称邀请命令已授予，接受邀请后另行核验。
- 网络超时或响应不确定时，先查询 Apple 当前状态再决定是否重试。不要盲重放写请求；对 `401`、`403`、`409`、`422`、`429` 分别处理认证、权限、冲突、校验和限流问题。

## 执行顺序

1. 用当前安装版本的 `asc --help`、`asc users invite --help`、`asc devices register --help` 核对命令面，不照搬旧参数。
2. 运行只读认证检查；解析选中的 profile、Team/Provider 和 key 来源。发现多个可用凭据或目标团队不唯一时停止写入。
3. 查询同邮箱的现有用户和待接受邀请；查询同 UDID 的现有设备，并统计相关设备类别的年度名额风险。
4. 形成一份精确写入计划。若目标已存在，改为无操作或提出最小状态修复；不把冲突当作成功。
5. 获得确认后逐项写入。多目标默认按可审计的单项结果执行；一项失败时不自动扩大重试范围。
6. 立即进行写后读取。记录成功资源 ID、待接受邀请、设备状态、失败响应和仍需人工完成的步骤。
7. 若设备用于手工签名，提醒重新生成包含该设备的 provisioning profile；仅设备注册成功不代表旧 profile 已包含它。

## 交付格式

输出紧凑的结果表，至少区分：

- `成员邀请`：已存在 / pending / 已接受 / 失败；角色和 App 范围；邀请过期或人工接受动作。
- `设备`：已存在 / 已注册 / 已重新启用 / 失败；平台、状态和资源 ID；是否需要更新 provisioning profile。
- `安全与限制`：实际使用的 profile 名称和 Team/Provider 标识（不含秘密）、配额风险、未授予的权限、需要人工处理的步骤。

不能仅凭命令退出码、非空 JSON 或邀请创建结果宣称整批入组完成。
