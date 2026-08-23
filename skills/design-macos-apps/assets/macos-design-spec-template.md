# macOS Design Specification — [Product or Feature]

Status: [Proposed / Build-verified / Rendered / Interaction-verified / Apple-native fit accepted]
Owner: [Name or team]
Updated: [YYYY-MM-DD]

## 1. Context and assumptions

- Mode and requested deliverable: [Design / Review / Implement / Translate]
- Target: [macOS deployment floor, SDK, SwiftUI/AppKit/hybrid]
- App archetype: [Document / Editor / Browser / Data / Utility / Menu bar / Media / Other]
- Evidence inspected: [Files, running build, screenshots, Figma, existing system]
- Non-negotiables: [Task, brand, accessibility, compatibility, data safety]
- Assumptions and unknowns: [Label each]

## 2. Product intent

### Primary user and task

[Who is doing what, how often, and why]

### Design thesis

[One sentence linking task, native structure, and bounded product identity]

### Success criteria

- [Observable outcome]

## 3. Apple reference prototype

- Closest first-party Apple app or system surface: [Name and surface]
- Observed version/source/date: [macOS/app version or URL, YYYY-MM-DD]
- Task similarity and analogy limit: [What transfers and where it stops]

| Reference structure or behavior | Adopt | Adapt for this product | Avoid copying |
| --- | --- | --- | --- |
| [Window/hierarchy/commands/density/behavior] | [Native family resemblance] | [Product-specific decision] | [Pixels/assets/decorative imitation] |

## 4. Platform contract

| Decision area | Must / should / may | Current source and retrieval date | Conclusion |
| --- | --- | --- | --- |
| [Windows / menus / accessibility / …] | [Level] | [Official Apple URL, YYYY-MM-DD] | [Supported claim] |

Unverified platform claims: [None or explicit list and verification method]

## 5. Scene and window model

| Window/scene role | Ownership and state | Open/close/reopen | Resize/collapse | Restoration/multiwindow/full screen |
| --- | --- | --- | --- | --- |
| [Role] | [State owner] | [Behavior] | [Behavior] | [Behavior] |

## 6. Information architecture

[Describe sidebar/list/table/editor/inspector hierarchy, selection, navigation, and search scope.]

```text
[Optional compact tree or flow]
```

## 7. Commands and input

| Action | Scope/enabled condition | Menu | Toolbar/inline/context | Shortcut | Feedback | Undo/recovery |
| --- | --- | --- | --- | --- | --- | --- |
| [Action] | [Scope] | [Placement] | [Placement] | [If warranted] | [Result] | [Path] |

Pointer, focus, selection, drag/drop, and search behavior: [Specify relevant paths]

## 8. Surface specifications

### [Window or surface]

- Purpose and information priority: [Text]
- Default state: [Text]
- Loading/empty/error/offline/permission states: [Relevant states]
- Selection/disabled/read-only/destructive states: [Relevant states]
- Narrow/default/wide behavior: [Text]
- Keyboard/VoiceOver behavior: [Text]

## 9. Visual system

| Role | System/project mapping | Appearance and accessibility behavior | Usage boundary |
| --- | --- | --- | --- |
| [Background/text/fill/selection/accent/material/type/symbol] | [Semantic mapping] | [Light/dark/contrast/transparency/etc.] | [Where/why] |

Custom brand treatments and rationale: [None or documented exceptions]

Liquid Glass decision: [Not used / system-owned / justified custom use + fallback + availability]

## 10. Motion and feedback

| Trigger/frequency | Purpose | Spatial behavior | Interruption/cancel | Reduced-motion equivalent | Performance verification |
| --- | --- | --- | --- | --- | --- |
| [Transition] | [Why] | [Origin/result] | [Behavior] | [Behavior] | [Method] |

Deliberately static high-frequency actions: [List]

## 11. Accessibility and localization

- Full keyboard path and focus return: [Text]
- VoiceOver role/name/value/order/actions: [Text]
- Light/dark, Increased Contrast, Reduce Transparency, Reduce Motion: [Text]
- Text scaling, localization expansion, formats, and RTL: [Text]
- Destructive safety and recovery: [Text]

## 12. SwiftUI/AppKit mapping

| Design intent | Native API/component | State owner | Deployment availability | Fallback | AppKit gap if any |
| --- | --- | --- | --- | --- | --- |
| [Intent] | [Mapping] | [Owner] | [Verified range] | [Usable fallback] | [Named gap or none] |

## 13. States and edge cases

- [State, expected behavior, and verification]

## 14. Runtime screenshot matrix

Evidence source: actual launched `.app` only; Figma, generated mockups, and SwiftUI previews cannot fill a runtime cell. Keep one row per cell. Replace width rows only for a justified fixed-size utility or menu-extra role.

| Width/role | Appearance | Activation | Data/state | Target/macOS/scale | Exact artifact path | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Minimum usable | Light | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Default | Light | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Wide | Light | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Minimum usable | Dark | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Default | Dark | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Wide | Dark | Active | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Default | Light | Inactive | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |
| Default | Dark | Inactive | [State] | [Build/system/scale] | [PNG path] | [Pending/observed] |

Affected critical states and appearance preferences: [Additional cells or justified N/A]

## 15. Interaction verification record

Do not merge Observed, Evidence, or Status. For an unrun path, use `not run`, `none—no runnable target`, and `pending` respectively.

| Path/command | Input | Expected | Observed | Evidence | Status |
| --- | --- | --- | --- | --- | --- |
| Primary workflow | [Pointer/keyboard] | [Result] | [Actual result] | [Log/video/UI test] | [Pass/fail/pending] |
| Menu/toolbar/context equivalence | [Input] | [Result] | [Actual result] | [Evidence] | [Status] |
| Keyboard/focus/default/cancel | [Input] | [Result] | [Actual result] | [Evidence] | [Status] |
| Resize/collapse/restoration | [Input] | [Result] | [Actual result] | [Evidence] | [Status] |
| Undo/recovery | [Input] | [Result] | [Actual result] | [Evidence] | [Status] |
| Drag/drop or multiwindow scope | [Input or N/A] | [Result] | [Actual result] | [Evidence] | [Status/rationale] |
| Live appearance/accent/accessibility change | [System setting] | [Result] | [Actual result] | [Evidence] | [Status] |
| Repeated or long-running path responsiveness | [Input/load] | [Responsive result, progress/cancel/recovery] | [Actual result] | [Evidence/measurement] | [Status] |

## 16. Verification and completion status

| Gate artifact | Required scope | Status | Evidence/blocker |
| --- | --- | --- | --- |
| Apple reference prototype | [Scope] | [Complete/pending] | [Evidence] |
| Runtime screenshot matrix | [Applicable cells] | [Complete/pending/blocked] | [Paths/blocker] |
| Interaction verification record | [Applicable rows] | [Complete/pending/blocked] | [Paths/blocker] |

Manual checks remaining: [List]

Completion statement: [Highest honest verification level; use “Apple-native fit accepted” only when all three gate artifacts pass]

## 17. Sources and open risks

- [Official source URL] — retrieved [YYYY-MM-DD] — supports [narrow conclusion]
- [Open risk, owner/decision, verification]

Intentional exceptions: [None or rationale, impact, and acceptance]
