# Visual system

Build a semantic, adaptive Mac visual system. Let hierarchy and behavior create the native character; do not imitate Apple through fixed colors, card shapes, blur, or empty space.

## Design roles before values

Define roles such as:

- window/content/sidebar/inspector background;
- primary/secondary/tertiary text;
- fill, separator, selection, focus, status, warning, and destructive emphasis;
- primary, secondary, and contextual actions;
- navigation/control material versus content material;
- compact, standard, and spacious density contexts when the product truly needs them.

Map roles to system semantic colors, materials, text styles, and controls first. Add project tokens only for stable product meaning or brand expression. A repeated literal value is not automatically a design token.

Every custom role needs behavior for light, dark, Increased Contrast, Reduce Transparency, inactive windows, disabled state, selection, and any supported accent/highlight preferences.

## Hierarchy

Create hierarchy with the smallest sufficient combination of:

1. structure and placement;
2. type style and weight;
3. semantic foreground/background contrast;
4. spacing and grouping;
5. material or elevation;
6. motion or color accent.

Do not make every section a rounded card. Use spacing, alignment, native groups, separators, lists, tables, sidebars, and inspectors when they express the relationship more directly.

## Typography

- Prefer system text styles and platform behavior over fixed point sizes.
- Use weight, width, size, and color with restraint; avoid several competing hierarchies.
- Let the system handle optical sizing and platform metrics when possible.
- Use monospaced type only for content whose alignment or code-like semantics benefit.
- Introduce a custom or editorial face only for a documented brand/content reason, then define fallbacks, localization coverage, scaling, truncation, and accessibility behavior.
- Test long labels, localization expansion, multiline states, large accessibility text, and narrow windows.
- Keep interface copy plain, consistent, and action-oriented. Empty and error text must guide recovery, not decorate the screen.

Do not mandate SF Pro, New York, a serif display face, a two-font limit, or a fixed type scale as an Apple rule.

## Color

- Use semantic colors and system selection/accent behavior by default.
- Never rely on color alone for state or meaning.
- Reserve saturated brand/accent color for a small number of meaningful roles.
- Validate contrast in real rendered states, including vibrancy/material backgrounds.
- Avoid fixed white/black surfaces that break appearance adaptation.
- Do not fix every sidebar symbol to a brand palette; preserve user/system accent behavior unless color communicates real meaning.

If brand colors are required, document each role, background pair, state variants, contrast evidence, and fallback.

## SF Symbols and iconography

- Prefer SF Symbols for standard actions and objects when an appropriate symbol exists.
- Choose by meaning before visual similarity.
- Keep symbol rendering mode, weight, scale, and label alignment consistent with surrounding controls.
- Pair unfamiliar, ambiguous, or destructive symbols with text where space and frequency allow.
- Define accessibility labels independent of symbol filenames.
- Use a custom symbol only when no system symbol conveys the product concept; make it behave coherently across weights, scales, and appearance variants.
- Do not use emoji as interface icons unless the emoji itself is the content.

Verify the current SF Symbols catalog and platform availability before naming a version-specific symbol or effect.

## Density and spacing

Mac interfaces may be compact, information-dense, and used for long work sessions. Choose density from task frequency, content complexity, input precision, and window size.

- Establish a small project spacing vocabulary without claiming it is an HIG constant.
- Align repeated controls and data to aid scanning.
- Preserve enough room for focus rings, localization, and state indicators.
- Let system control metrics drive nearby layout where possible.
- Use whitespace to expose grouping and priority, not to make every utility resemble a marketing page.
- Allow pro/data interfaces to be denser when hierarchy and precision remain clear.

## Materials and layers

Use materials to communicate layer and function:

- **Content layer:** the app's documents, data, media, editors, lists, and backgrounds. Prefer standard content materials or semantic backgrounds.
- **Functional layer:** navigation and controls that sit above content, such as system sidebars, toolbars, and transient controls.
- **Transient presentation:** popovers, menus, sheets, alerts, and temporary feedback, typically system-owned.

Do not add material solely to make a surface look premium. Avoid material-on-material combinations that weaken hierarchy or legibility.

## Liquid Glass

Treat Liquid Glass as a system design behavior for functional controls and navigation, not as generic CSS glassmorphism.

1. Prefer standard SwiftUI/AppKit components that adopt the current system appearance automatically.
2. Keep content rows, cards, canvases, and backgrounds out of the glass layer unless current Apple guidance identifies a functional exception.
3. Use custom glass only for an app-specific interactive/control surface that standard components cannot express.
4. Verify the exact macOS SDK/deployment availability before naming `glassEffect`, glass button styles, containers, or related APIs.
5. Apply a custom effect after layout/appearance modifiers as required by the current API.
6. Group only nearby custom glass elements that share a visual sampling/morphing relationship; do not wrap unrelated views mechanically.
7. Use interactive behavior only on an actual target.
8. Limit simultaneously rendered effects and measure complex surfaces.
9. Provide a functional system-material or non-glass fallback.
10. Test Reduce Transparency, Increased Contrast, light/dark appearance, dynamic backgrounds, pointer interaction, and legibility.

Reject browser `backdrop-filter`, fixed blur/opacity recipes, blue-purple glass cards, and marketing-site hover effects as native evidence.

## Brand expression

Preserve a product's existing identity when it does not conflict with platform/accessibility contracts. Express brand through content, voice, iconography, illustration, meaningful accent, and selected custom surfaces before replacing standard interaction behavior.

Require a rationale for each custom font, color, icon, card, material, illustration, and motion pattern:

```text
Role served:
User or brand meaning:
Why a system/default treatment is insufficient:
Accessibility and appearance behavior:
Where it recurs:
How it is verified:
```

## Anti-generic diagnostic

Treat the following as symptoms to investigate, not automatic violations:

- Web hero blocks pasted into a desktop window;
- fake titlebars or traffic lights;
- card grids replacing real navigation or tables;
- decorative gradients and glow without product meaning;
- generic purple/blue palettes applied regardless of subject;
- indiscriminate glass, blur, or rounded rectangles;
- emoji used as controls;
- arbitrary spacing and type values on each screen;
- stock “Welcome” empty states without a next action;
- absolute Figma positioning reproduced as SwiftUI offsets;
- a “signature detail” competing with routine work.

Diagnose the task mismatch and replace it with a native, product-specific structure. A restrained system-only utility can be fully designed; distinctiveness is not a quota.

## Visual acceptance questions

- Does every visible treatment support task hierarchy, state, or an explicit brand role?
- Does the interface remain coherent in all supported appearance and accessibility variants?
- Is the content layer distinct from functional controls and transient presentation?
- Are custom treatments rarer and more justified than system treatments?
- Can the app be recognized through product meaning rather than fashionable decoration?
