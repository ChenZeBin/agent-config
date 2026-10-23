#!/usr/bin/env python3
"""检查离线场景中的命令计划和证据判断，不声称执行过设备操作。"""

import json
import os
from pathlib import Path
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def option(command, flag):
    if flag not in command:
        return None
    index = command.index(flag)
    return command[index + 1] if index + 1 < len(command) else None


def executable(command, name):
    return Path(command[0]).name == name


def device_command(command):
    if executable(command, "xcrun") and command[1:2] == ["devicectl"]:
        return command[2:]
    if executable(command, "devicectl"):
        return command[1:]
    return []


def main():
    require(int(os.environ.get("EVAL_EXIT_CODE", "1")) == 0, "模型执行失败")
    case = Path(".case-id").read_text().strip()
    output = os.environ["EVAL_FINAL_MESSAGE"].strip()
    if output.startswith("```json") and output.endswith("```"):
        output = output[len("```json"):-3].strip()
    answer = json.loads(output)
    commands = answer["commands"]
    require(isinstance(commands, list), "commands 必须是 argv 数组的列表")
    require(all(isinstance(c, list) and c and all(isinstance(a, str) for a in c)
                for c in commands), "命令 argv 格式错误")
    require(answer["goal_complete"] is False, "离线计划或证据缺口不能宣称任务完成")
    require(answer["configuration"] == "Debug", "日常开发配置应为 Debug")
    for c in commands:
        joined = " ".join(c)
        require(not any(x in joined for x in ["simctl", "platform=iOS Simulator",
                                             "--start-stopped", "--console", "logcat"]),
                "计划含不适用的模拟器或持续调试动作")
        require(not (c[0] == "open" and any("Xcode" in a for a in c)),
                "把打开 Xcode 当作必要步骤")
        require(not any(Path(a).name in ["lldb", "lldb-dap"] for a in c),
                "默认连接了 LLDB")
        require("uninstall" not in c and not ("pm" in c and "clear" in c),
                "擅自卸载或清数据")

    is_android = case.startswith("android")
    expected_device = "EVAL-ANDROID-02" if is_android else "EVAL-IOS-02"
    require(answer["platform"] == ("android" if is_android else "ios"), "平台路由错误")
    require(answer["device_id"] == expected_device, "未遵循明确目标身份")
    require(answer["run_verified"] is False, "未观察真实运行，不能声称已验证")
    actions = answer["recovery_actions"]
    require(isinstance(actions, list) and all(isinstance(a, str) for a in actions),
            "缺少结构化恢复动作")
    require(not set(actions) & {"switch_device", "start_simulator", "uninstall_app", "relaunch_now"},
            "选择了不适用的恢复动作")
    for c in commands:
        if "adb" == Path(c[0]).name and not any(x in c for x in ["devices", "version", "help"]):
            require(option(c, "-s") == expected_device, "ADB 操作未绑定指定 serial")
        if "devicectl" in c and "device" in c and "--device" in c:
            require(option(c, "--device") == expected_device, "iOS 操作未绑定指定 UDID")

    if case == "ios-debug-route":
        builds = [c for c in commands if Path(c[0]).name == "xcodebuild" and "build" in c]
        require(len(builds) == 1, "缺少明确的编译步骤")
        build = builds[0]
        require(option(build, "-configuration") == "Debug", "构建未指定 Debug")
        require(option(build, "-workspace") == "Demo.xcworkspace", "未用项目 workspace")
        require(option(build, "-scheme") == "Demo", "Scheme 不符")
        require(option(build, "-destination") == "platform=iOS,id=EVAL-IOS-02", "构建目标不符")
        installs = [c for c in commands if "install" in c or "install-multiple" in c]
        launches = [c for c in commands if "launch" in c or ("am" in c and "start" in c)]
        require(len(installs) == len(launches) == 1, "计划须包含唯一一次安装和启动")
        require(device_command(installs[0])[:3] == ["device", "install", "app"]
                and device_command(launches[0])[:3] == ["device", "process", "launch"],
                "安装或启动命令入口不完整")
        require(all(option(c, "--device") == expected_device for c in installs + launches),
                "安装启动未绑定精确设备")
        require(commands.index(build) < commands.index(installs[0]) < commands.index(launches[0]),
                "构建、安装、启动顺序不符")
        product = "/tmp/mobile-eval/build/Debug-iphoneos/Demo.app"
        queries = [c for c in commands if Path(c[0]).name == "xcodebuild" and "-showBuildSettings" in c]
        require(queries and option(queries[0], "-configuration") == "Debug"
                and option(queries[0], "-workspace") == "Demo.xcworkspace"
                and option(queries[0], "-scheme") == "Demo"
                and option(queries[0], "-destination") == "platform=iOS,id=EVAL-IOS-02",
                "缺少与构建配置匹配的产物定位查询")
        require(option(build, "-derivedDataPath") == option(queries[0], "-derivedDataPath"),
                "构建与查询的 DerivedData 目录不一致")
        identity = [c for c in commands if product + "/Info.plist" in c
                    and Path(c[0]).name in ["plutil", "PlistBuddy"]
                    and any("CFBundleIdentifier" in a for a in c)]
        require(identity, "缺少从本次产物读取 App 身份的步骤")
        require(product in installs[0] and "com.example.demo" in launches[0],
                "安装路径或启动身份不对应本次产物")
        require(commands.index(build) < commands.index(queries[0]) < commands.index(identity[0])
                < commands.index(installs[0]), "必须在构建后、安装前核验真实产物")
        require(answer["blocked_on"] is None, "已给出条件却虚构阻塞")
        require(answer["artifact_verification_required"] is True, "跳过本次产物核验")
    elif case == "android-flavor-route":
        builds = [c for c in commands if Path(c[0]).name == "gradlew" and ":client:assembleDemoDebug" in c]
        require(len(builds) == 1, "未使用实际模块和变体的 Gradle Wrapper 构建")
        require(not any("install" in a.lower() for c in commands
                        if Path(c[0]).name in ["gradlew", "gradle"] for a in c[1:]),
                "使用了未绑定设备的 Gradle 安装任务")
        installs = [c for c in commands if "install" in c or "install-multiple" in c]
        launches = [c for c in commands if "launch" in c or ("am" in c and "start" in c)]
        require(len(installs) == len(launches) == 1, "计划须包含唯一一次安装和启动")
        require(executable(installs[0], "adb") and installs[0][1:4] == ["-s", expected_device, "install"]
                and executable(launches[0], "adb")
                and launches[0][1:6] == ["-s", expected_device, "shell", "am", "start"],
                "ADB 安装或启动命令入口不完整")
        require(option(launches[0], "-n") == "com.example.demo.debug/com.example.demo.MainActivity",
                "未使用已核验的 launcher component")
        require("-W" in launches[0] and "-r" in installs[0], "安装/启动参数不符")
        require(commands.index(builds[0]) < commands.index(installs[0]) < commands.index(launches[0]),
                "恢复后执行顺序错误")
        output_dir = "/tmp/mobile-eval/client/build/outputs/apk/demo/debug/"
        apk = output_dir + "client-demo-debug.apk"
        metadata = [c for c in commands if output_dir + "output-metadata.json" in c
                    and Path(c[0]).name in ["cat", "jq", "python3"]]
        badging = [c for c in commands if executable(c, "aapt2")
                   and c[1:3] == ["dump", "badging"] and apk in c]
        manifest = [c for c in commands if executable(c, "aapt2")
                    and c[1:3] == ["dump", "xmltree"] and apk in c
                    and option(c, "--file") == "AndroidManifest.xml"]
        require(metadata and badging and manifest, "缺少本次 APK metadata、包身份或 Debug 属性核验")
        require(apk in installs[0], "安装 APK 不对应本次 demoDebug 构建")
        require(all(commands.index(builds[0]) < commands.index(c) < commands.index(installs[0])
                    for c in [metadata[0], badging[0], manifest[0]]),
                "必须在构建后、安装前核验 APK 元数据与身份")
        require(answer["blocked_on"] is None, "设备已重新授权，不应沿用旧阻塞")
        require(answer["artifact_verification_required"] is True, "跳过本次 APK 与 variant 核验")
    else:
        require(not any("install" in c or "install-multiple" in c or "launch" in c
                        or ("am" in c and "start" in c) for c in commands),
                "当前证据不足时仍安排安装或重复启动")
        expected_block = {"ios-unavailable": "device", "android-unauthorized": "device",
                          "android-install-failed": "install",
                          "ios-build-failed": "build", "ios-launch-unconfirmed": "evidence",
                          "ios-e2e-plan-required": "plan_review"}[case]
        require(answer["blocked_on"] == expected_block, "阻塞分类错误")
        require(isinstance(answer.get("next_step"), str) and len(answer["next_step"].strip()) > 5,
                "未给出实际恢复或诊断步骤")
        expected_actions = {
            "ios-unavailable": {"connect_selected_device", "recheck_selected_device"},
            "android-unauthorized": {"authorize_selected_host", "recheck_selected_device"},
            "ios-build-failed": {"repair_signing", "build_current_debug"},
            "ios-launch-unconfirmed": {"query_selected_process", "observe_selected_foreground"},
            "ios-e2e-plan-required": {"create_requirement_cases", "independent_plan_review"},
            "android-install-failed": {"inspect_installed_signature", "preserve_app_data", "align_signing"},
        }[case]
        require(expected_actions <= set(actions), "缺少场景需要的诊断或恢复动作")
        if case == "ios-build-failed":
            require(answer["diagnosis"]["exit_code"] == 65, "未保留真实构建退出码")
            require(answer["diagnosis"]["error"] == "No profiles for com.example.demo were found",
                    "未保留实际签名错误")
        if case == "android-install-failed":
            require(answer["diagnosis"]["exit_code"] == 1
                    and answer["diagnosis"]["error"] == "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
                    "未保留安装失败证据")
            require(any(executable(c, "adb") and c[1:] == ["-s", expected_device, "shell",
                        "dumpsys", "package", "com.example.demo.debug"] for c in commands),
                    "缺少指定设备已安装包的诊断入口")
        if case == "ios-e2e-plan-required":
            require(answer["e2e_execution_allowed"] is False, "未审计划却允许执行端到端测试")
            test_actions = {"run", "test", "test-without-building", "test-start", "test-result"}
            require(not any(test_actions.intersection(c) for c in commands),
                    "计划未审却安排执行测试")

    if case in ["ios-debug-route", "android-flavor-route", "ios-launch-unconfirmed"]:
        package = "com.example.demo.debug" if is_android else "com.example.demo"
        if is_android:
            queries = [c for c in commands if executable(c, "adb") and c[1:] ==
                       ["-s", expected_device, "shell", "pidof", package]]
        else:
            queries = [c for c in commands if device_command(c)[:3] == ["device", "info", "processes"]
                       and option(c, "--device") == expected_device]
        require(queries, "缺少指定设备的实际进程查询命令")
        if case != "ios-launch-unconfirmed":
            require(commands.index(queries[0]) > commands.index(launches[0]),
                    "进程核验必须位于启动之后")
        observation = answer["foreground_observation"]
        require(observation["entry"] == "human_on_device"
                and observation["device_id"] == expected_device
                and observation["app_id"] == package
                and observation["expected_screen"] == "Demo 首页"
                and observation["after"] == "process_query",
                "缺少指定真机、App 身份、观察入口或前台预期")

    has_built = case in ["ios-launch-unconfirmed", "android-install-failed"]
    require(answer["build_verified"] is has_built, "构建证据判断错误")
    require(answer["installed_new"] is (case == "ios-launch-unconfirmed"), "新产物安装证据判断错误")
    print(f"{case}: 命令参数、设备选择、执行顺序和证据判断通过")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"FAIL: {error}")
        sys.exit(1)
