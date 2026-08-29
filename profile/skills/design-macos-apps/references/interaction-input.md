# Interaction and input

Design around the Mac's combined menu, keyboard, pointer, trackpad, focus, selection, and window model. Do not translate touch gestures directly into desktop interactions.

## Command inventory

For each meaningful action, record:

```text
Action:
Object or scope:
Availability/enabled condition:
Primary discovery surface:
Optional accelerator:
Feedback/result:
Undo or recovery:
Accessibility name and state:
```

Use one action identity across menu, toolbar, context menu, keyboard, and inline controls. Keep naming, enabled state, destructive role, and result consistent.

## Menu bar

Treat the menu bar as the app's command model, not as decoration. Preserve standard application, File, Edit, View, Window, and Help semantics when the app supports those actions. Add domain commands where people will look for them and validate them against the active window, focus, selection, and document state.

- Group related items and keep labels concise and action-oriented.
- Put important/frequent items where scanning finds them quickly.
- Keep stateful and show/hide items visibly synchronized with the interface.
- Use standard roles for common operations rather than duplicating behavior under novel names.
- Expose toolbar actions in menus when hiding or customizing the toolbar would otherwise remove access.
- Do not add a shortcut to every menu item. Prioritize standard and frequently repeated actions.

## Keyboard

Support keyboard-first work when it makes the app faster or more accessible:

- Preserve standard shortcuts for familiar actions.
- Add memorable shortcuts for frequent domain actions without colliding with system or text-editing behavior.
- Provide menu discoverability for shortcuts.
- Define focus traversal, initial focus, default/cancel actions, and return of focus after dismissal.
- Keep key handling scoped to the active scene and focused control.
- Avoid global handlers that steal typing, system shortcuts, or assistive input.
- Make high-frequency keyboard actions respond immediately; avoid decorative animation that slows repetition.

Test with Full Keyboard Access and without a pointing device. A shortcut is an accelerator, not the only access path for an essential action.

## Pointer and trackpad

Use pointer precision and hover where they add information or control, but keep state visible without requiring hover:

- Match cursor shape to actual behavior for resize, text, link, drag, and precision tools.
- Provide hover feedback for actionable or inspectable regions when useful.
- Keep click targets sized by the visible control, density, and precision context; do not import mobile touch-target constants as universal Mac rules.
- Distinguish single click, double click, disclosure, selection, and activation consistently.
- Avoid hidden edge gestures or hover-only critical commands.
- Keep scroll, zoom, and pan behavior consistent with content and system expectations.
- Preserve secondary click through contextual menus only where object-specific actions exist.

## Focus and selection

Treat focus, selection, and activation as different states:

- **Focus** identifies the element receiving keyboard input.
- **Selection** identifies the object(s) an action will affect.
- **Active/inactive window** affects emphasis without erasing selection meaning.
- **Hover** indicates pointer location but must not masquerade as selection.

Specify empty selection, single selection, multi-selection, range selection, select all, selection removal, and selection persistence as relevant. Keep destructive and export operations explicit about the affected selection.

For custom controls, define keyboard focus, focus indication, VoiceOver role/value/actions, pointer affordance, disabled/read-only behavior, and state announcement before approving the design.

## Context menus

Use a context menu for a small, object-specific subset of useful actions. It may accelerate discovery but must not be the only path to an essential or unfamiliar command.

- Scope actions to the clicked object or current selection consistently.
- Keep destructive actions visually and semantically distinct.
- Avoid duplicating the full menu bar.
- Do not attach a context menu to every interactive element by rule.

## Drag and drop

Use drag and drop when direct manipulation is clearer or faster than a command. Always provide an alternative for essential workflows.

Define:

- draggable object and represented data;
- valid destinations and allowed operation (move, copy, link, import, reorder);
- lift/drag preview and pointer feedback;
- invalid-destination feedback;
- autoscroll and expansion behavior for long/hierarchical targets;
- cross-window/app/file-system behavior;
- drop result, selection update, failure, and undo.

Do not add drag/drop merely because desktop apps often support it.

## Search and filtering

Separate search scope from filter state. State what corpus is searched, whether results update live, how tokens/filters combine, and how people clear or recover the previous state.

- Use native search placement and behavior when it fits the selected shell.
- Keep scope visible when ambiguity would change results.
- Preserve keyboard access and focus return.
- Define empty results, delayed results, errors, indexing, and offline behavior.
- Avoid a permanently prominent global search field when search is secondary.

## Undo, destructive actions, and recovery

Prefer undo for reversible changes and clear confirmation for consequential, difficult-to-recover actions. Decide based on consequence rather than a blanket confirmation rule.

- Name the object and consequence.
- Make the safe and destructive choices unambiguous.
- Preserve selection/context after recoverable failure.
- Provide progress and cancellation for long operations when feasible.
- Keep menu/keyboard undo state synchronized with the last reversible action.
- Avoid success modals for routine operations.

## Text and data entry

- Use labels that describe user concepts, not implementation terms.
- Keep the same action vocabulary across controls, menus, status, and errors.
- Validate near the field or action and explain recovery.
- Preserve standard editing, selection, copy/paste, spelling, and accessibility behavior.
- Use a custom text editor only for a named domain need that standard behavior cannot satisfy.
- Plan for localization expansion, IME composition, multiline content, and assistive input where relevant.

## Interaction acceptance questions

- Can the workflow be completed with keyboard only?
- Can it be completed without knowing a hidden shortcut or context menu?
- Does pointer feedback match the operation?
- Are focus, selection, hover, and window activation distinguishable?
- Do commands target the correct window/object and enable consistently?
- Can people recover from mistakes, cancellation, and failed operations?
- Does custom interaction remain usable with Reduce Motion and VoiceOver?
