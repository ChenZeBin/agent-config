# API fallback artifact regrade

Date: 2026-08-16

The original target artifact was rejected only because the deterministic source pattern did not
recognize the phrase “冻结的 Apple 证据”. The pattern was extended symmetrically for both arms;
the existing responses and workspaces were replayed without regenerating either answer.

## Target artifact

Source: `/Users/example/.codex/skills/design-macos-apps-api-final-workspace/iteration-1/implement-api-availability-fallback/with_skill/outputs`

```text
INFO: API fallback checks 9/9
INFO: swift build tail:
Building for debugging...
[0/6] Write sources
[0/6] Write GlassNotes-entitlement.plist
[2/6] Write swift-version--4A847ED0836F2485.txt
[4/8] Emitting module GlassNotes
[5/8] Compiling GlassNotes GlassNotes.swift
[5/8] Write Objects.LinkFileList
[6/8] Linking GlassNotes
[7/8] Applying GlassNotes
Build complete! (4.94s)
```

## No-skill artifact

Source: `/Users/example/.codex/skills/design-macos-apps-api-final-workspace/iteration-1/implement-api-availability-fallback/without_skill/outputs`

```text
INFO: API fallback checks 9/9
INFO: swift build tail:
Building for debugging...
[0/6] Write sources
[0/6] Write GlassNotes-entitlement.plist
[2/6] Write swift-version--4A847ED0836F2485.txt
[4/8] Emitting module GlassNotes
[5/8] Compiling GlassNotes GlassNotes.swift
[5/8] Write Objects.LinkFileList
[6/8] Linking GlassNotes
[7/8] Applying GlassNotes
Build complete! (5.00s)
```

This replay validates the deterministic contract and build only. It does not add runtime UI or
accessibility evidence.
