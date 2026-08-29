# Motion and feedback

Use custom motion only when it explains state, space, causality, progress, or direct manipulation. Preserve system animation for standard components unless a measured product need requires otherwise.

## Motion gate

Before designing an animation, answer:

1. **Purpose:** What does motion communicate that a static state cannot?
2. **Frequency:** How often will a person encounter it during real work?
3. **Control:** Is it user-initiated, interruptible, cancellable, or automatic?
4. **Spatial logic:** Where does the element come from and where does it go?
5. **Performance:** What changes each frame and on what content scale?
6. **Accessibility:** What remains when Reduce Motion or related settings are enabled?

Choose no animation when purpose is weak, frequency is high, or the motion delays a command.

## Native principles

- Respond immediately to direct input.
- Keep manipulated content attached to the pointer/gesture when feasible.
- Start from the current on-screen state, including interruption and reversal.
- Preserve spatial continuity: entrances and exits should agree with their source, destination, and hierarchy.
- Carry velocity or momentum only where the interaction model supports it and boundaries remain predictable.
- Use resistance/rubber-banding sparingly for real boundaries, not as decoration.
- Keep duration and spring behavior contextual; do not import fixed Web timing tables as Apple law.
- Animate a meaningful state transition, not every state change.
- Avoid large, automatic, repetitive, peripheral, flashing, or depth-heavy motion.

## Frequency posture

| Frequency | Default posture |
| --- | --- |
| Continuous/high-frequency editing or keyboard command | Immediate and mostly static; feedback through state change, not choreography. |
| Repeated navigation or selection | Preserve system behavior; use subtle continuity only if it improves orientation. |
| Occasional presentation or mode change | A short spatial transition may clarify origin and destination. |
| Rare milestone or onboarding moment | More expressive feedback may be justified if it remains skippable and accessible. |

## Direct manipulation

For drag, resize, scrub, reorder, canvas, or custom gesture interaction, specify:

- input-to-output mapping;
- pickup threshold and initial response;
- constraint, snapping, and invalid regions;
- velocity/momentum treatment;
- boundary resistance;
- interruption, reversal, cancellation, and handoff;
- drop/commit result and undo;
- keyboard and accessibility alternatives.

Do not translate Web Pointer Events or `requestAnimationFrame` code into SwiftUI/AppKit by analogy. Use the native event, gesture, animation, and rendering model selected for the target SDK.

## Enter, exit, and continuity

- Anchor motion at the control, object, selection, or edge that caused it.
- Keep enter and exit relationships coherent without requiring identical curves.
- Preserve identity across hierarchy changes when that helps people track an object.
- Avoid animating layout so broadly that unrelated content shifts or focus is lost.
- Do not animate frequent menu/keyboard actions merely to make the app feel alive.

## Feedback channels

Choose the least intrusive channel that communicates the result:

- visible state change;
- inline message or progress;
- menu/control enabled state;
- symbol or selection change;
- system sound or haptic only where platform/hardware and context support it;
- notification only when the result matters outside the active context.

Never rely on motion alone for status or success. Keep action names consistent with the resulting feedback.

## Reduced motion and comfort

When Reduce Motion is enabled:

- remove automatic and repetitive motion;
- replace large spatial/depth transitions with a restrained fade or immediate state change where appropriate;
- reduce bounce and overshoot;
- avoid animated blur and large scaling;
- retain the information, state, and focus transition through a non-motion channel.

Also test flashing-light preferences for applicable media and Reduce Transparency when motion involves material/blur.

## Performance

- Prefer system components and animations that adapt to platform and input.
- Avoid expensive work inside frequently recomputed SwiftUI view bodies.
- Keep list/table identity stable and observation scope narrow.
- Limit simultaneous custom material and visual effects.
- Measure reported hitches with the running app and appropriate Instruments/trace evidence.
- Do not promise a universal frame-rate target from code inspection alone.

## Motion specification

For each approved custom transition, record:

```text
Trigger and frequency:
Purpose:
Affected objects and spatial origin:
Input/control relationship:
Enter/steady/exit behavior:
Interruption and cancellation:
Reduced-motion equivalent:
Performance risk and measurement:
Native implementation boundary and availability:
```

## Review blockers

- critical information conveyed only through motion;
- non-dismissible automatic or repetitive decorative motion;
- direct manipulation that lags, jumps, or cannot be cancelled;
- inconsistent spatial origin that makes navigation confusing;
- custom motion overriding standard control behavior without a reason;
- no reduced-motion equivalent;
- performance claims without runtime evidence.
