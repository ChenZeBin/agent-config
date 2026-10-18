# 端到端测试：先计划、独立审查，再执行

适用于跨组件或从用户入口到最终结果的端到端流程，包括浏览器、CLI、多进程、设备和人工/UI 验收。普通单元测试、静态检查和只读调查不自动属于此范围。判断依据是原始目标和实际执行内容，不是脚本是否叫 e2e。

## 合同和计划

新登记合同使用 `version: 2`，保留原始 `user_request` 和全部 `criteria`。不涉及端到端测试时填写 `"testing":{"kind":"not_applicable","reason":"具体不适用理由"}`。独立最终审查仍核对该理由。

端到端合同填写：

```json
"testing": {
  "kind": "e2e",
  "plan": "tests/e2e-plan.json",
  "criterion_ids": ["login", "resume"]
}
```

把 `tests/e2e-plan.json` 作为精确文件列入 `inputs`，同时纳入执行脚本和影响行为的代码/配置。`criterion_ids` 是本次端到端范围的冻结需求 ID。不能选择性漏掉原始要求；独立审查会检查覆盖。计划可在 init 后创建，但缺计划时不能审查或执行。

计划 JSON 使用严格字段集合。顶层只能包含 `version`、`environments`、`cases`；环境和用例也只能包含下面示例中的字段。不要增加 `review_notes`、`approved` 或自定义状态字段。审查说明和未执行状态放在最终回复或独立文档中。提交前按正式 `e2e_plan.load_plan` 做静态格式核验；格式通过不等于独立审查通过，也不允许开始测试。

计划示例（合同还须声明 `browser` check；该检查运行实际自动测试脚本）：

```json
{
  "version": 1,
  "environments": [
    {"id":"local-fixture","kind":"synthetic","target":"独立临时目录的合成登录站点；当前源码和指定 Chromium 版本；测试账号；结束后清理进程和目录"}
  ],
  "cases": [
    {
      "id":"login-and-continue",
      "criterion_ids":["login"],
      "preconditions":["站点和浏览器已使用独立测试数据启动"],
      "steps":["从实际工具入口登录测试账号","在同一标签页点击继续"],
      "expected":["账号身份与配置一致","标签页标识不变且继续操作的实际结果可见"],
      "environment_id":"local-fixture",
      "check_id":"browser",
      "evidence_refs":["check:browser"]
    },
    {
      "id":"restart-and-reuse",
      "criterion_ids":["resume"],
      "preconditions":["该测试账号已经登录且状态已保存"],
      "steps":["正常停止服务","重启服务并从实际入口执行下一任务"],
      "expected":["恢复正确账号身份","没有重复提交密码且下一任务实际完成"],
      "environment_id":"local-fixture",
      "check_id":"browser",
      "evidence_refs":["check:browser"]
    }
  ]
}
```

先根据需求设计成功、失败、边界、恢复和清理场景，再读取实现查漏。每例需要非空的前置条件、步骤和可观测预期，不能只写“正常”“成功”。`environment_id` 必须存在。`kind=target` 表示原始要求的实际目标环境，须描述可核对的设备/账号别名/构建版本和测试数据边界；`synthetic` 不得替代真实设备或业务服务要求。秘密不写入计划、日志或 actual。自研 iOS 测试遵循全局真机和 Xcode Debug 规则。

自动用例的 `check_id` 引用合同检查，`evidence_refs` 必须包括对应 `check:<id>`；也可引用合同已声明的 `evidence:<id>`。人工/UI 用例设置 `check_id: null`，只引用已声明的原始 `evidence:<id>`。每项冻结端到端需求至少有一个用例；每例都引用有效需求。机械覆盖只能检查引用，语义完整性由独立审查判断。

## 独立前置审查

以下 `gate` 是 [操作说明](operations.md) 中的脚本简写：

```sh
gate init --contract /absolute/contract.json
gate plan-review --timeout 600
```

`plan-review` 使用可信策略中的 Codex CLI，创建独立只读执行，不接受实现者自填的 approved 或外部 JSON 作为通过凭据。审查原始要求、合同、当前计划和绑定源码；返回 `req-*` 与 `case-*` 的逐项意见。只有 `status: plan_accepted` 且 `execution_allowed: true` 才能执行。它始终 `goal_complete: false`。

拒绝时按意见修正计划、实现或环境定义后重审。新增用例可编辑计划文件；修改预期须记录需求依据，不能按现有错误输出放宽。计划或任何绑定输入变化后，旧审查和结果失效。重新 plan-review 会清空本任务的旧执行记录，不能事后审查并追认先前测试。原始 runs 文件保留用于追溯。

## 自动执行与逐例结果

```sh
gate run
```

`run` 在启动任何检查子进程前核验当前计划审查。自动测试在真实执行每例后，在 stdout 输出一行以下格式：

```text
EVIDENCE_GATE_CASE {"id":"login-and-continue","status":"pass","environment_id":"local-fixture","actual":"读取到预期账号身份；同一标签页继续操作后的结果已验证"}
```

状态只能是 `pass`、`fail`、`skip`、`blocked`。`actual` 是脱敏的实际观察，不能预填。每个 check 必须输出它负责的全部计划用例，ID 恰好匹配且不重复。退出码 0、零用例、全部跳过、缺例、错环境均不算通过。运行器保存 stdout/stderr、argv/cwd、时间、当前计划审查摘要和源码绑定。最终独立审查还会检查测试脚本是否真实执行和断言，打印 pass 本身不证明行为。

检查不得修改合同 inputs/artifacts。测试产生的截图/结果包应保存在范围之外的独立测试目录，执行后用 `evidence` 登记；临时文件和进程须按计划清理。构建、环境准备与只读探索可先进行，但不能借“准备”提前执行待审的端到端流程。

## 人工或 UI 执行

```sh
gate test-start --case physical-login
# 此时才按计划操作目标、观察结果，并采集原始证据。
gate evidence --id physical-login-record --source /absolute/new-observation.json
gate test-result --case physical-login --status pass --actual '实际观察的脱敏结果'
```

`test-start` 只记录当前已审用例的开始。缺前审不能开始；代码或计划变化后须重审并重新开始。填 pass 前，所有该例原始 evidence 必须已登记且采集时间不早于本次 start。失败、阻塞和跳过可如实记录；它们不会获得验收通过。文件时间不能独立证明操作真实性，因此必须保留可审查的目标身份、具体操作、实际观察及关联原始材料；最终 review 会核对。

## 最终验收与迁移

全部用例执行后，仍须 `review` 和 `verify`。结果审查独立于计划审查，读取原始测试日志、逐例 actual、目标环境和原始证据。报告按需求列覆盖与缺口，分清合成和真实环境，不把测试总数等同需求完成。

旧已登记 v1 合同可读；升级 runner 后旧收据须重新核验。未执行的端到端测试须以明确迁移原因保留旧记录，复制原始要求、全部范围及验收项到 v2 后登记并前审，不允许缩减范围或继承旧通过结果。新 init 拒绝 v1。普通问答不登记任务。

已登记任务的 Hook 只拦截可识别测试入口和部分 UI 动作，不是所有工具的完整安全边界。见 [边界说明](limits.md#端到端前置审查边界)。
