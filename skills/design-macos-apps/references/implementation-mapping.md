# SwiftUI and AppKit mapping

Use this reference after the product, scene, and interaction decisions are approved. Do not let a convenient API choose the design.

## Fast implementation loop

For a bounded authorized change:

1. Locate the actual target or scheme, scene, affected view/commands, state owner, and existing test/build command.
2. State the one UI decision and the files expected to change.
3. Patch the smallest coherent slice before opening broad design references.
4. Build immediately; use the first compiler or test result to guide the next edit.
5. Research only an exact API/availability blocker. Prefer an existing system control or stable fallback when current evidence is unavailable.
6. Render or launch the affected surface when feasible, then exercise only the changed window/command/input/recovery paths.
7. Report the highest verification level reached. Call compilation **build-verified**, never visually or accessibility verified.

Do not spend the implementation window proving every surrounding design choice before making the requested edit.

## Establish implementation context

Inspect and record:

- macOS deployment floor and current build SDK;
- Swift language/toolchain and project architecture;
- SwiftUI, AppKit, Catalyst, or hybrid target;
- existing scenes, commands, state ownership, design tokens, and accessibility conventions;
- whether the task authorizes code changes or only an implementation plan.

Search the installed SDK or current first-party docs for exact availability and signatures. Community examples are not evidence of availability.

## Intent-to-SwiftUI map

| Design intent | Likely native starting point | Verify/contextualize |
| --- | --- | --- |
| Multiple equivalent windows | `WindowGroup` | Per-window versus shared state, restoration, open-window behavior. |
| Distinct single-role window | `Window` or supported utility scene | Deployment availability, reopen/activation, Window menu behavior. |
| File-backed document workflow | `DocumentGroup` | Document model, autosave, commands, error/conflict handling. |
| App preferences | `Settings` | App-wide scope and platform availability. |
| Persistent menu-bar access | `MenuBarExtra` | Menu/window style, Dock/app-switcher policy, termination behavior. |
| Sidebar/list/detail hierarchy | `NavigationSplitView` | Selection model, column collapse, search placement, window width. |
| Comparable structured data | `Table` or outline/list strategy | Column behavior, sorting, multi-selection, scale/performance. |
| Adjacent resizable work areas | Native split view containers | Collapse, sizing, restoration, focus. |
| Frequent window actions | `.toolbar`, `ToolbarItem`, system placements | Menu equivalents, customization, overflow, availability. |
| App/domain commands | `Commands`, scene `.commands`, focused values/actions | Standard placement, validation, active-window scope, shortcut conflicts. |
| Search | `.searchable` and current search APIs | Corpus/scope, placement, tokens, availability, narrow behavior. |
| Inspector/properties | Current SwiftUI inspector/presentation APIs or auxiliary window | Deployment floor, persistence, context, content width. |
| Context actions | `.contextMenu` and command identity | Object/selection scope and alternative discovery path. |
| Drag/drop | Current transferable/drag/drop APIs | Data representation, cross-app behavior, errors, undo. |
| Accessibility | Native labels, values, traits, actions, focus, environment preferences | Runtime VoiceOver/keyboard behavior. |

This table is a starting map, not a guarantee that each API exists at every deployment floor.

## State ownership

- Keep per-window state inside the scene/window boundary.
- Keep app-wide state explicit and shared intentionally.
- Give selection, focus, search, inspector visibility, and presentation clear owners.
- Use the observation model already supported by the project and deployment floor; do not migrate architecture solely for a design change.
- Keep stable identity for list/table rows and avoid deriving identity from mutable presentation state.
- Split large views along real ownership, layout, performance, or accessibility boundaries—not arbitrary line counts.

## System-first implementation order

1. Implement the scene and window roles.
2. Implement native navigation/content containers and selection.
3. Establish commands/menu behavior and toolbar discovery.
4. Add settings, inspectors, context menus, search, drag/drop, and file/undo behavior as needed.
5. Apply semantic visual roles and accessibility.
6. Add custom material/motion only after the standard behavior is correct.
7. Render and exercise all relevant states.

## Liquid Glass and materials

- Let current system controls and chrome adopt the platform design automatically.
- Use custom `glassEffect`-family APIs only after verifying availability in the target SDK and deployment range.
- Apply effect modifiers in the order required by current API documentation.
- Use containers only for a related nearby cluster that shares sampling/morphing behavior.
- Give morphing elements stable, intentional identity where the current API supports it.
- Use interactive glass only for actual interactive targets.
- Keep a system-material or non-glass fallback that preserves hierarchy and operation.
- Measure complex or numerous effects in the running app.

Never copy `#available(iOS …)` into macOS code. Write platform-aware checks for the actual API and target.

## AppKit gap test

Before introducing AppKit, write:

```text
Required behavior:
Why current SwiftUI cannot express or reliably deliver it:
Smallest AppKit capability needed:
State owner:
Bridge lifecycle and delegate boundary:
Fallback or removal path:
Runtime tests:
```

Reasonable gaps can include specialist `NSWindow`/`NSPanel` behavior, responder-chain/menu validation, advanced text editing, file-panel edges, or a specific native control unavailable in SwiftUI.

Choose the narrowest boundary:

- `NSViewRepresentable` for one AppKit view;
- `NSViewControllerRepresentable` for a controller-owned lifecycle;
- a focused window hook/coordinator for window properties;
- a small AppKit-owned surface only when its whole role depends on AppKit.

Keep observable domain state outside the bridge. Let the coordinator own delegates and imperative lifecycle. Prevent update loops, duplicate targets/observers, stale bindings, and leaked callbacks.

Do not rewrite a whole SwiftUI screen to solve one capability gap.

## Review versus implementation authorization

- For a review request, inspect and report; do not patch files.
- For a design request, provide semantic mapping and pseudocode only if useful.
- For an implementation request, make the smallest scoped change after stating the design decision.
- Do not invoke tracing, package installation, signing, notarization, Figma mutation, or unrelated refactoring automatically.

## Implementation verification

Run checks proportionate to the change:

- build the relevant target;
- render previews or deterministic sample states;
- launch the foreground `.app` for window/chrome/activation checks;
- resize and restore windows;
- exercise menu, toolbar, keyboard, pointer, focus, selection, search, and drag/drop paths;
- test light/dark and relevant accessibility preferences;
- check the deployment floor or an appropriate runtime;
- use Instruments/trace evidence for hitches or large/high-frequency surfaces.

Report what actually ran. Keep manual checks explicit when the environment cannot close them.

Use this evidence ladder in the handoff: source-inspected → build-verified → rendered/launched → interaction-verified → accessibility/performance-verified. Never collapse skipped levels into “done.”

## Code review red flags

- iPhone navigation or touch assumptions at the Mac root;
- global selection shared accidentally by all windows;
- toolbar-only commands with no menu path;
- custom titlebar without title, drag, or standard window behavior;
- hardcoded colors/font sizes replacing semantic roles;
- Web blur/timing recipes translated literally;
- new API without deployment guard and usable fallback;
- AppKit bridge owning a second copy of application state;
- visual approval from source code without rendering;
- broad architecture migration hidden inside a design fix.
