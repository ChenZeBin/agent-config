# 操作说明

Python 3.10+，使用标准库及随 Skill 固定的 `vendor/bashlex` 0.18（GPL-3.0+，许可证随包保留；不修改全局 Python 环境）。解析器只生成语法树，不执行待检查命令；其源文件也纳入凭据摘要。脚本位置为本 Skill 的 `scripts/evidence_gate.py`。以下用 `gate` 简写 `python3 "${CODEX_HOME:-$HOME/.codex}/skills/evidence-gate/scripts/evidence_gate.py"`；这不是预装的 shell 命令。

## 合同

用 `apply_patch` 写 JSON，保存在产物范围之外。`root` 是任务工作目录，`inputs` 是相关源文件/目录，`artifacts` 是必须存在且非空的交付文件/目录。路径可为 root 相对路径，或明确纳入任务范围的绝对路径；拒绝符号链接。不要把整个 home、状态目录、依赖缓存或无关仓库纳入范围。

```json
{
  "version": 1,
  "user_request": "修复示例程序，使空输入返回 0；运行验证后交付。",
  "root": "/absolute/project",
  "inputs": ["src", "tests"],
  "artifacts": {"program": "src/counter.py"},
  "checks": [
    {"id": "tests", "argv": ["python3", "-m", "unittest", "discover", "-s", "tests"], "cwd": ".", "timeout": 120}
  ],
  "evidence": [],
  "criteria": [
    {"id": "empty", "requirement": "空输入返回 0，且现有非空输入行为不回归", "refs": ["check:tests", "artifact:program"]}
  ]
}
```

检查命令是 argv 数组，不经 shell 展开。只登记用户授权范围内的检查，不放提交、发布、删除等副作用。退出码 0 仅为机器检查通过，`/bin/true` 不能替代实际验收。

视觉证据加入 `"evidence": [{"id":"dock","kind":"image","description":"本次构建实际运行后的 Dock，包含相邻图标与目标图标"}]`，并在对应标准的 `refs` 中加入 `"evidence:dock"`。截图仅是待审材料。来源时间戳无法证明真正采集时间；独立审查仍须识别错误窗口、旧版本和无法确认的材料。

```sh
gate init --contract /absolute/contract.json
gate run
gate evidence --id dock --source /absolute/fresh-dock.png
gate review
gate verify
```

`init` 默认使用 `CODEX_THREAD_ID`；独立测试时显式 `--session demo`。`--state-dir` 可指定隔离的测试目录，必须位于合同范围之外。生产状态默认 `$CODEX_HOME/evidence-gate`（未设置时 `~/.codex/evidence-gate`）。

`review` 默认使用 `${CODEX_HOME:-~/.codex}/evidence-gate/reviewer-policy.json` 的 `default`（机器本地策略，不随 Skill 发布，也不从项目目录加载）；`--codex /absolute/codex` 只能选择策略中已核验路径及 SHA-256 匹配的 Codex 二进制，不能换成自写审查脚本。Codex 升级后需要重新核对官方安装来源、版本和摘要，再更新策略；不得为让任务通过而放宽白名单。策略变化会使旧合同失效。保留用户配置的模型，不覆写模型。审查调用 `codex exec --sandbox read-only --ephemeral --json --output-schema …`，不传入绕过审批或 hook 信任的参数，也不修改用户认证。独立审查会消耗一次模型调用；错误/无效 JSON/超时都保留为未通过。默认超时 180 秒，可用 `--timeout` 调整到最多 1800 秒。

`verify` 输出 JSON：

- `accepted`：检查和独立审查均通过，且当前内容与证据一致；退出码 0。输出中的 `acceptance_stage` 为 `completion` 且 `goal_complete: true` 时，才表示全部用户目标已完成。
- `accepted` + `acceptance_stage: "pre_delivery"`：仅交付前阶段通过，`goal_complete: false`。它允许合同精确声明的交付命令进入原有范围核验，不能用于宣布完成、`update_goal complete` 或替代交付后的验证。
- `checks_pass`：机器检查通过，独立审查尚未通过；退出码 1。
- `unverified`：证据缺失、检查失败、内容过期或仍在运行；退出码 1。
- `closed_unverified`：明确结束但未获得当前验收；退出码 1。

`close --reason "用户取消；未验收"` 只归档未完成状态，不制造通过凭据；修复或变更需求后用新合同重新 `init`。

## 交付前阶段

## 构建与只读验证

先登记合同，再实施修改并真实构建候选产物，最后执行 `gate run`。登记时可以有尚未生成的产物，但执行只读验证前它们必须已生成且稳定。`run` 在整批检查前后比较声明范围的内容摘要；不能把会重新生成 DMG、改签名或改写声明结果包的命令放进这批检查，否则它返回“检查期间输入/产物改变，检查凭据已失效”。这不是可以忽略的成功结果。

把构建与验证拆成两步：构建器实际调用编译器/打包器并保存完整命令、退出码、原始日志、构建前后的源码版本或摘要；只读验证器核对这些记录与当前源码、二进制及包内容，检查测试结果包中的逐例结果，并实际验证包可读、签名和包内文件。构建前后源码变化必须失败。仅记录当前源码摘要、文件存在、旧日志或手写“成功”不能证明产物由该源码构建。

下列命令名是项目需提供的构建器和验证器示意，不是本 Skill 内置命令：

```sh
gate init --contract /absolute/contract.json
python3 /absolute/project/build_candidate.py
gate run
gate evidence --id release-ui --source /absolute/fresh-release.png
gate review
gate verify
```

其中合同的 `checks` 应调用只读的 `verify_candidate.py`，而非 `build_candidate.py`。构建日志、测试结果包和产物应显式纳入合同范围；检查日志由 `gate run` 生成。若测试本身不改动声明范围，可直接放入 `checks`；若它生成已声明的结果包，应先运行测试，随后在 `checks` 读取结果包验证实际结果与对应源码。

任何重新构建、重新打包或相关源码变化都使旧检查和审查失效，必须对新产物重新 `run`、采集所需证据、`review`、`verify`。对于“提交 → 重打包 → 推送”，在提交前完成前置验收；提交不改变已验收文件内容时，提交后先以 `init --advance` 登记下一阶段，再构建最终包并重新验收，之后才能推送。不要在旧阶段产物已经改变后，试图用过期的通过记录推进；这类情况应如实保留失败状态并重新核验。

## 交付前阶段配置

当前本机 Codex 将 `exec_command` 的 Hook 输入归一为 `Bash`，不会传递 `workdir`。因此通过原生 Hook 执行 Git 交付时，命令必须显式包含 `git -C <合同 root 的绝对路径>`；仅设置 exec_command.workdir 不足以通过校验。合同 approved_commands 必须记录包含 -C 的精确命令。Hook 解析该静态目录后仍检查证据、白名单和暂存集合，不执行命令来推断路径。

默认 `acceptance_stage` 是 `completion`，旧合同不需要改动。只有交付动作本身尚未发生、但其余质量项已经可独立核验时，才可登记 `pre_delivery`。它不能推迟测试、证据采集、独立审查或其他前置质量项。

```json
{
  "acceptance_stage": "pre_delivery",
  "deferred_actions": [
    {"id": "commit", "description": "提交已验收文件", "approved_commands": ["git -C /absolute/project commit -m \"fix: exact message\""]}
  ],
  "post_delivery_verification": [
    {
      "id": "commit-record",
      "requirement": "交付后核验提交记录、重打包产物和已验收工作区一致",
      "deferred_action_ids": ["commit"],
      "steps": [
        {"id": "rebuild-package", "argv": ["python3", "/absolute/project/build_candidate.py"], "cwd": ".", "outputs": ["dist/final.dmg", "dist/manifest.json", "dist/build.log"]}
      ]
    }
  ]
}
```

`deferred_actions` 和 `post_delivery_verification` 在 `pre_delivery` 中都必填；每个动作必须由至少一个后置计划引用。`approved_commands` 是完整可执行命令的精确字符串匹配，等价的引号、参数或提交信息变体也会拒绝。该白名单只适用于受 Hook 识别的交付动作，仍会执行原有 shell、Git 范围和暂存内容校验。`steps` 可选，但一旦存在必须是非空的 `{id, argv, cwd, outputs}` 列表：它只记录提交后的构建/打包等非门禁步骤，拒绝 `git commit/push`、发布等受门禁识别动作，也不执行任何命令。每个 `outputs` 必须在 `--advance` 前已生成，并在下一阶段合同中作为 artifact 且被 criterion 引用；随后用下一阶段的真实 checks 和独立审查验证它。构建、测试等普通命令不能借此获得 Hook 放行。

每次已声明交付动作后，用同一份原始 `user_request` 登记下一阶段合同：`gate init --advance --contract /absolute/next-contract.json`。`--advance` 只接受当前 `pre_delivery` 已通过的记录，拒绝未就绪记录或改写后的用户目标；新记录会保存 `previous_task`，旧记录保留 `advanced_to` 链路。普通 `init` 不会静默覆盖阶段通过但目标尚未完成的任务。

若 `steps.outputs` 已是前置阶段的候选 artifact，提交后不得先覆盖它再 `--advance`，因为旧快照会失效。先把这个已存在的输出作为下一阶段合同的 artifact/criterion 完成 `--advance`，再执行重建，并对新产物重新 `run`、采集证据、`review`。只有输出不覆盖前置阶段已验收内容时，才可先执行 step 再转移；无论顺序如何，下一阶段的 checks 与独立审查必须针对重建后的实际输出。

## 复核记录

### 联网检查与断网审查器

需要远端事实时，合同可声明 `"network_checks": [{"id": "remote", "max_age_seconds": 1800}]`，其中 id 引用已有 checks，并由验收标准引用。对应检查必须真实请求目标服务并核对响应，例如比较实际远端 ref 与本地提交；不能只打印缓存、旧 receipt 或成功字符串。执行器沿用获授权的网络环境，审查器保持原有只读权限；此字段不授予任何网络或外部写入权限。

`gate run` 记录实际 argv、cwd、开始结束时间、退出码、stdout/stderr、联网命令的执行文件路径及摘要、内容绑定。自定义检查脚本、模块和影响行为的配置须纳入 inputs/artifacts，由审查器核对声明范围；不能在运行后替换未绑定脚本再审查。`verify` 除原有失败、篡改和版本校验外，还从检查开始时间计算有效期；执行文件变化、缺失、时间倒置、无时区、未来时间、登记前时间或过期均拒绝。有效期须为 1..86400 的整数秒，由用户时效需求确定；超时后重新采集、run、review，不可复用旧结论。审查过程中到期也不能交付。

独立审查读取真实检查代码与原始日志，核对目标、账号范围、响应和预期内容。审查器自己无法联网只代表其重查受限，不单独否定执行器已有的有效观测；若重查取得实际响应并发现矛盾，仍须拒绝。观测仅证明采集时间点的状态，不承诺远端永远不变。用户明确要求审查器本人联网、另一凭据验证或持续监控时，不能改为一次主控日志。手写汇总 artifact 不能替代 gate run 的原始记录；本地同权限防篡改边界保持不变。

运行 `python3 -B tests/network_review_eval.py` 可验证真实 HTTP 取证与只读 Codex 审查的正反例；其中错误响应即使退出码为 0 也应拒绝。它在临时目录运行，不推送、不修改用户认证或 Hook 信任。

状态目录中的 session 目录使用 session ID 的 SHA-256 前 24 位命名，下面每次登记有独立 task 目录。`task.json` 保存合同/快照/检查及审查引用，`runs/` 保存原始检查日志和审查输出，`evidence/` 保存导入材料。文件权限默认 0600、目录 0700。日志可能包含项目敏感内容，不上传、不自动打印全文；按项目的数据保留要求手动处理。

## 本地测试

```sh
python3 -B -m unittest discover -s "${CODEX_HOME:-$HOME/.codex}/skills/evidence-gate/tests" -v
```

端到端回归脚本 `tests/live_eval.py` 在临时目录运行一个真实完成案例、一个真实独立审查的 `pre_delivery` 阶段通过案例、一个已暂存但未提交的 completion 拒绝案例，以及一个合同漏项/伪检查拒绝案例；使用本机已有 Codex 认证，不修改项目。它会输出机器记录的结果与报告路径，不把脚本测试通过冒充真实 Hook 已激活。

`tests/native_hooks.py` 通过真实 app-server 的 `hook/completed` 事件检查已信任的 PreToolUse/Stop，在临时仓库仅尝试带 `if`、`command --`、ANSI-C 引号、算术语法、普通引号拼接或 `time` 的 `git commit --dry-run`；同时检查普通概念、条件说明、诚实否定、限制性定义、禁止声称、用途和状态名词解释，以及引用旧状态后新的完成声明。不产生提交、推送或改动项目，也不会自动信任 Hook。npm/Cargo 参数回归只解析命令字符串，不执行发布。

## 首次安装与迁移

本仓库只发布 Skill，不分发机器信任策略，也不自动启用 Hook。先核对本机 Codex 的官方安装来源、版本和二进制 SHA-256，再将审核过的策略保存到 `$CODEX_HOME/evidence-gate/reviewer-policy.json`（未设置 `CODEX_HOME` 时为 `~/.codex/evidence-gate/reviewer-policy.json`）；目录权限 0700、文件权限 0600。策略格式如下，占位值不可直接使用：

```json
{
  "version": 1,
  "default": "/absolute/verified/codex",
  "reviewers": [
    {"path": "/absolute/verified/codex", "sha256": "<verified-sha256>", "version": "<verified-version>"}
  ]
}
```

`path` 必须是核验后的真实绝对路径，`default` 应指向 reviewers 中同一个路径。缺少策略或路径/摘要不匹配时不能获得验收通过；不能自动把 PATH 上发现的程序加入白名单。已有安装可将原 Skill 内的已核验 `reviewer-policy.json` 原样迁移到上述机器本地位置；若目标已有策略，先比较并保留有效配置，不直接覆盖。策略内容变化会使旧任务证据失效。Hook 配置和信任状态仍需在目标 Codex 安装中单独核验，发布或链接 Skill 不等于 Hook 已启用。

随附依赖来源、版本及许可证见 `../vendor/README.md`。
