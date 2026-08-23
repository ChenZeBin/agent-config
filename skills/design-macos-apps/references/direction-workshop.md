# Direction workshop

Use this reference when a new or substantially redesigned surface has unresolved visual or interaction direction. Skip it for a small correction inside an established design system.

## Gather design context

Inspect before inventing:

- product purpose, audience, and highest-frequency task;
- app archetype and expected session length;
- screenshots, shipped components, tokens, icons, copy, and assets;
- reference products supplied by the user and the exact qualities they value;
- platform/deployment constraints and accessibility requirements;
- content volume, edge cases, and real data density;
- brand traits stated in user or product language.

Separate evidence from assumption. Do not infer a whole design system from one repeated literal, one screenshot, or one fashionable reference.

## Write the design thesis

Use one sentence:

```text
For <user and task>, make <information/interaction quality> dominant through
<native structural choices>, while expressing <brand trait> through <bounded visual means>.
```

The thesis must describe the product, not “Apple-like,” “premium,” “modern,” or “clean” without further meaning.

## Choose exploration axes

Vary two or three axes that affect the experience:

- information density: compact operational ↔ spacious contemplative;
- hierarchy: navigation-led ↔ content-led ↔ inspector-led;
- interaction posture: command-efficient ↔ direct-manipulation ↔ guided;
- material budget: system-minimal ↔ layered functional chrome;
- brand expression: neutral/system ↔ editorial/content ↔ distinctive accent;
- persistence: always-visible controls ↔ contextual disclosure;
- window strategy: focused single-role ↔ multiwindow workspace.

Do not create variants that differ only in color, font, corner radius, or blur.

## Create two or three platform-safe directions

For each direction, state:

```text
Name and thesis:
Best for:
Scene/window model:
Information hierarchy:
Command/input model:
Density and visual roles:
Material and motion budget:
Distinctive but bounded product expression:
Accessibility/compatibility risks:
What this direction deliberately avoids:
```

Each direction must independently satisfy the native Mac interaction and accessibility contract. Creative divergence never includes breaking standard window behavior, hiding commands, or importing an iPhone shell.

## Evaluate

Score with evidence, not taste alone:

| Lens | Question |
| --- | --- |
| Task fit | Does the structure shorten or clarify the primary workflow? |
| Mac fit | Do window, command, keyboard, pointer, and selection behaviors feel native? |
| Hierarchy | Can people identify context, selection, next action, and status? |
| Scalability | Does it handle real data, narrow/wide windows, multiple windows, and edge states? |
| Accessibility | Does it survive appearance, contrast, transparency, motion, keyboard, VoiceOver, and localization tests? |
| Identity | Does it express something true about this product instead of a generic trend? |
| Implementation risk | Are custom controls/materials justified and supportable at the deployment floor? |

Recommend one direction. Name the strongest rejected alternative and the condition that would make it preferable.

## Make it lived-in

Prototype with realistic content and state variation:

- long and short names;
- empty, loading, error, and offline states;
- multiple selection and no selection;
- disabled/read-only/destructive states;
- dense and sparse data;
- light/dark and accessibility preferences;
- narrow, default, and wide windows;
- localization expansion.

Do not approve a direction based only on a pristine hero state.

## Anti-default review

Ask of every memorable treatment:

1. What product fact or task does it express?
2. Why is the system/default treatment insufficient?
3. Does it recur as a coherent language or appear once as decoration?
4. Does it remain usable with reduced motion/transparency and increased contrast?
5. Would the product remain recognizable if the fashionable effect disappeared?

Reject a treatment when its only rationale is “looks Apple,” “feels premium,” “AI-generated UI needs personality,” or “the reference skill mandates it.”

## Selection output

Return:

- context and assumptions;
- direction summaries with real tradeoffs;
- recommended direction and decision rationale;
- selected Mac scene/interaction model;
- visual/motion roles, not arbitrary token values;
- prototype states needed before implementation;
- evidence or user choice still required.
