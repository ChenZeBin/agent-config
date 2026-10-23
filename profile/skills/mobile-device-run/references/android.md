# Android：命令行 Debug 构建与真机运行

默认用项目 Gradle Wrapper 编译 Debug 产物，再安装到已核验的单台真机并启动。无需打开 Android Studio，不默认连接调试器或持续采集日志。USB debugging 是 adb 通信前提，不代表需要附加调试器。必要诊断仍允许。

## 1. 发现项目与工具链

先读项目规则、README、CI、`settings.gradle(.kts)`、构建脚本和版本目录。确认应用模块、flavor 维度、Debug build type、AGP、Gradle、`compileSdk` 与签名配置。模块名不能假定为 `app`，variant 不能假定为 `debug`。库模块不能作为应用安装。

- 使用仓库 `gradlew`，不改用全局 Gradle，不为跑通而升级 AGP 或 wrapper。Windows 使用 `gradlew.bat`。
- 从 `gradle/wrapper/gradle-wrapper.properties` 确认 Gradle；从插件声明、版本目录或 convention plugin 确认 AGP。按对应 AGP 发布说明和 Gradle Java 兼容表选择运行 JDK，不固定套用某个 JDK 版本。
- 检查 `JAVA_HOME`、`org.gradle.java.home` 及项目存在时的 `gradle/gradle-daemon-jvm.properties`。Java toolchain、源码语言级别不等于运行 Gradle 的 JDK。用 wrapper 输出核验实际 JVM。
- SDK 可由独立命令行工具管理。复用已安装 SDK；补齐项目需要的 SDK Platform、Build Tools 和 `platform-tools` 即可，不必安装 Android Studio。Build Tools 版本取项目声明或该 AGP 的默认要求；不要一律装最新版。只在项目实际要求时补 NDK/CMake。核对 `ANDROID_HOME` 或本地 `sdk.dir` 与实际工具路径，勿提交本机路径。

在 Gradle 根目录执行；以下变量均须先从项目或实际输出赋值，不是固定示例值：

```sh
./gradlew --version
./gradlew projects
./gradlew "${MODULE}:tasks" --all
```

`MODULE` 是完整 Gradle 模块路径，包含开头的冒号；根模块使用空字符串。从任务列表选定精确 `assemble…Debug` 任务，将包含模块前缀的完整任务路径设为 `ASSEMBLE_TASK`。自定义命名时以项目实际 Debug 配置为准。若多个 flavor 对应不同环境或账号，先查项目默认运行约定；仍无法确定且会改变结果时才询问。

## 2. 锁定真机与验收入口

```sh
adb version
adb devices -l
```

将目标真机的 serial 与任务指定设备、现有设备记录及设备本体交叉核验。不能仅凭型号或列表第一行选设备。把核验后的 serial 设为 `SERIAL`，确认该行状态为 `device`。后续所有设备命令均带 `adb -s "$SERIAL"`，即使当前只有一台设备。

- `unauthorized`：需要目标设备解锁并完成本次主机授权；等待该条件，继续独立的编译或静态检查。
- `offline` 或未列出：先查目标连接、线缆、USB debugging 或已配置的无线连接。修复后重新核验同一目标；不换设备、不盲目重装、不默认重启整个 adb 服务。
- `device` 只说明通信状态。还需确认设备完成启动、屏幕可操作、API 满足 `minSdk`，ABI 与产物兼容。可定向读取 `getprop ro.build.version.sdk`、`getprop ro.product.cpu.abilist` 和 `getprop sys.boot_completed`。

端到端测试前，按原始需求建立 `evidence-gate` v2 用例计划，写明前置条件、步骤、可观测预期、精确真机环境与证据。先通过独立只读 `plan-review`，再执行受影响用例；不可事后补签。自动用例用 `run`；人工/UI 用例先 `test-start`，操作取证后 `test-result`。源码、计划或环境变化后重审并重跑受影响范围。

## 3. 构建并核验真实产物

```sh
./gradlew "$ASSEMBLE_TASK"
```

只构建已选模块和 variant。不要用无目标的 `installDebug` 或其他 Gradle install 任务替代后续精确安装，避免安装到其他连接设备。

从本次任务输出定位 APK 和对应 `output-metadata.json`。核对 `variantName`、`applicationId`、`elements[].outputFile` 及筛选条件；相对文件名按 metadata 所在目录解析。确认产物来自当前源码及所选任务，不按文件名猜测，也不取目录中的第一个 APK。metadata 缺失时结合任务输出和实际 APK 核验，不跳过核验。

使用已安装 Build Tools 中的 `aapt2` 检查产物；将其路径设为 `AAPT2`，待检查 APK 路径设为 `APK`：

```sh
"$AAPT2" dump badging "$APK"
"$AAPT2" dump xmltree "$APK" --file AndroidManifest.xml
```

从 APK manifest 核验最终 applicationId、`debuggable`、最低 API 和 launcher activity 或 `activity-alias`。metadata 不提供可靠 launcher；`namespace`、源码 package 和 `.MainActivity` 也不能替代最终 component。记录真实包名为 `APPLICATION_ID`。没有 launcher 时按项目明确入口执行，不虚构入口。

区分完整 APK 与相互依赖的 split APK：按 ABI 生成的独立完整 APK可择一安装；base 加配置/功能 split 必须选择同一次构建、同签名且覆盖目标设备所需内容的完整集合。不得单装一个 split，也不得把目录里所有 APK 混装。若只得到 AAB，它不能直接用 adb 安装；按项目已有 bundletool 流程生成并选择设备对应 APK 集合，设备操作仍须精确指定 serial。

## 4. 精确安装、启动与验收

每一步确认成功后再执行下一步。安装前再次核对同一 serial 的状态。单个完整 APK：

```sh
adb -s "$SERIAL" install -r "$APK"
```

split 集合改用 `adb -s "$SERIAL" install-multiple -r`，逐项传入已经核验的 base 和必需 split 路径。检查安装响应与目标包状态。`-r` 保留应用数据；遇签名不兼容或降级限制，不自动卸载、清数据或加绕过参数。先确认现有签名、目标 variant 与版本，优先使用兼容产物；必须丢弃数据才可继续时明确说明并等待单独授权。仅在确认 APK 为 `testOnly` 且任务需要时加 `-t`。

安装后在目标设备解析实际可启动 component：

```sh
adb -s "$SERIAL" shell cmd package resolve-activity --brief \
  -a android.intent.action.MAIN -c android.intent.category.LAUNCHER \
  -p "$APPLICATION_ID"
```

核对解析结果属于刚安装的包，且符合 APK 的入口或 alias；多个入口按需求选定。设 `COMPONENT` 为实际 `包名/类名`，不要把整段命令输出直接拼入启动命令。目标系统不支持此查询时，使用该系统支持的包查询及实际 manifest 确认入口。

```sh
adb -s "$SERIAL" shell am start -W -n "$COMPONENT"
```

读取 `Status`、实际 Activity 和错误信息，再用定向 UI 工具或真机屏幕确认目标应用已在前台、所需界面可见且无立即崩溃。必要时读取一次 `dumpsys activity activities` 辅助核对；Activity 可能按正常流程跳转，应与预期页面一致。已有实例接收 intent 不证明冷启动成功；需求要求冷启动时才按用例停止目标包后重启。

安装成功、进程存在、`Status: ok` 或退出码 0 均不能单独证明完成。按用例核验真实 UI 和任务结果，保存证据到任务指定的私有位置，最终经独立结果审查及 `verify` 得到 `accepted` 才宣称整体完成。设备标识、截图、日志和本机路径不写入本参考文档或公开 Skill。

## 5. 失败处理与资源取舍

保持授权内推进，只暂停依赖实际缺失条件的步骤。说明具体错误、已完成范围、未测范围和恢复条件；不因后续可能需要人工操作而提前停止。

诊断围绕实际失败进行：构建错误可加一次 `--stacktrace`；启动异常可读取限定时间或条数、聚焦目标包/进程的日志。避免无界 `logcat`、默认附加调试器、自动清日志或清缓存。

保留项目默认性能配置。仅在系统内存压力、OOM 或相关进程终止等事实成立时，为单次构建尝试 `./gradlew "$ASSEMBLE_TASK" --max-workers=2`；说明并行度降低可能减慢构建，也不能保证消除所有内存问题。记录比较结果，不永久修改 `gradle.properties`，不默认增加堆大小或关闭 daemon。

## 官方依据

- [命令行构建与 variant](https://developer.android.com/build/building-cmdline)
- [adb：设备选择、安装和启动](https://developer.android.com/tools/adb)
- [JDK 与 AGP 配置](https://developer.android.com/build/jdks)
- [SDK 命令行工具](https://developer.android.com/tools)与 [SDK 包管理](https://developer.android.com/tools/sdkmanager)
- [AAPT2：检查实际 APK](https://developer.android.com/tools/aapt2)
