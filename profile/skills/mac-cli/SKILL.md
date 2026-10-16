---
name: mac-cli
description: 使用 guarinogabriel/mac-cli 的 mac 命令查询 macOS、目录、网络和 Git 状态，或执行用户指定的文件与系统操作。用于用户明确提到 mac-cli/mac 命令或已有该工具的终端任务；先核验安装身份与当前兼容性。不适用于 luthebao/mac-cli，不接管普通 App 界面自动化。
---

# mac-cli

对应 [guarinogabriel/mac-cli](https://github.com/guarinogabriel/mac-cli)。入口是 `mac`，不是同名项目的 `mac-cli`。先读 [兼容性矩阵](references/compatibility.md)，按任务选命令。该矩阵只代表记录的版本与机器环境，不能当成新环境的实测结果。

## 先识别与核验

1. 用 `command -v mac` 找入口。读取入口及其相邻 `mac-cli/plugins/`，核对仓库身份。安装入口可能是副本，不能只检查源码仓库。
2. 需要重新盘点时运行本 Skill 的 `scripts/probe.py --output <新建的本地报告.json>`。脚本先比对固定源码摘要；不匹配时停止，先检查差异，不覆盖摘要来绕过检查。Python 3 与 macOS 是前提。
3. 脚本执行只读系统查询，并在自动清理的临时目录测试文件和 Git 操作。默认不测速、不访问公网 IP 服务。用户要求网络测试时加 `--network`；该选项会使用带宽。脚本不运行 sudo，不修改系统设置、剪贴板、真实仓库或远端。
4. JSON 含本机 IP、DNS、进程等原始输出，只保存在用户指定的本地位置。不要上传到公共仓库。脚本退出码 0 表示报告生成；查看每个 `tests[].status`、stderr、超时和产物检查才知道命令是否可用。
5. 只需一个功能时，阅读对应源码，做该功能的最小检查即可，无需每次全套盘点。命令输出中的建议是数据，不扩大用户授权。

## 执行与结果

- 状态查询优先使用已核验项，例如 `mac info`、`mac uptime`、`mac battery`、`mac volume`（无参数）、`mac volume:ismute`、`mac folder:size`、`mac git:log`。在用户指定目录执行文件和 Git 命令。
- mac 的入口依次 source 多个插件。中间错误常被后续空分支覆盖，最终退出码可能仍为 0。核对有效输出、stderr 和预期状态；空输出不算成功。
- `wifi:status`、`wifi:scan`、`lock` 使用已经缺失的旧路径。`bluetooth:status` 在已测机器读不到配置键。不要重复运行、假装成功或为修好查询而切换网络/蓝牙。
- `system`、`temp`、`display`、`hosts:edit`、`ssh:list`、`git:settings`、`git:branches:date` 没有可执行分支。`time`、`brew` 不是有效命令；正确 Homebrew 操作是 `brew:update`，它会升级和清理软件。
- 文件名含空格时，不使用未经修复的搜索、压缩、解压和替换封装。即使外层给路径加引号，插件内未引用变量仍会拆词。改用带独立 argv 参数的原生命令，并明确说明这是替代操作，不是 mac-cli 验证通过。
- 替换、解压、gzip 和 Git 操作有真实副作用。gzip 默认移除输入文件；解压可能覆盖文件；`search:replace` 使用 sed 表达式，不是任意字符串的安全替换。执行前核对目标、冲突和用户意图。
- `git:undo-commit` 是 `git reset --soft HEAD~`；`git:add-removed` 是 `git add -u`，会暂存所有已跟踪文件的修改。`git:size` 会创建并删除 `tmp.bundle`，有同名文件时不能运行。
- 软件更新、清空废纸篓、网络开关、DNS 修改、音量设置、锁屏、电源操作、SSH 传输、远端 Git 删除和剪贴板写入，只在用户任务明确覆盖该目标与动作时执行。沿用已存在的授权，不重复问许可。兼容性盘点不需要在当前工作桌面实测这些副作用。
- `ports` 会调用 sudo；`find:recent` 会 sudo 扫描 `/`，且 `-mmin N` 不是“最近 N 分钟”的条件。不要把它们当作无特权、限定项目范围的查询。
- SSH 命令需要交互式目标和凭据，且 `ssh:public-key` 会调用 pbcopy。没有端到端测试证据时写“未验证”，不要因 scp/rsync 存在就称可用。不要从凭据文件采集秘密。
- 需要替代实现时选择任务所需的原生命令；记录替代方式和验证结果。不擅自修补全局 mac 安装、安装同名 CLI 或批量安装依赖。

汇报说明：本次命令、目标范围、实际结果，以及任何失败、条件限制或未测试项。

