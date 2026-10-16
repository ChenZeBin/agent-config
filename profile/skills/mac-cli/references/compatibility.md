# 当前兼容性与使用边界

核验日期：2026-10-16。系统：macOS 27.0.1，build 26A434，arm64。
上游：[guarinogabriel/mac-cli](https://github.com/guarinogabriel/mac-cli/tree/26c047242351e4b1c66bff91548a07352a694f16)。
源码 revision：`26c047242351e4b1c66bff91548a07352a694f16`。安装入口、帮助文件和九个插件与该仓库逐文件一致；摘要见 [source-manifest.json](source-manifest.json)。
这是兼容性快照，不是所有 macOS 版本的保证。没有改动上游 CLI。

## 已实测的能力

| 命令 | 实测结果及限制 |
| --- | --- |
| `help` | 能输出帮助，但帮助中有过期/无实现条目，不能作为可用性证明。 |
| `info`、`uptime` | 返回系统版本与运行时长。 |
| `battery` | 能读取电源来源。已测桌面机器使用 AC Power；没有测试笔记本电池百分比。 |
| `volume`（无参数）、`volume:ismute` | 能读取音量数值和静音状态。未设置音量。 |
| `memory` | 在有界运行中观测到 top 的 PhysMem 和 PID 列；主动结束采样，不是一次性返回命令。 |
| `ip:local` | 得到 IPv4；只尝试 en0/en1，不代表所有网卡或默认路由。 |
| `dns:list` | 读取 resolv.conf 得到 nameserver；不代表 macOS 所有 scoped/supplemental resolver。 |
| `trash:size` | 当前权限下能读取废纸篓大小；没有清空。其他环境可能受权限限制。 |
| `folders:list`、`folder:size`、`find:biggest-files`、`find:biggest-directories` | 临时目录内验证输出。folders:list 包括非隐藏文件，不只目录；大文件排序基于 du 分配量，结果不保证复杂文件名都安全。 |
| `find:text` | 普通文件名成功；输入扩展名后检索。含空格文件名失败；grep 模式不是纯字面量搜索。 |
| `zip:extract`、`gzip:compress`、`gzip:extract`、`tar:compress`、`tar:extract` | 普通文件名的内容/产物校验通过。gzip 删除原件；tar:compress 需要 pv。zip/gzip 的含空格文件名测试失败。其他复杂路径不推荐使用这些封装。 |
| `search:replace` | 临时文件简单 before→after 替换通过。包含 sed 特殊字符、分隔符或空格路径的输入不在通过范围。 |
| `git:config`、`git:log`、`git:branch` | 在隔离配置的临时 Git 仓库核对实际输出。真实 config 输出可能包含账号或凭据地址，不应公开。 |
| `git:create:branch`、`git:branch:rename`、`git:branch:remove-local`、`git:undo-commit`、`git:add-removed`、`git:size` | 只在临时仓库验证分支、提交计数、工作文件和暂存状态；不代表真实仓库的变更已获授权。git:size 使用固定 tmp.bundle，有覆盖/删除风险。 |
| `ip:public`、`speedtest` | 公网 IPv4 查询及 networkQuality 上/下行结果实际返回。依赖 wget / networkQuality 和当时网络；公网 IP 使用明文 HTTP，仅作参考。测速会产生流量。 |

## 当前失败或没有实现

| 命令 | 证据与处理 |
| --- | --- |
| `wifi:status`、`wifi:scan` | 旧私有 airport 文件不存在，实际 stderr 报 No such file or directory；外层仍返回 0。禁用这两个封装。 |
| `bluetooth:status` | 当前机器缺少 ControllerPowerState 键，实际报 Could not find key；外层仍返回 0。不能判断蓝牙开关状态。 |
| `lock` | 静态确认 CGSession 路径不存在。没有执行锁屏操作。 |
| `system`、`temp`、`display`、`hosts:edit`、`ssh:list`、`git:settings`、`git:branches:date`、`image`、`magento` | 入口允许但无分支；实测无输出、退出 0。不要当作成功。 |
| `time`、`brew` | README 有条目，入口没有注册。brew:update 才是实际 Homebrew 更新命令。 |
| `git:branches`、`brew:git:config` | 插件有分支，入口未注册；不能通过普通入口可靠调用。 |

## 未执行的范围

以下只完成源码、依赖或路径检查；没有“功能可用”的运行结论。

- 系统/界面：`restart`、`sleep`、`shutdown`、`screensaver`、`hidden:show`、`hidden:hide`、`dock:add-space`、`eject-all`，音量设置及 `volume:mute`、`volume:unmute`。电源硬件行为按设备测试规则另行验证。
- 网络：`wifi:enable`、`wifi:disable` 默认选 en0，必须先核对实际 Wi-Fi 设备；`bluetooth:enable`、`bluetooth:disable` 写旧配置并重启服务；`dns:add`、`dns:remove` 修改 resolv.conf，不能证明持久或完整的 macOS DNS 配置；`dns:flush` 会重启/刷新解析服务。
- 权限/全盘：`ports` 使用 sudo lsof，仅查询监听 TCP；`find:recent` 使用 sudo find / -mmin N，不限定当前目录，且时间条件含义与帮助不一致。
- 更新与删除：`update`、`brew:update`、`upgrade`、`uninstall`、`trash:empty`。update 批量处理系统和包管理器；upgrade/uninstall 下载并执行远端脚本；trash:empty 使用 sudo rm -rf。
- 外部系统：`ssh:download-file`、`ssh:download-folder`、`ssh:sync:local`、`ssh:sync:remote`、`ssh:upload`。未连接远端；不能证明登录、传输、同步语义和路径引用正确。
- 剪贴板与外部界面：`ssh:public-key` 使用 pbcopy，未执行；`git:open` 打开网页，未执行；`git:branch:remove-remote` 会同时操作本地分支与远端，未执行。

帮助分类入口只负责输出说明。完整命令以 pinned 入口与插件为准，不把帮助分类当独立功能。

## 复核

```sh
python3 <skill目录>/scripts/probe.py --output <新的本地报告.json>
# 需要实际公网查询和测速时：
python3 <skill目录>/scripts/probe.py --network --output <另一个本地报告.json>
```

脚本拒绝覆盖报告。输出可能包含本机网络与进程信息，保留在本地。
原始失败案例也保留在报告中，不修改断言来把已知缺陷变成成功。
识别到版本变化时先检查源码，再更新测试与矩阵；不得单纯替换摘要。

