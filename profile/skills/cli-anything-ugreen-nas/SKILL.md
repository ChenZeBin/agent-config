---
name: cli-anything-ugreen-nas
description: 查找本机已保存的绿联 NAS / SMB 地址与挂载记录，核验时间机器备份前提；也支持用本机 CLI 只读查询设备、容量和网口状态。用户提到当前 NAS、之前的 SMB 或 NAS 备份时使用。
---

# 绿联 NAS、SMB 与备份检查

## 先找已有连接信息

用户说“当前 NAS”“之前开过 SMB”“用 NAS 备份”时，先读取本机私有文件 `$HOME/.config/agent-config-local/nas-archive.md`。其中保存 NAS 的 SMB URL、共享名和历史挂载路径；不要要求用户重复提供已记录的信息。此处只读连接配置，不启动归档扫描或文件迁移。配置缺失时查任务相关的本机记录；仍无法确认目标才询问地址，不猜测设备。

真实内网地址、共享名、历史容量和观察日期只保留在本机私有配置中，不复制到公开 Skill、测试用例或 Git 提交。带日期的记录是历史线索，每次使用都重新检查。

依次区分以下状态：

1. **客户端查询代理**：下面的 CLI 依赖已登录的绿联客户端。`proxy_unavailable` 只说明查询代理不可用，不代表 NAS 离线或 SMB 未开启。SMB 检查不依赖此代理，可独立继续。
2. **SMB 端口**：从已核验配置提取主机名，安全地作为参数传给 `/usr/bin/nc -z -G 3 "$nas_host" 445`。连接成功只证明该地址端口可达，不证明设备身份、认证、共享权限或时间机器兼容性；禁止对配置文本使用 `eval`。
3. **实际挂载**：运行 `/sbin/mount` 与 `/usr/bin/smbutil statshares -a`，核对服务器、共享名、实际路径与 SMB 会话。历史路径存在或 `mount` 无记录不能证明当前已挂载。未挂载不等于服务未开启；不得创建同名本地目录冒充 NAS。
4. **时间机器目标**：运行 `tmutil destinationinfo`。普通 SMB 共享可访问不代表已配置时间机器。还需确认 NAS 将专用共享指定为 Time Machine 文件夹、目标账号的权限及配额，并用已确认的挂载路径执行 `df -h "$nas_mount"` 核验当前空间；配额可能比卷空闲空间更小。

只有容量、设备固件等 CLI 查询确实需要客户端时，才把恢复客户端登录作为对应步骤的条件；不要将它变成所有 NAS 检查的前置条件。`device_mismatch` 或目标身份冲突时停止对该目标的操作并核对身份。

用户只要求搜索、核验或咨询时，保持只读。用户已要求配置备份时，可按其授权继续连接和配置；沿用系统登录界面或已有认证，不索要聊天密码，不导出钥匙串凭据。授权不会从“查询”扩大为挂载、修改共享、开启服务、格式化或启动备份。

回答“NAS 能否备份或电脑能否送修”时，明确逐项核验：目标身份与共享权限、时间机器专用共享、当前可用空间与共享配额、首次备份完成状态、排除项和实际文件恢复。卷空间足够不能替代共享配额检查。端口可达、目录存在或看见备份包都不等于可恢复。NAS 上的单份副本不等于多副本备份。配置细节以目标固件和当前官方说明为准：<https://support.ugnas.com/detail/article/zh-CN/350>。

## 已登录客户端的实时查询

用已安装的 `cli-anything-ugreen-nas`。本机入口 `$HOME/.local/bin/cli-anything-ugreen-nas`；源码 `$HOME/ugreen-nas-cli/agent-harness`。前提是 `/Applications/UGREEN NAS.app` 正在运行并登录设备。

```sh
cli-anything-ugreen-nas --json info
cli-anything-ugreen-nas --json storage
cli-anything-ugreen-nas --json network
```

全局 `--json`、`--timeout 5`、`--proxy-port 50102` 放在子命令之前。无参数进入 REPL，支持 `info`、`storage`、`network`、`help`、`quit`。

- `info`：`data.common.model/system_version` 和 `data.hardware` 来自当前 NAS。
- `storage`：`data.pools`、`data.volumes`。卷的 `total`、`used`、`available` 单位为字节；显示十进制 TB 用 10^12，二进制 TiB 用 2^40，并标明单位。
- `network`：`data.ifaces` 中 `speed` 为 Mbps，`duplex` 为双工状态，`ipv4.ipaddr` 为 NAS 地址。这是 NAS 网口协商速率，不是 Mac 的 Wi-Fi 速度，也不是文件复制测速；1000Mbps 的理论字节速率为 125MB/s，实际还受协议和硬盘限制。

必须检查退出码和 `ok`；成功还带有 `source:ugreen-client-live-proxy`、`observed_at`。单次失败退出码 1，`--json` 模式返回 `ok:false,error:{code,message}`。REPL 任一查询失败后最终退出码也为 1。无真实结果时如实报告，不能引用上次容量当作当前值。

客户端必须保持在线。`session_unavailable` 表示现有会话无法读取；工具仅支持当前 LevelDB WAL 格式，不读取旧 SST 猜测令牌。可提示用户在绿联客户端检查登录状态。`proxy_unavailable`/`proxy_untrusted` 表示没有可验证的绿联本地代理；不要切换到任意服务或关闭身份校验。`device_mismatch` 表示代理设备与当前会话不一致，先让用户核对已选设备。

只读范围：没有文件上传下载、删除、格式化、RAID 修改、开启 SSH 或测速写入命令。不要编造这些子命令。无持久状态变更，故不提供 undo/redo、project 或 preview。

认证由程序在内存中复用现有客户端会话，只发送给已验证的 localhost 绿联进程。无需用户在聊天中提供密码/token；不要打印、复制、保存或把凭据放进 shell 参数。不要修改客户端设置、开启远程调试或自行扩展权限来解决失败。

安装缺失时使用既有虚拟环境：`$HOME/ugreen-nas-cli/.venv/bin/python -m pip install -e $HOME/ugreen-nas-cli/agent-harness`。详见 `$HOME/ugreen-nas-cli/README.md`。
