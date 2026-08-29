# Native macOS platform model

Choose the app's scene, window, information, and command structure before visual styling. Treat the following as decision prompts, not a universal template.

## Start from the archetype

| Archetype | Likely starting model | Questions that change it |
| --- | --- | --- |
| Document editor | `DocumentGroup`, document windows, toolbar, inspector, File/Edit commands | One document per window? Autosave/versioning? Multiple views of one document? |
| Library or browser | `WindowGroup`, sidebar/list/detail or table/detail, toolbar search | Flat library or hierarchy? Multiple selection? Independent windows? |
| Pro editor | Main document/window, canvas/editor, inspectors, panels, deep command system | Persistent inspectors? Precision input? Customizable workspace? |
| Data/table app | Table or outline, detail/inspector, column and selection controls | Large datasets? Multi-selection? Sorting/filtering/export? |
| Compact utility | One focused window or utility window, minimal hierarchy | Does it need Dock presence, resizing, history, or secondary windows? |
| Menu bar utility | `MenuBarExtra` with menu or window style; optional settings/main window | Is it useful when the app is inactive? Is the content too rich for a menu extra? |
| Media/live viewer | Main viewer, transport controls, playlists/inspector as needed | Full screen? External displays? Background playback? |
| Settings companion | `Settings` scene with native grouped preferences | Immediate apply or explicit commit? Search? Multiple categories? |

Verify scene and window API availability against the actual deployment target. Do not select a newer scene type merely to modernize code.

## Scene and window decisions

### WindowGroup

Use a window group when people can create multiple independent instances of the same window structure. Define what state is per-window, what is shared, and what restores after relaunch. Avoid storing active selection globally when each window should differ.

### Window

Use a single-role window when the app exposes one instance of a distinct surface. Decide how people reveal it again after closing and whether the surface belongs in the Window menu.

### DocumentGroup

Use a document scene for file-backed editing that benefits from system document lifecycle and commands. Specify new/open/save/duplicate/rename/move/export, autosave, dirty state, conflicts, recent documents, and error recovery. Do not simulate a document app with one global canvas and custom file buttons.

### Settings

Use the standard Settings scene for persistent app preferences. Separate app-wide preferences from document/view controls. Provide clear grouping, searchable labels when scale warrants it, and immediate feedback where settings apply live.

### MenuBarExtra

Use a menu bar extra for quick, persistent access while the app is inactive. Keep a menu-style extra command-oriented. Use a window-style extra only when controls or content require richer layout. Do not hide essential functionality exclusively here unless the app is intentionally menu-bar-only. Define Dock/app-switcher behavior explicitly.

### Utility windows and panels

Use an auxiliary window or `NSPanel` only for a role that benefits from remaining available beside main content, such as an inspector, palette, or specialized utility. Define key/main status, floating behavior, close semantics, focus, persistence, and relationship to documents. Use a narrow AppKit bridge only when SwiftUI cannot express the required panel behavior.

## Window contract

Specify for every window role:

- logical title and represented document/content;
- default, minimum, and useful maximum behavior without treating dimensions as HIG constants;
- resizable axes and what reflows, collapses, scrolls, or disappears;
- restoration identity and per-window state;
- multiwindow and tabbing behavior;
- full-screen behavior when useful;
- toolbar/title integration and reliable dragging;
- close, minimize, zoom, reopen, and activation paths;
- inactive-window appearance and selection behavior;
- external-display and varied-scale assumptions when relevant.

Never draw fake traffic lights. If customizing titlebar/chrome, preserve a logical title, standard controls, accessibility, and a dependable drag region. Test the actual `.app`, not just a preview.

## Information architecture

### Sidebar / list / detail

Use a sidebar for a broad, relatively stable set of top-level destinations or sources. Use a second list/content column when hierarchy or result sets need another selection step. Use the detail region for the selected object's work, not for another global navigation layer.

Specify:

- selection ownership and empty selection;
- single versus multiple selection;
- expansion/disclosure and persistence;
- collapse/show behavior as the window narrows;
- View menu and toolbar affordance for showing/hiding the sidebar when appropriate;
- badge, status, and icon semantics;
- user-customizable order or visibility only when it helps the task.

Do not give every sidebar icon a fixed brand color. Prefer current accent/semantic behavior unless color communicates meaning.

### Tables and outlines

Prefer a table or outline when comparison, sorting, column semantics, hierarchical data, or multi-selection matter. Define column priorities, resizing, reordering, visibility, sort state, selection, keyboard movement, contextual actions, inline editing, empty/loading/error states, and what survives relaunch.

### Editor and inspector

Use an inspector for properties of the current selection or document, not for global navigation. State whether it is persistent, collapsible, context-sensitive, or a separate panel. Preserve content space at narrow widths and avoid stacking modal sheets for routine property editing.

### Split views

Use split views when adjacent regions must remain simultaneously visible and user-resizable. Provide useful collapse behavior and sensible state restoration. Do not use a split view merely to reproduce a static Figma grid.

## Command surfaces

Design commands as one system with multiple discovery paths:

- **Menu bar:** complete, organized command model and standard app/document/window actions.
- **Toolbar:** frequent, view-relevant commands, navigation, title, and search; never the sole home of a command that disappears when the toolbar is hidden or customized.
- **Context menu:** small set of actions relevant to the current object or selection; not a duplicate of the full menu bar.
- **Keyboard shortcut:** frequent or standard actions where a memorable equivalent helps; not every action needs one.
- **Inline control:** immediate action at the point of use, especially when state or consequence must remain visible.
- **Drag/drop:** direct manipulation when source, destination, allowed operation, and result can be made clear.

Keep identical actions named and enabled consistently across surfaces. Use validation based on active window, focus, selection, and document state.

## Toolbar

Use the toolbar for a deliberately small set of common commands and navigation. Group by role, let the system handle overflow, and consider customization for apps with varied professional workflows. Ensure important toolbar actions remain available in the menu bar. Place search through native search behavior rather than a permanently custom field unless the task demands it.

Avoid decorative toolbar chrome, duplicate headings, unlabeled ambiguity, and a toolbar filled with every possible action.

## Presentation choices

| Need | Prefer | Avoid |
| --- | --- | --- |
| Commit or cancel a focused edit tied to a window/document | Sheet | Global floating modal with unclear ownership |
| Brief contextual choice or explanation | Popover/menu | Full window or persistent card |
| Important interruption requiring a decision | Alert | Alerts for routine status or success |
| Ongoing object properties | Inspector/panel | Repeated sheets for every property |
| Persistent app preference | Settings | Hiding preferences in arbitrary main-window controls |
| Nonblocking status | Inline state/status area/notification as appropriate | Modal success confirmations |

Use modality sparingly. Preserve context and provide a clear return path.

## Required state model

Specify only relevant states, but do not design a surface as a single happy screenshot:

- first launch/onboarding;
- no data and no selection;
- loading, incremental loading, and refresh;
- recoverable and unrecoverable errors;
- offline or unavailable dependencies;
- permission required, denied, and later changed;
- single/multiple selection and selection removed;
- disabled/read-only/locked;
- destructive pending, completed, undoable, and failed;
- window narrowed, expanded, inactive, restored, and full screen;
- light/dark, Increased Contrast, Reduce Transparency, and Reduce Motion.

## Platform review questions

- Can people understand the window's role and current object?
- Does the app use the larger desktop canvas without forcing deep mobile-style navigation?
- Can people resize and arrange windows to suit their work?
- Are common commands discoverable from the menu bar and accelerable where appropriate?
- Do keyboard and pointer workflows complement rather than fight each other?
- Does the system own chrome and standard behavior wherever possible?
- Are file, selection, undo, and recovery semantics coherent across windows?
