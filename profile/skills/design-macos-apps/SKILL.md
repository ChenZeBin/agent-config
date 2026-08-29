---
name: design-macos-apps
description: Design, review, translate, or implement the user-facing UI and interaction layer of native macOS apps, including evidence-backed Apple-native visual fit. Use for Mac windows/scenes, navigation, menus and commands, keyboard/pointer behavior, SwiftUI/AppKit UI structure, Figma-to-Mac translation, visual direction, materials, accessibility, Apple HIG or release-readiness review, runtime screenshot and interaction acceptance, and claims about whether source/build evidence proves rendered, interaction, accessibility, or Apple-native behavior. Do not use for non-UI Swift work, data/storage/network code, build or CI failures, package management, iPhone/iPad-only design, or Web/Electron styling with no native macOS interaction decision.
---

# Design native macOS apps

Produce the smallest evidence-backed artifact that moves a native Mac product forward. Prefer a useful decision, review, handoff, or working change over an exhaustive essay.

## Route before researching

1. Confirm that the task contains a user-facing macOS decision. If it is only Swift logic, persistence, networking, build tooling, CI, or packaging, do not load design references; solve that task normally.
2. Choose one primary mode: **design**, **review**, **implement**, or **translate**. Treat secondary needs as follow-ups instead of running every mode.
3. Choose depth:
   - **Quick** is the default for a bounded question, local UI change, focused review, or small implementation.
   - **Full** is for a new product/surface, a release audit, or an explicitly requested durable specification.
4. If the bounded prompt and supplied evidence can be resolved from this file, inspect the artifacts and answer without opening any reference. Otherwise start with only the primary reference below. Enforce a hard cap: **Quick = no reference unless blocked; Full = one primary plus at most one optional reference**. Never combine several reference reads in one command or preload the reference set.

| Mode | Initial reference | First useful artifact |
| --- | --- | --- |
| Design | [macos-platform.md](references/macos-platform.md) | Recommended Mac structure and a compact decision brief |
| Review | [audit-method.md](references/audit-method.md) | Verdict, evidence coverage, and prioritized findings; remain read-only |
| Implement | [implementation-mapping.md](references/implementation-mapping.md) | Scoped decision, smallest patch, and actual verification |
| Translate | [figma-handoff.md](references/figma-handoff.md) | Preserve/replace/discard intent map and Mac-native handoff |

## Work to a delivery budget

- Inspect the supplied workspace, images, running surface, or Figma evidence before external research. When local files exist, this evidence pass is mandatory: locate the smallest relevant set with `rg --files`/targeted search, read each selected artifact once with a bounded read, and cite its path in the evidence manifest. Do not answer only from the prompt's paraphrase, and do not widen the scan after the decision is supported. Record only the 3–8 artifacts that materially affect the decision.
- For a quick evidence-boundary question—such as whether a build proves visual or VoiceOver behavior—use the verification ladder in this file and do not load a domain reference.
- Produce a provisional outcome after the first evidence pass. Do not postpone delivery until every HIG page, API, or reference has been read.
- Research a current first-party Apple source only for a normative **must**, a version/API claim, a disputed platform behavior, or a release-facing conclusion. Query the exact issue; do not browse the HIG broadly.
- Classify source access as **live**, **supplied-offline**, or **unavailable**. Date live/offline evidence. When unavailable, mark the exact claim unverified and choose a stable system-first fallback.
- Stop gathering when the decision, smallest correction, and verification path are supportable. If a blocker remains, name it instead of expanding the entire task.
- Do not open [source-provenance.md](references/source-provenance.md) during normal product work; it is maintenance evidence only.

For a non-abstract task, keep a compact evidence manifest in the output or working notes:

| Artifact actually inspected | Decision it supports | Missing/uncertain evidence |
| --- | --- | --- |

If a supplied image, Figma file, running app, or target cannot be accessed, say so and downgrade the affected conclusion instead of inventing its contents.

## Establish the Mac contract

Lead with the outcome, then make these relationships explicit when relevant:

### State ownership

For multiwindow, document, selection, search, inspector, or focused-command work, include:

| State | Owner | Lifetime/restoration | Command/focus scope |
| --- | --- | --- | --- |
| Example: selected records | Per library window | Restore per window when useful | Active/focused window only |

Shared model data does not imply shared selection or presentation state. Identify what is per-window, per-document, app-wide, persisted, transient, and derived.

### Command and input model

Give each important action one semantic identity across the appropriate menu, toolbar, context, inline, keyboard, and drag/drop paths. Do not require every action on every surface. Define enabled scope, focus/selection ownership, feedback, undo or recovery, and an accessible alternative to gesture- or hover-only behavior.

### Platform fit and responsiveness

Choose product-relevant system capabilities that remove work or preserve expectations, such as standard open/save panels, Share or Services, Quick Look, Spotlight, passkeys or Touch ID, notifications, drag/drop, and continuity features; do not bolt them on as a checklist. Define how the UI responds live to appearance, accent, accessibility, and input-setting changes. Keep scrolling, typing, selection, and window resizing responsive, and give long operations visible progress, cancellation, and recovery instead of blocking the interface.

### Critical states

For a new or substantially redesigned surface, specify realistic content plus the default state and at least three task-relevant non-happy states. For a local change, cover only affected states. Use:

| State and trigger | Visible response | Recovery/next action | Verification |
| --- | --- | --- | --- |

Choose from empty, loading, partial, error, offline, permission, disabled, read-only, selection, destructive, conflict, interrupted, or restored states based on the product—not as a generic checklist.

### Evidence boundary

Distinguish **observed**, **source-confirmed**, **inferred**, **unverified**, and **optional** claims. Never call unrendered code visually correct, a build accessibility-tested, or a proposal a confirmed runtime defect.

## Gate Apple-native fit

Apply this completion gate to a new or substantially redesigned surface, an implementation that changes visible UI, and any review or claim that an app looks or behaves Apple-native. For a bounded local change, scope the artifacts to the affected surface and cells; never use a local pass to certify the whole app.

### 1. Apple reference prototype

Name one closest first-party Apple app or system surface plus the relevant Mac archetype. Record the observed macOS/app version or source and date, the task-level similarity, and where the analogy stops. Return a compact **adopt / adapt / avoid** map covering window structure, information hierarchy, command placement, density, and behavior. Borrow family resemblance and platform conventions, not pixels, private assets, fixed measurements, or decoration. If the current reference cannot be inspected, mark it unverified; a remembered screenshot is not evidence.

### 2. Runtime screenshot matrix

Capture the actual launched target—not Figma, a generated mockup, or a SwiftUI preview. For every resizable primary window, the core matrix is **minimum usable / default / wide × light / dark**, plus **active / inactive at default width** in both appearances. Add affected critical states and Increased Contrast or Reduce Transparency when custom color/material behavior makes them relevant. Record the target build, macOS version, display scale, data/state, and exact artifact path for every cell. For a fixed-size utility or menu extra, replace width cells only with its supported compact/expanded/window roles and document the reason.

Make the evidence boundary visible immediately above the matrix: **Evidence source: actual launched `.app` only; Figma, generated mockups, and SwiftUI previews cannot fill a runtime cell.** For a resizable primary window, use one row per acceptance cell—six active rows for minimum/default/wide × light/dark, then two inactive rows for default × light/dark. Do not collapse widths, appearances, or activation states into slash-separated cells. Use the unmerged columns **Window/state | Width | Appearance | Activation | Build/macOS/scale | Evidence path | Status**. When no runnable target exists, return all eight rows with `none—no runnable target` as evidence and `pending` as status.

### 3. Interaction verification record

Exercise the actual launched target and record **path or command → input → expected → observed → evidence**. Cover the primary workflow and the relevant menu/toolbar/context equivalence, keyboard and focus path, default/cancel behavior, resize/collapse, restoration, undo/recovery, and drag/drop or multiwindow scope. Also cover live system-setting changes and responsiveness of repeated or long-running paths when they affect the surface. Mark a path `N/A` only with a product reason. A planned test, source inspection, build, screenshot, or animation mockup is not interaction verification.

Use the literal, unmerged columns **Path/command | Input | Expected | Observed | Evidence | Status**; never combine observed, evidence, or status. In a pending proposal, still provide concrete inputs and expected results, then write `not run`, `none—no runnable target`, and `pending` in the final three columns. A list of intended tests is not the required record.

### Completion rule

The three artifacts are mandatory acceptance deliverables. Only report **Apple-native fit accepted** when the reference map is complete, every applicable screenshot cell contains observed runtime evidence, relevant interaction rows passed, and no unresolved blocker contradicts the claim. If launch or interaction is unavailable, still return the pending matrix/record, identify the blocker, and stop at the highest honest verification level; do not call the app finished, visually verified, or Apple-native accepted.

Before sending, visibly label all three artifacts and give each one a status. A prose sentence saying that screenshots or tests are needed does not satisfy the deliverable. In a proposal with no runnable target, include at minimum: an explicit adopt/adapt/avoid reference map; the eight-row runtime matrix and its evidence-source rule; and the six-column interaction record with applicable command, keyboard/focus, window/restoration, and undo/recovery rows. End with a separate **Completion status** line. Compress other explanation before omitting this gate when the user imposes a tight length limit.

## Execute by mode

### Design

Return a compact decision brief by default: outcome; Apple reference prototype; scene/window and state-owner model; information/command structure; critical states; visual posture; native mapping; evidence and next verification. Explore two or three directions only when the direction is genuinely open; recommend one. For a new or substantially redesigned surface, include the required runtime screenshot matrix and interaction record as observed evidence or explicitly pending acceptance artifacts. Use a full specification only when explicitly requested, starting from [macos-design-spec-template.md](assets/macos-design-spec-template.md) and [output-contract.md](references/output-contract.md).

For a `MenuBarExtra` or agent-style utility, explicitly decide: which app-level object owns a long-running task after the popover closes; what belongs in the popover, main window, and Settings; whether activation/Dock presence is a justified product tradeoff; when a user action initiates permission; and how denial, revocation, device loss, storage failure, offline work, relaunch, and crash recovery behave.

### Review

Keep the workspace unchanged. Lead with release/design verdict and evidence coverage. For every finding include:

Before any Apple-native fit analysis, print the exact inspected evidence paths. This traceability line is non-negotiable and has priority over optional explanation or gate detail.

When the requested verdict includes Apple-native visual fit or release acceptance, audit all three gate artifacts. Reject or narrow approval when the reference is untraceable, screenshot cells are absent, or interaction rows are planned rather than observed; name the exact missing cells and paths.

When local evidence is supplied, begin the evidence coverage with the exact paths actually inspected (for example, `evidence/build.log` and `Sources/App/MainView.swift`). Keep this path list even in a quick review; a generic phrase such as “the source” or “the build log” is not traceable evidence.

For a quick evidence-boundary review, use this compact contract and include every line: **Verdict → Evidence inspected (exact paths) → What that evidence proves → What remains unknown → Smallest next verification**. Do not replace the path line with a generic summary.

```text
Severity and status:
Observed evidence and scope:
Contract or project requirement:
User impact:
Smallest correction:
Verification:
```

Separate confirmed findings, inferred risks, unknowns, and optional opportunities. Try to falsify each issue by checking existing menu paths, other states, platform adaptation, and product intent. Do not manufacture findings to fill a quota.

Before sending, apply a completeness gate to every confirmed or inferred finding: it must contain scoped evidence, user impact, the smallest correction, and a verification method. Add the missing field or downgrade the item to an unknown/question. A missing test is usually a verification gap, not a defect with an invented correction. The primary audit reference already covers command and accessibility triage; do not load their detailed references unless the user asks for a domain-specific correction or test plan that the audit reference cannot supply.

### Implement

Locate the actual target/scheme, scene, command wiring, state owner, affected files, and existing verification path. State the bounded decision, make the smallest authorized edit, and build the relevant target early. Research only an API/availability blocker. Then launch the actual target and complete the applicable screenshot matrix and interaction record. If the environment prevents launch or input, report **build-verified, runtime blocked/pending** and do not claim completion or Apple-native acceptance. Never hide a visual redesign or architecture migration inside a small fix.

For launch logs or captures, create a fresh task-specific temporary path; do not pre-delete or reuse a broad/shared path merely to prepare verification.

### Translate

Map every source element by intended job, not pixels. Explicitly mark **preserve**, **replace**, or **discard**, then anchor the result to one Apple reference prototype with an adopt/adapt/avoid map. Replace phone navigation, safe-area spacing, universal touch targets, swipe-only actions, and bottom sheets with appropriate Mac scenes, windows, sidebars/tables/inspectors, commands, keyboard paths, and resizable behavior. Treat Figma as a semantic handoff; mutate it only when explicitly requested with a target file. Translation is proposed until the runtime screenshot matrix and interaction record are completed on the target app.

## Load optional depth only for a named need

| Named need | Optional reference |
| --- | --- |
| Normative claim, API/version, source conflict | [authority-and-evidence.md](references/authority-and-evidence.md) |
| Complex menu, keyboard, pointer, focus, search, drag/drop, undo | [interaction-input.md](references/interaction-input.md) |
| Color, type, symbols, density, brand, materials, Liquid Glass | [visual-system.md](references/visual-system.md) |
| Genuinely open visual direction | [direction-workshop.md](references/direction-workshop.md) |
| Custom motion or direct manipulation | [motion.md](references/motion.md) |
| Detailed custom-control semantics or an actual keyboard/VoiceOver/preference test plan | [accessibility-qa.md](references/accessibility-qa.md) |

## Report verification honestly

Use the highest level actually reached:

1. **Proposed** — design reasoning only.
2. **Source-inspected** — relevant code/artifacts read.
3. **Build-verified** — target compiled or tests ran.
4. **Rendered/launched** — changed surfaces were seen in the target environment.
5. **Interaction-verified** — window, command, keyboard/pointer/focus, resize/restoration, and recovery paths were exercised as relevant.
6. **Accessibility/performance-verified** — applicable assistive settings/technologies or measurements were actually tested.

State remaining checks and the smallest next step. **Apple-native fit accepted** is a separate acceptance statement that additionally requires the Apple reference prototype and complete applicable runtime screenshot matrix; it is not implied by any one ladder level. A structural validator is only a lint; it never proves design quality or HIG compliance.

## Resolve conflicts

Use this order: current Apple platform/API contract; accessibility, safety, and user control; native Mac behavior; explicit product task and audience; established project system/brand; contextual craft; author taste and copied numeric recipes. Use **must** only for verified contracts or explicit requirements, **should** for strong defaults with exceptions, and **may** for optional craft.

## Reject false shortcuts

- Do not equate Apple design with glassmorphism, rounded cards, large whitespace, or blue gradients.
- Do not equate a Swift, SwiftUI, or AppKit codebase with accepted native fit. Framework choice can inherit useful behavior, but only observed window, command, input, system-setting, responsiveness, and recovery behavior closes the gate; mix SwiftUI and AppKit where the product contract requires it.
- Do not import bottom tabs, phone safe areas, bottom sheets, one-handed layouts, or universal 44-point touch targets into Mac design.
- Do not use CSS, DOM, Tailwind, ARIA, Framer Motion, `backdrop-filter`, or browser performance rules as native implementation guidance.
- Do not draw fake traffic lights or replace standard window behavior for visual imitation.
- Do not mandate fixed grids, radii, colors, fonts, durations, shortcuts, context menus, or animation without product and platform evidence.
- Do not place Liquid Glass throughout content. Prefer system controls/navigation; require a functional role, verified availability, and usable fallback for custom glass.
- Do not silently run installers, registries, Figma mutations, tracing, signing, packaging, or unrelated build scripts.
