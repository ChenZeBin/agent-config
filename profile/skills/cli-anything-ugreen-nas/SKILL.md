---
name: cli-anything-ugreen-nas
description: 使用本机 CLI 只读查询绿联 NAS 的设备信息、存储池和卷容量、网口连接状态；适用于已运行并登录的 macOS 绿联 NAS 客户端。
---

# 绿联 NAS 实时查询

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
