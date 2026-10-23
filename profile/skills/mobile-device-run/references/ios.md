# iOS：命令行 Debug 真机运行

## 核对环境与目标

完整 Xcode 必须已安装；单独的 Command Line Tools 不包含完整 iOS 构建和设备工具。先查看当前选择与版本：

```sh
xcode-select -p
xcodebuild -version
xcrun devicectl --version
xcrun devicectl list devices
```

多版本 Xcode 时优先按项目要求设置当前命令的 `DEVELOPER_DIR`，不随意更改全局选择。以实际版本的 `xcrun devicectl help` 核对参数。需要结构化结果时使用 `--json-output <结果文件>`，不依赖人类可读表格的固定列。

目标未明确指定时，读取 `$HOME/.config/agent-config-local/iphone-default-device.md` 中的设备名。将设备名解析为当前连接设备的真实 UDID，并核对系统版本、配对、解锁、Developer Mode 和运行支持；明确指定的设备覆盖默认值。不能仅凭同名或列表第一项选择手机。默认设备记录缺失且无法从任务确定目标时，只询问缺少的设备身份。

遵循全局禁止 Xcode Simulator 的要求。真机不可用时报告受影响步骤，继续静态检查；不创建或启动模拟器，也不转向模拟器构建。

从仓库配置发现 `.xcworkspace` / `.xcodeproj`、Scheme、App target、签名团队和依赖。已有 workspace 时按项目约定使用，不同时传 `-workspace` 与 `-project`。可用 `xcodebuild -list -json` 和 `-showBuildSettings -json` 查询；这不等于构建或运行完成。

## 编译

下面是命令形状。执行前用已核验值设置变量；`project_workspace` 表示实际 workspace，使用 project 的工程改为 `-project`。构建产物目录应由项目固定并复用，避免每次改变路径造成全量编译。

```sh
xcodebuild -workspace "$project_workspace" -scheme "$app_scheme" \
  -configuration Debug -destination "platform=iOS,id=$device_udid" \
  -derivedDataPath "$build_dir" build
```

确认构建命令成功。使用相同 workspace、Scheme、configuration、destination 和 DerivedData 参数查询 build settings。定位实际 App target 的 `TARGET_BUILD_DIR` 与 `FULL_PRODUCT_NAME`，不要只取多 target JSON 的第一项，也不要根据 Scheme 名猜 `.app` 路径。记录该产物来自本次源码和 Debug 配置。

从产物 `Info.plist` 读取 `CFBundleIdentifier`，核对 App 身份、设备架构与有效开发签名。签名失败时诊断证书、profile 和团队配置，不用关闭签名伪造可安装结果。已有账户配置允许自动签名时，按项目需求使用 provisioning 参数；账号登录和验证遵循人工接管边界。

## 安装与启动

`built_app` 和 `bundle_id` 必须来自刚核验的产物。以下操作使用同一个已确认 UDID：

```sh
xcrun devicectl device install app --device "$device_udid" "$built_app"
xcrun devicectl device process launch --device "$device_udid" "$bundle_id"
```

不添加 `--start-stopped` 或 `--console`，不默认附加 LLDB。重新安装后若需要停止已有进程以验证新版本，先核对进程属于目标 App，再使用当前工具支持的重启选项；不要终止其他 App。

安装回执、启动返回的进程身份以及设备上的前台界面应对应同一 App。工具启动超时不等于启动失败或成功；先查目标进程和前台状态，再决定是否重试。需要自动化验证时，优先核验并使用 `maestro-ios-device` 的当前真机能力；不可用则报告未覆盖范围。单纯启动不证明所有功能通过。

## 资源与诊断

保留增量构建缓存。内存压力已经确认时，可以试验较小的 `xcodebuild -jobs N` 并比较耗时与压力；较少并发可能降低峰值内存，也可能延长编译时间。不要长期写入未经验证的全局调优参数。

按需保存构建错误和设备命令结果。不持续读取 App 日志，不把 Release 或来源不明的旧 `.app` 当作本次 Debug 验收产物。采用命令行流程不要求打开 Xcode 界面。

官方资料：[命令行工具](https://developer.apple.com/documentation/xcode/xcode-command-line-tool-reference)、[设备安装与启动](https://developer.apple.com/documentation/xcode/interacting-with-devices-using-the-command-line)、[增量构建](https://developer.apple.com/documentation/xcode/improving-the-speed-of-incremental-builds)。
