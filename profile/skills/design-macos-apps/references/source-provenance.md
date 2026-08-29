# Source provenance and maintenance

This skill is an independently written synthesis. It does not bundle Apple HIG prose, community skill text, third-party scripts, remote registries, or design assets. Use this reference to understand why a rule exists or to maintain the skill after platform changes.

Research snapshots were retrieved on 2026-08-16 under `/Users/example/Project/mac-app-design-skill-research/sources/`. Every retained source has a local `SOURCE.md` describing exact scope, commit, license, and execution boundary. No upstream installer, script, MCP tool, package, or hook was executed.

## Governing posture

- Use current Apple documentation for facts and release decisions.
- Use community sources to discover questions, workflows, and possible patterns.
- Rewrite portable principles in native Mac terms.
- Reject frozen HIG copies, Web/iOS implementation, arbitrary taste, and dynamic catalogue instructions.
- Do not copy from a source with missing/unclear license.

## Sources reviewed

| Upstream and pinned commit | Skills/material reviewed | License at snapshot | Disposition in this skill |
| --- | --- | --- | --- |
| `zoonk/zoonk` `98276dda2577c0a956ffd4b44737c7e4219e339c` | `apple-human-interface-guidelines`, official-link router | MIT | **Adopt workflow:** identify platform and read current first-party HIG/API. Do not treat it as substantive frozen guidance. |
| `ehmo/platform-design-skills` `dc2be825d8b439caea78e9eaa8fb3ac23b0ff3e9` | `macos` / macOS design checklist | MIT | **Adapt:** broad Mac coverage. Reject universal shortcuts, context menus, fixed menus, and other absolutes. |
| `Prisma-Labs-Dev/apple-skills` `a76633bad89fc740df3c2e0d125fc3e4092a5075` | `hig`, `guide-swiftui-ui-patterns`, `ios-dev` | MIT | **Adapt:** lookup and implementation ideas. Reject iOS shell as Mac architecture and third-party mirror as authority. |
| `raintree-technology/hig-doctor` `8bfa28f76c62d0ad4bf02640f5a195f3267bcf39` | modular HIG project/platform/foundation/component/pattern/input suite | MIT for repository; Apple material excepted | **Adopt modular routing/evaluation structure.** Do not copy HIG corpus or automatic workspace-write behavior. |
| `rshankras/claude-code-apple-skills` `9ffb83138209057875698dd11c1720c657c47a92` | macOS router/modules and design modules | MIT | **Adapt audit and implementation prompts.** Verify all Tahoe/future-version metadata and exclude unrelated architecture/data/capability content. |
| `ceorkm/macos-design-skill` `8f528a2364f996cd42f02a10b1b27198a74ca2a3` | `macos-design` | No repository license | **Observation only:** useful Web-to-desktop warning. Reject fake chrome, CSS blur, fixed drag zones/values, and absolute motion/search rules. |
| `AvdLee/SwiftUI-Agent-Skill` `4c6a97d15aa5e023538c3cb06b5192f241dd451d` | `swiftui-expert-skill` and routed references | MIT | **Adapt implementation correctness:** state, performance, macOS scenes/views, narrow AppKit bridges, availability. Exclude automatic tracing from design work. |
| `openai/plugins` `11c74d6ba24d3a6d48f54a194cd00ef3beea18f9` | build-macos subskills including Liquid Glass, windows, SwiftUI, AppKit | No repository/plugin license found | **Independently rewrite observations:** strong Mac structure/system-first mapping. Exclude operational build/sign/package/telemetry instructions. |
| `Dimillian/Skills` `05ba982bfeb0d77d3c97d4542b0ee15034d05f84` | `swiftui-liquid-glass`, `swiftui-ui-patterns` | MIT | **Adapt API mechanics:** state and glass grouping/fallback. Reject iOS-only guards, tab/navigation shell, and glass-as-style. |
| `figma/mcp-server-guide` `72fcf1f4b170bcaa78fa8bef2f27cce15f4d58f4` | `figma-swiftui` plus five routed Figma skills | No repository license found | **Independently rewrite semantic mapping only.** Reject iPhone recipes/pixel copying; never mutate Figma without explicit authorization. |
| `arjitj2/swiftui-design-principles` `791d22d73f844167a3872530e3941185b730d8be` | `swiftui-design-principles` | MIT | **Adapt restraint and semantic roles.** Reject iOS/widget shell, fixed grids/radii/type values as Mac law. |
| `CharlesWiltgen/Axiom` `3839d39b3c03cc861b40dfe19417bff5994216ac` | `axiom-design` with HIG, Liquid Glass, symbols, type, composition references | MIT | **Adapt platform-conformance layer:** semantic roles, user preferences, system-first material. Verify every current claim against Apple. |
| `Wholiver/swiftui-design-skill` `2c82638ebd3c801d9d2d12b5f2d6c20495939995` | design direction, anti-generic, review, tokens | MIT | **Adopt exploration/review workflow.** Reject mandatory serif/warm palette/signature detail/44pt/fixed tokens/three directions. |
| `emilkowalski/skills` `78761e1b57f97dce65b983d640c70a68f39e8163` | all 10 bundled skills: Apple/Web motion, design engineering, animation, review/planning/prototype/library/Sonner | MIT | **Adopt motion judgment:** purpose, frequency, continuity, interruption, restraint. Reject CSS/Pointer Events/rAF/Motion implementations and Web-only skills. |
| `kylezantos/design-motion-principles` `4a9ca879f24a361f4dca4174fe2da0f67b5ddee3` | `design-motion-principles` | MIT | **Adapt frequency/context/audit lens.** Reject Web implementation and author lenses as Apple rules. |
| `ibelick/ui-skills` `179e9e990a3ebc18620959e134f2b597819e0d50` | all 7 bundled skills and direct audit template | MIT | **Adopt evidence/falsification method.** Reject CLI/dynamic registry and CSS/Tailwind/ARIA/SEO/browser implementation. |
| `jamesrochabrun/skills` `2482c176372299c92af01f8414a67172f324e8db` | `apple-hig-designer` | MIT | **Low-priority adaptation:** semantic/accessibility basics. Reject iOS-first components as Mac authority. |
| `heyman333/atelier-ui` `92b76bf8e29dc4f7bb6b5ba48ac3dbdf4f9a1872` | `apple-ui-designer`, `ios-glass-ui-designer` | No repository license found | **Observation only:** restraint/native-over-custom. Reject iOS navigation/touch/glass prescriptions and do not copy. |
| `axiaoge2/Apple-Hig-Designer` `ff17b91ff2903ecd52940afabf97de5a73c9cd1b` | Apple-labelled CSS/React/Vue design kit | MIT | **Reject native use:** Web implementation and hardcoded tokens; retain only as Apple-inspired-Web counterexample. |
| `ihlamury/design-skills` `126714ec5df13a2c97ce1b3975e5a51d2592d967` | `apple` / `apple-ui-skills` | No repository license found | **Reject:** Inter/fixed white-blue/4px Web tokens conflict with adaptive native design. |
| `curiositech/some_claude_skills` `abeb81ae7d7065f99da82c5376aff659e206554c` | `native-app-designer` | MIT | **Reject governing use:** overbroad Web/native persona and expansive Write/Bash/MCP permissions; generic craft ideas already covered. |
| `nexu-io/open-design` `30fc648f6f615fde5b162cbee1177f94ea2dba6c` | `apple-hig`, `swiftui-design` wrappers | Apache-2.0 wrapper | **Reject:** catalogue pointers contain no independent rules; use pinned upstreams. |
| `bergside/awesome-design-skills` `f631a09b4fcc0166f2e2c1a8c81906ef680c57e8` | `glassmorphism` | MIT | **Reject native use:** generic enterprise Web glass preset, not Apple Liquid Glass. |
| `freshtechbro/claudedesignskills` `1da73febff0c3e1dfefc07f8a5ef8f7d1dfdb6cd` | `motion-framer` | MIT | **Reject native use:** React/Motion manual with missing named references. |
| `aphlo/babymom-diary` `fc2ff18ba07be9f523a184a73d98ff3d8dbf1288` | Smithery `apple-design` origin and Web templates/references | MIT | **Reject native use:** marketing/portfolio HTML/CSS glassmorphism kit; negative control only. |
| `dickwu/apple-design-skill` `d0bac1e765a27a696839e62962e36330ce72f0b7` | cross-platform reviewer and 53 frozen HIG files | No repository license | **Adapt abstract scope→route→severity→report workflow only.** Do not copy corpus, values, or generic framework substitutions. |
| `sickn33/agentic-awesome-skills` `77a348f816d822b16f6ee9c3d72445ec92f70699` | `ui-ux-designer` target in large catalogue | MIT/CC BY scope split | **Reject:** generic persona, `risk: critical`, missing direct playbook, installer/catalogue surface. |

## Dynamic and mutation boundaries

Never inherit these upstream side effects into normal activation:

- `npx` skill/router/catalogue execution;
- mutable third-party `main` branch imports;
- package/dependency installation;
- Figma creation or updates without an explicit target and request;
- local design-context, plan, brand, or prototype file writes without a requested artifact;
- source deletion during prototype promotion;
- tracing, attaching, launching, signing, notarizing, or packaging from a design-only request;
- upstream `allowed-tools` or MCP permissions.

## Maintenance procedure

1. Recheck current Apple HIG/API behavior first.
2. Diff an upstream only at a new fixed commit.
3. Read the changed `SKILL.md` and every newly routed reference completely.
4. Recheck license, scripts, tools, external URLs, and write/network behavior.
5. Classify each proposed rule as adopt/adapt/verify/reject.
6. Update the smallest relevant reference; do not paste upstream prose.
7. Run the bundled structural check: `python3 scripts/validate_spec.py --template assets/macos-design-spec-template.md`. If `evals/eval.yaml` is present, also run `skill-up validate evals/eval.yaml`; then run applicable local regression or forward tests and record the result.
8. Record the new SHA and decision in the external research archive.
