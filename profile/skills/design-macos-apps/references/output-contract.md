# Output contracts

Choose one primary deliverable. Add sections only when they affect the decision.

## Compact decision brief — default

Use this for a bounded design question, local change, or early product decision. Keep it implementation-ready without expanding into a full specification:

1. **Outcome** — one recommendation and the task it improves.
2. **Evidence and assumptions** — only artifacts actually inspected; label missing runtime/Figma/API evidence.
3. **Apple reference prototype** — closest first-party surface and an adopt/adapt/avoid map with evidence date and analogy limits.
4. **Mac model** — scene/window role, state ownership, information structure, and command/input path.
5. **Affected states** — realistic default plus only relevant non-happy states, each with recovery.
6. **Native mapping** — likely SwiftUI/AppKit components, deployment/fallback, and named capability gaps.
7. **Acceptance evidence** — three visibly labeled artifacts with statuses: the adopt/adapt/avoid reference map, applicable runtime screenshot cells, and interaction rows with expected/observed/evidence fields. Use explicit compact tables; prose reminders are insufficient. Evidence is either observed with exact paths or explicitly pending.
8. **Verification** — highest level actually reached, remaining checks, and the smallest next step.

For multiwindow or focused-command work, include a compact state-owner table. For version-sensitive claims, include the exact source/date or mark the claim unverified. Do not add sections merely to appear comprehensive.

## Full design specification — explicit request only

Return or write:

1. **Outcome and design thesis** — one recommended direction and why it fits the task.
2. **Context and assumptions** — mode, platform/deployment, framework, archetype, evidence, constraints, unknowns.
3. **Apple reference prototype** — observed first-party surface, adopt/adapt/avoid map, limits, and evidence date.
4. **Platform contract** — current Apple sources and verified requirements/defaults.
5. **Scene and window model** — roles, ownership, resize, restoration, multiwindow/full-screen behavior.
6. **Information architecture** — sidebar/list/table/editor/inspector hierarchy and selection.
7. **Commands and input** — menu, toolbar, context, shortcut, pointer, focus, search, drag/drop, undo.
8. **Surface specifications** — realistic content and all relevant states.
9. **Visual system** — semantic color/type/material/symbol/density/brand roles.
10. **Motion and feedback** — purpose, frequency, interruption, reduced-motion behavior.
11. **Accessibility and localization** — keyboard, VoiceOver, preferences, text, RTL/expansion.
12. **SwiftUI/AppKit mapping** — native components, state ownership, capability gaps, availability/fallback.
13. **Runtime screenshot matrix** — state that only an actual launched `.app` can supply evidence; use one unmerged row for each required width/appearance/activation cell plus affected states, each with target metadata, exact evidence path, and status.
14. **Interaction verification record** — use separate Path/command, Input, Expected, Observed, Evidence, and Status columns for required command/input/window/recovery paths.
15. **Verification and completion status** — highest level, blockers, manual gaps, and whether the Apple-native fit gate passed.
16. **Sources and risks** — URLs/dates, unverified claims, exceptions, open decisions.

Use [macos-design-spec-template.md](../assets/macos-design-spec-template.md) for a durable artifact.

## Review report

Lead with evidence coverage and conclusion. Then use:

| Severity | Status | Evidence | Contract/default | User impact | Smallest correction | Verification | Source/date |
| --- | --- | --- | --- | --- | --- | --- | --- |

Separate confirmed findings, inferred risks, and optional opportunities. Do not mix praise into every finding; include positive notes only when they preserve an intentional behavior or prevent unnecessary churn.

For Apple-native fit or release approval, inventory the reference prototype, every applicable screenshot matrix cell, and every interaction verification row before issuing the verdict. Missing or planned evidence cannot be silently treated as passed. Do not combine screenshot cells or the Observed/Evidence/Status interaction fields merely to shorten the answer.

Every actual finding must include user impact and the smallest correction. If either is unknown, report a verification question rather than a defect.

## Implementation plan

Return:

- approved design decision and scope;
- files/surfaces to change;
- scene/view/command/state mapping;
- system component choices and any justified custom/AppKit gap;
- API availability and functional fallback;
- ordered implementation slices with acceptance checks;
- build/render/runtime/accessibility/performance verification;
- Apple reference prototype plus the applicable runtime screenshot and interaction acceptance artifacts;
- intentionally untouched areas and remaining manual checks.

Do not turn a design implementation plan into signing, packaging, dependency, or architecture migration work unless requested.

## Translation handoff

Use an intent mapping table:

| Source element | Intended job | Mac-native component/scene | Command/input behavior | Semantic visual mapping | Intentionally discarded | Verification |
| --- | --- | --- | --- | --- | --- | --- |

Then include window/state diagrams, component variants, accessibility/runtime annotations, and SwiftUI/AppKit/Figma boundaries as needed.

## Direction comparison

Use:

| Direction | Task fit | Mac interaction model | Hierarchy/density | Brand/material posture | Accessibility/compatibility risk | Implementation risk |
| --- | --- | --- | --- | --- | --- | --- |

Recommend one. Do not make the user infer the decision from equal-weight alternatives.

## Decision record

For a small feature, a full specification may be excessive. Return:

```text
Context and assumption:
Decision:
Why this Mac pattern:
Rejected alternative:
Visual/motion behavior:
Native implementation mapping:
Accessibility/compatibility checks:
Evidence and source date:
Open risk:
```

## Quality rules for every output

- Lead with the recommended outcome.
- Use exact local evidence and current first-party sources.
- Label assumptions and unverified claims.
- State what not to carry over from iOS/Web references.
- Distinguish must/should/may.
- Avoid false numerical precision.
- Report verification actually performed.
- Never report Apple-native fit accepted without the reference prototype, complete applicable runtime screenshot matrix, and passed relevant interaction record.
- End with the smallest meaningful next step, not a generic checklist.
- Prefer the compact contract unless the user explicitly requests a durable full specification.
