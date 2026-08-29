# Evidence-backed Mac UI audit

Use this method for screenshots, running apps, Figma frames, previews, or code-backed UI review. Diagnose and report; do not patch unless implementation is requested.

## Define audit scope

Record:

- product task and user;
- target macOS/deployment floor and framework;
- window/surface/state under review;
- artifacts available: running app, screenshots, Figma, previews, source;
- requested depth: focused question, surface audit, flow audit, or release gate;
- areas explicitly out of scope.

Do not audit an entire repository when the user asks about one surface.

After the first evidence pass, state the provisional verdict and evidence gaps. Do not defer the report while exhaustively reading neighboring views or unrelated Apple guidance.

## Inspect runtime surfaces first

Follow the real path from scene/window to rendered view:

1. Identify scene and window role.
2. Identify navigation, selection, focus, and command ownership.
3. Reproduce or inspect the relevant state.
4. Capture visible evidence and scope.
5. Read the nearest source/tokens only to explain cause and correction.

Distinguish:

- **observed:** visible or reproducible behavior;
- **source-confirmed:** implementation explains the behavior;
- **inferred:** likely but not reproduced;
- **unknown:** requires another state, setting, OS, or tool.

## Audit lenses

Apply only relevant lenses, in this priority:

1. task completion, data safety, and recovery;
2. accessibility and user preferences;
3. Mac scene/window/command/keyboard/pointer behavior;
4. information architecture, hierarchy, selection, and state;
5. visual roles, material, type, symbols, and brand coherence;
6. motion, feedback, and measured performance;
7. polish.

Open current Apple guidance for any issue presented as a platform violation.

## Finding proof gate

Report a defect only when the finding has:

- **Contract:** current platform/API rule, explicit product requirement, or established project behavior.
- **Runtime:** what happens, where, in which state, and with what user impact.
- **Correction:** the smallest change that satisfies the contract without collateral redesign.

If runtime evidence is absent, a source-observable issue can be source-confirmed, but its unseen visual or interaction consequence remains inferred. Do not convert a proposal or code path into a confirmed runtime defect.

Then try to disprove it:

- Is it deliberate and documented?
- Is another state or command path handling it?
- Is the screenshot stale or unrepresentative?
- Is the system component adapting automatically?
- Is the issue actually a suggestion rather than a violation?
- Does the proposed correction break another platform, state, or deployment target?

Downgrade to suggestion or unknown when the proof gate fails.

## Finding format

```text
Severity: blocker / high / medium / polish
Status: confirmed / inferred / suggestion / needs runtime verification
Evidence: file:line, screenshot region, window/state, reproduction
Contract: current source or explicit project requirement
User impact:
Smallest correction:
Verification:
Source URL and retrieval date:
```

Prioritize a small set of high-confidence findings. Do not generate filler to reach a quota. Group repeated manifestations under one root cause and list the affected surfaces.

Before finalizing, check every confirmed or inferred finding for all four fields: scoped evidence, user impact, smallest correction, and verification. If a field is absent, complete it or reclassify the item as unknown/suggestion. Do not let a verification plan silently substitute for a correction.

## Severity

- **Blocker:** essential task unavailable, data/control at risk, inaccessible path, input trap, or fundamental platform contract failure.
- **High:** substantial recurring friction, confusing command/window behavior, unreadable state, or major recovery/accessibility gap.
- **Medium:** bounded inconsistency or inefficiency with a viable workaround.
- **Polish:** optional craft refinement without material task/accessibility impact.

Severity follows user impact and recurrence, not visual conspicuousness.

## Review output

Lead with the result:

1. concise overall assessment and evidence coverage;
2. confirmed findings in severity order;
3. inferred risks and how to verify them;
4. optional design opportunities separated from defects;
5. what already works well when it affects the decision;
6. validation plan and remaining unknowns.

For each finding, cite local files with precise links/lines when possible and current first-party sources near platform claims.

## Specialized audits

### Window/chrome

Check role/title, standard controls, drag, resize, restoration, activation, full screen, toolbar/menu equivalence, inactive state, and multiple windows.

### Command system

Check menu organization, action identity, validation, active-window/selection scope, toolbar/context/keyboard discovery, shortcuts, and undo.

### Visual/material

Check semantic roles, light/dark, contrast/transparency, content-versus-functional layer, custom-control justification, system symbol/type behavior, and brand consistency.

### Motion

Check purpose, frequency, spatial origin, interruption, reduced-motion equivalent, and runtime performance evidence.

### Accessibility

Check keyboard path, focus indication/return, VoiceOver name/role/value/order/actions, state announcements, appearance preferences, text/localization, and destructive recovery.

### Translation

Check preserved product intent, discarded iOS/Web assumptions, Mac-native scene/command/input mapping, and semantic rather than pixel token mapping.

## Audit anti-patterns

- declaring HIG compliance from code alone;
- treating every community checklist item as a defect;
- reporting fixed spacing/timing/style preferences as Apple rules;
- confusing CSS/ARIA findings with native accessibility implementation;
- recommending glass, animation, or custom controls as generic polish;
- redesigning unrelated surfaces while fixing a bounded issue;
- omitting runtime and deployment uncertainty;
- burying blockers under dozens of cosmetic notes.
