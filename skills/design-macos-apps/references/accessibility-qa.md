# Accessibility, localization, and QA

Treat accessibility and user preferences as design inputs, not post-design polish. Verify custom behavior in the running app whenever implementation exists.

## Core contract

An accessible surface is:

- perceivable without relying on one color, motion, sound, or visual treatment;
- operable through keyboard and supported assistive input;
- understandable through clear roles, labels, states, order, and recovery;
- adaptable to appearance, contrast, transparency, motion, text, localization, and window changes.

## Native controls first

Prefer standard SwiftUI/AppKit controls because they already carry platform semantics, focus, keyboard, state, and accessibility behavior. Before approving a custom control, specify:

```text
Role and accessible name:
Value/state and how changes are announced:
Available actions:
Keyboard operation and focus order:
Pointer behavior:
Disabled/read-only/destructive behavior:
VoiceOver reading order:
Appearance/preference variants:
Fallback when custom effects are unavailable:
```

Do not translate HTML/ARIA instructions literally. Implement the same user intent through native accessibility APIs and behavior.

## Keyboard access

Test:

- Full Keyboard Access and normal keyboard navigation;
- initial focus and logical traversal;
- visible focus indication in every appearance;
- default and cancel actions;
- menu discovery and shortcut operation;
- focus return after menu, popover, sheet, alert, or window dismissal;
- no keyboard trap in custom views;
- typing, IME composition, and standard editing commands;
- correct active-window and selection scope.

Essential actions need a discoverable path beyond a hidden shortcut.

## VoiceOver

Verify:

- concise names based on user concepts;
- correct role, value, state, and enabled condition;
- meaningful grouping and reading order;
- selected, expanded, checked, progress, error, and destructive states;
- custom actions only when standard interaction cannot express the behavior;
- updates announced without excessive chatter;
- images and symbols labelled by meaning, not filename;
- table/list hierarchy, column context, and multi-selection behavior;
- focus moves intentionally when presentation or content changes.

Do not infer VoiceOver correctness from visible text alone.

## Appearance and user preferences

Test a matrix appropriate to the product:

| Setting/context | Verify |
| --- | --- |
| Light and dark appearance | Semantic colors, images, shadows/materials, selection, focus, inactive windows. |
| Increased Contrast | Controls, separators, focus, selected/unselected state, text over materials. |
| Reduce Transparency | Functional hierarchy and legibility remain without blur/translucency. |
| Reduce Motion | Same information and control remain with reduced or replaced animation. |
| Differentiate Without Color | Status and selection use labels, shapes, symbols, or structure in addition to color. |
| Larger text/accessibility sizes | Reflow, truncation, labels, tables, toolbar, settings, and custom controls. |
| User accent/highlight preferences | Selection and controls remain coherent unless a justified fixed color conveys meaning. |

Measure contrast on the rendered background, including vibrancy or dynamic material, rather than on token values in isolation.

## Localization and writing

- Use plain, user-facing concepts and consistent action names.
- Prefer sentence case unless a proper name or established convention requires otherwise.
- Keep labels distinct from explanatory text.
- Make errors state what happened and how to recover.
- Make empty states explain the next useful action.
- Allow string expansion without clipping or destructive relayout.
- Avoid concatenated sentence fragments and fixed-width text containers.
- Test pluralization, dates, numbers, sorting, and culturally dependent formats.
- Support right-to-left layout where the product/locales require it; mirror directional structure while preserving media/content semantics.
- Keep symbols with directional meaning localized or mirrored appropriately.

## State and safety QA

Verify relevant states:

- first run and returning run;
- no data, no selection, and partial data;
- loading, long-running, cancellation, and progress;
- recoverable/unrecoverable errors and retry;
- offline, revoked permission, and changed external resources;
- disabled, read-only, locked, and unavailable commands;
- destructive confirmation, undo, failure, and recovery;
- single and multiple selection;
- interrupted save/export/import/drag/drop;
- restored windows and stale/restored selection.

Never use a pristine sample state as the only design acceptance artifact.

## Window and environment QA

Exercise:

- minimum useful, default, and wide window configurations;
- resize transitions and collapsed/expanded sidebar/inspector;
- multiple windows/documents and independent state;
- inactive versus active window;
- full screen where supported;
- standard and high-density displays or varied scale where relevant;
- external display, color/background variation, and system accent;
- reopening, restoration, and relaunch.

## Severity

- **Blocker:** prevents an essential task, loses data/control, traps input/focus, excludes assistive use, or breaks required platform behavior.
- **High:** causes substantial confusion, unreadability, inaccessible custom interaction, or a major missing recovery path.
- **Medium:** creates repeated friction, inconsistent discovery, or weak adaptation with a viable workaround.
- **Polish:** bounded craft improvement with no material task or accessibility impact.

Do not label a personal aesthetic preference as an accessibility defect.

## Release gate

Before declaring a design or implementation ready, record:

```text
Verified in code only:
Verified in rendered preview/screenshot:
Verified in running app:
Verified with keyboard/VoiceOver/preferences:
Verified on deployment floor/current OS:
Measured performance evidence:
Manual checks remaining:
Known exceptions and rationale:
```

A code-only review cannot close visual, focus, window, VoiceOver, or animation-performance gates.
