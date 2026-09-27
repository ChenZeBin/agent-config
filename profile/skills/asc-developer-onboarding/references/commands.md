# 标准流程与命令

适用于 Apple Developer Program 的组织账号。命令以 `asc 5.6.0` 为核验基线；每次执行仍以本机 `--help` 为准。

以下用 `PROFILE` 表示已存入 Keychain 或 `asc` 配置的命名 profile。不要把私钥或 JWT 直接写进命令行。

## 1. 认证与团队预检

```bash
asc --version
asc auth doctor --output json
asc --profile "PROFILE" --strict-auth auth status --output json --validate
asc users invite --help
asc devices register --help
```

`asc auth doctor --fix` 会修改配置，不属于预检。除非用户另行授权修复认证，否则只运行不带 `--fix` 的版本。

## 2. 成员邀请预检

```bash
asc --profile "PROFILE" --strict-auth users list \
  --email "person@example.com" \
  --fields "username,firstName,lastName,roles,allAppsVisible,provisioningAllowed" \
  --output json

asc --profile "PROFILE" --strict-auth users invites list \
  --paginate \
  --output json
```

待邀请列表没有 email 过滤参数；读取返回 JSON 中的邀请属性并精确匹配 email。若已是用户或已有 pending 邀请，不再创建重复邀请。

需要限制 App 时，先解析资源 ID：

```bash
asc --profile "PROFILE" --strict-auth apps list --paginate --output json
```

## 3. 成员邀请写入与核验

仅在用户确认精确邮箱、姓名、角色和 App 范围后执行。不能把 `--all-apps` 当默认值。

```bash
asc --profile "PROFILE" --strict-auth users invite \
  --email "person@example.com" \
  --first-name "First" \
  --last-name "Last" \
  --roles "DEVELOPER" \
  --visible-app "APP_ID" \
  --output json
```

确实需要全部 App 且角色规则允许时，才把 `--visible-app` 换为 `--all-apps`。写后重新执行 `users invites list`，确认出现精确邮箱。用户接受邀请后再执行：

```bash
asc --profile "PROFILE" --strict-auth users list \
  --email "person@example.com" \
  --fields "username,firstName,lastName,roles,allAppsVisible,provisioningAllowed" \
  --output json
```

邀请创建不等于接受。当前 CLI 不提供邀请时设置 `provisioningAllowed` 的参数；需要该权限时必须单独核验。

## 4. 设备注册预检

保留用户提供的 UDID 原值，只去除意外首尾空白；不要自行改变大小写、连字符或内容。

```bash
asc --profile "PROFILE" --strict-auth devices list \
  --udid "DEVICE_UDID" \
  --fields "name,udid,platform,status,deviceClass,addedDate" \
  --output json

asc --profile "PROFILE" --strict-auth devices list \
  --fields "name,udid,platform,status,deviceClass,addedDate" \
  --paginate \
  --output json
```

第二个查询用于按 `deviceClass` 评估对应产品系列的年度名额。不要只按 `platform` 聚合 iPhone、iPad、Apple Watch、Apple TV 等不同产品系列。

## 5. 单设备写入与核验

`asc devices register` 没有内置 dry-run。先在会话中展示精确计划并获得确认：

```bash
asc --profile "PROFILE" --strict-auth devices register \
  --name "Employee iPhone" \
  --udid "DEVICE_UDID" \
  --platform IOS \
  --output json
```

`platform` 只能使用当前 `--help` 列出的值，例如 `IOS`、`MAC_OS`、`UNIVERSAL`。写后以同一 UDID 查询并核对 `status`。若已有设备是 `DISABLED`，不要再次注册；经确认后使用：

```bash
asc --profile "PROFILE" --strict-auth devices update \
  --id "DEVICE_RESOURCE_ID" \
  --status ENABLED \
  --output json
```

## 6. 批量设备

仅在用户提供或确认 TSV 文件时使用。文件包含敏感设备标识，应位于私有、任务限定的位置，不放入公开仓库。

```bash
asc --profile "PROFILE" --strict-auth devices register-batch \
  --file "/private/path/devices.tsv" \
  --dry-run \
  --output json

asc --profile "PROFILE" --strict-auth devices register-batch \
  --file "/private/path/devices.tsv" \
  --continue-on-error=false \
  --confirm \
  --output json
```

确认运行必须使用已经审阅的同一文件。文件内容变化后重新 dry-run。写后逐个 UDID 查询，不以批处理退出码替代逐项结果。

## 7. 常见响应

- `401`：认证无效或 JWT/密钥问题。停止写入，重新运行只读认证检查。
- `403`：角色、Certificates/Identifiers/Profiles 权限、协议或团队范围不足。不要改用更高权限凭据绕过，先报告缺少的授权。
- `409`：资源冲突或重复。读取现有用户、邀请或设备并比对，不直接重试。
- `422`：字段或业务校验失败。按返回指针修正计划，再重新确认变化后的写入。
- `429`：限流。尊重服务返回的节流信息；等待后先读取当前状态，再决定是否重试。
- 超时/连接中断：结果不确定。先按 email 或 UDID 查询，不盲重放 POST。
