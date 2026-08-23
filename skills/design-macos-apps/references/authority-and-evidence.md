# Authority and evidence

Use this reference whenever a decision is presented as Apple guidance, depends on an OS/API version, or is based on a screenshot/code audit.

## Source precedence

1. Current first-party Apple HIG and API documentation.
2. Accessibility settings, user control, data safety, and explicit product requirements.
3. Observed runtime behavior on the supported macOS/SDK combination.
4. Established native macOS conventions and the project's shipped design system.
5. Community skills, talks, examples, and author heuristics.

Never use repository stars, install counts, polished prose, or an Apple-themed name as evidence of authority.

## Live HIG lookup protocol

1. Identify the exact platform, component, input, pattern, and foundation involved.
2. Decide whether the claim needs live research. Stable product recommendations can remain recommendations; only normative, version/API, disputed, or release-facing claims require current authority.
3. Open the one exact first-party HIG or API page that can settle the claim rather than reading a broad category or cached community summary.
4. If the page is unavailable, use supplied dated first-party evidence when present. Treat undocumented JSON endpoints and search-result snippets as best-effort discovery only, never as a guaranteed fallback or authority by themselves.
5. When no current source is reachable, mark only the affected claim **unverified**, avoid a new version-sensitive dependency, and keep a stable system-first fallback. Continue the useful product decision instead of turning the whole answer into a research failure.
6. Record the page URL, retrieval date, target platform/version, and the conclusion actually supported.
7. Recheck immediately before release-facing advice when an SDK, design system, or deployment target has changed.

## Source-access states

| State | Safe behavior |
| --- | --- |
| **Live** | Cite the current exact Apple page and date; keep the conclusion no broader than the source. |
| **Supplied-offline** | Identify the artifact and date/version; use it for the bounded task without implying freshness. |
| **Unavailable** | Mark the exact claim unverified, choose a stable fallback, and list the smallest later check. |

Do not repeatedly retry a failing source or browse unrelated HIG pages. One exact platform source and, when necessary, one exact API source are normally sufficient for a single decision.

## Official starting points

### macOS structure and interaction

- Designing for macOS: https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/
- Windows: https://developer.apple.com/design/human-interface-guidelines/windows
- Layout: https://developer.apple.com/design/human-interface-guidelines/layout
- Menu bar: https://developer.apple.com/design/human-interface-guidelines/the-menu-bar
- Menus: https://developer.apple.com/design/human-interface-guidelines/menus
- Toolbars: https://developer.apple.com/design/human-interface-guidelines/toolbars
- Sidebars: https://developer.apple.com/design/human-interface-guidelines/sidebars
- Panels: https://developer.apple.com/design/human-interface-guidelines/panels
- Settings: https://developer.apple.com/design/human-interface-guidelines/settings
- Keyboards: https://developer.apple.com/design/human-interface-guidelines/keyboards
- Pointing devices: https://developer.apple.com/design/human-interface-guidelines/pointing-devices
- Drag and drop: https://developer.apple.com/design/human-interface-guidelines/drag-and-drop
- Context menus: https://developer.apple.com/design/human-interface-guidelines/context-menus
- File management: https://developer.apple.com/design/human-interface-guidelines/file-management
- Undo and redo: https://developer.apple.com/design/human-interface-guidelines/undo-and-redo

### Visual system and inclusion

- Materials: https://developer.apple.com/design/human-interface-guidelines/materials
- Typography: https://developer.apple.com/design/human-interface-guidelines/typography
- Color: https://developer.apple.com/design/human-interface-guidelines/color
- SF Symbols: https://developer.apple.com/design/human-interface-guidelines/sf-symbols
- Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility/
- Motion: https://developer.apple.com/design/human-interface-guidelines/motion
- Writing: https://developer.apple.com/design/human-interface-guidelines/writing
- Right to left: https://developer.apple.com/design/human-interface-guidelines/right-to-left

### SwiftUI implementation

- SwiftUI documentation: https://developer.apple.com/documentation/swiftui
- WindowGroup: https://developer.apple.com/documentation/swiftui/windowgroup
- Building and customizing the menu bar: https://developer.apple.com/documentation/swiftui/building-and-customizing-the-menu-bar-with-swiftui
- NavigationSplitView: https://developer.apple.com/documentation/swiftui/navigationsplitview
- Search: https://developer.apple.com/documentation/swiftui/adding-a-search-interface-to-your-app
- MenuBarExtra: https://developer.apple.com/documentation/swiftui/menubarextra
- Applying Liquid Glass: https://developer.apple.com/documentation/swiftui/applying-liquid-glass-to-custom-views

Treat these URLs as entry points. Search the current documentation for the exact API in the project's SDK instead of inferring availability from this list.

## Evidence model

Classify evidence before reporting a decision:

| Evidence | Meaning | Safe use |
| --- | --- | --- |
| **Contract** | Official platform/API rule, explicit product requirement, or established project design contract | Justify the expected behavior. |
| **Runtime** | Screenshot, rendered preview, running app, accessibility inspection, measured trace, or reproducible interaction | Prove the behavior exists and define its scope. |
| **Source** | Scene/view/command/token code that explains how runtime behavior is produced | Locate the smallest correction; do not infer unseen appearance. |
| **Inference** | Reasoned conclusion not directly observed | Label it and state how to verify. |
| **Suggestion** | Optional improvement or creative direction | Never present as a defect. |

For an audit finding, require **Contract + Runtime + Correction** evidence when available:

- Contract: what should happen and why.
- Runtime: what actually happens, where, and under which state.
- Correction: the smallest change that restores the intended behavior.

Try to falsify each finding. Check whether the behavior is deliberate, scoped to another state, handled by a system component, or already covered by an existing token or command.

## Rule dispositions

Assign imported or inferred rules one disposition:

- **Adopt** — current primary evidence supports it and it is stable enough for this context.
- **Adapt** — the principle is useful but its platform, implementation, or absolute wording must change.
- **Verify** — the claim is version-sensitive, numerical, attributed, or not currently observable.
- **Reject** — it conflicts with the target platform, is Web/iOS-only, lacks evidence, or encodes arbitrary taste.

## Normative language

- Use **must** only for a verified platform/accessibility/safety contract or an explicit user requirement.
- Use **should** for a strong Mac default that has legitimate exceptions.
- Use **may** for optional craft and brand expression.
- Pair any deliberate exception with its user impact, compatibility cost, and verification plan.

## Citation record

For every release-relevant external claim, retain:

```text
Source: <first-party URL>
Retrieved: YYYY-MM-DD
Applies to: macOS <version/deployment range>; <SwiftUI/AppKit API if relevant>
Conclusion: <one sentence, no broader than the source supports>
Status: verified / unverified / superseded
```

Do not vendor Apple HIG prose, design resources, or screenshots into the skill. Summarize and link.
