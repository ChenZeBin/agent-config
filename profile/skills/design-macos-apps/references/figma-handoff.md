# Figma, Web, and iOS translation

Translate intent into a native Mac model. Do not reproduce pixels, phone shells, browser CSS, or exported component trees.

## Authorization boundary

Read supplied images, frames, exports, or links for analysis. Mutate a Figma file, create frames, publish libraries, or write state ledgers only when the user explicitly requests it and identifies the target file. Do not require a Figma connector for a text/code handoff.

## Translation sequence

1. Identify the source element's job, state, frequency, and hierarchy.
2. Separate product intent from source-platform implementation.
3. Choose the Mac scene/window/content/command model.
4. Map visual roles and components semantically.
5. Capture behavior unavailable in a static frame as annotations and state matrices.
6. Record what is deliberately not carried over.

Use this table:

| Source element | Intended job | Mac-native structure/control | Command/input path | Visual/token mapping | Discarded source behavior | Verification |
| --- | --- | --- | --- | --- | --- | --- |

## Figma to native Mac

- Map a window to its actual role, title, resize/restoration behavior, and state—not a decorative device frame.
- Map hierarchy to sidebar/list/detail, table, editor/inspector, split view, or compact utility as appropriate.
- Map frequent actions to toolbar plus menu commands; map the full command system to menus and keyboard behavior.
- Map search to its corpus and native placement.
- Map Figma components/variants to native component roles and states before creating custom controls.
- Map named color variables to semantic SwiftUI/AppKit roles, not literal RGB values by default.
- Map named text styles to system semantic styles and content hierarchy, not fixed pixel sizes.
- Map SF Symbols by symbol name and supported rendering behavior.
- Map auto layout to native stacks/grids/containers; never use absolute offsets simply to match a screenshot.
- Treat shadows, blur, and translucent fills as evidence of intended hierarchy; decide the native material separately.

## iOS to Mac

Preserve the job and domain model; reconsider:

- bottom tab bar → sidebar, toolbar, segmented mode, or window/menu structure;
- navigation push stack → sidebar/list/detail, separate window, inspector, or in-place hierarchy;
- bottom sheet → sheet, popover, inspector, panel, or inline disclosure;
- swipe-only action → menu/context/keyboard/inline command;
- touch target and safe-area layout → pointer/keyboard density and window chrome;
- single-device state → per-window/document state;
- mobile search/navigation placement → native Mac toolbar/sidebar behavior.

Do not convert every mobile screen into a separate Mac window. Choose windows by independent task/context, not by route count.

## Web/Electron reference to native Mac

Treat HTML/CSS/Tailwind/React output as structural evidence only:

- page header/hero may represent window context, toolbar, or content—not a Web navbar;
- card grids may represent a list, table, collection, sidebar, or inspector;
- browser modal may become a sheet, popover, alert, or auxiliary window;
- CSS tokens become semantic roles only after appearance/accessibility review;
- `backdrop-filter`, glass cards, hover lifts, and scroll reveals do not map to Liquid Glass automatically;
- ARIA intent maps to native roles, names, focus, and actions—not literal attributes;
- responsive breakpoints become window-resize/collapse behavior based on task hierarchy.

## State matrix

For each custom or product-specific component, capture:

```text
Role and content:
Default / hover / focused / pressed / selected:
Disabled / read-only / destructive:
Loading / empty / error:
Light / dark / increased contrast / reduced transparency:
Keyboard and VoiceOver behavior:
Narrow/wide window behavior:
Motion and reduced-motion behavior:
Native implementation candidate and availability:
```

## Handoff package

Provide only relevant artifacts:

- context and design thesis;
- window/scene and information architecture map;
- command/menu/keyboard inventory;
- annotated frames for default and edge states;
- component/state matrix;
- semantic color/type/material/symbol roles;
- resizing, focus, selection, drag/drop, and motion notes;
- SwiftUI/AppKit mapping with availability/fallback;
- accessibility/localization test plan;
- source-of-truth and open-decision list.

## Acceptance questions

- Can an implementer explain why each source structure changed for Mac?
- Does the handoff specify behavior beyond the static screenshot?
- Are tokens semantic rather than pixel/color copies?
- Are system controls and commands recognizable in the chosen mapping?
- Are Web/iOS-only assumptions explicitly discarded?
- Does every custom component include accessibility and state behavior?
