# `design-macos-apps` optimization verification

Evaluated: 2026-08-16  
Runner: Codex / `gpt-5.6-terra`  
Main track: offline, isolated comparative arms

## Verdict

The optimized skill is now useful as a **bounded native-macOS design, review, translation, and implementation guardrail**. It reliably improves evidence traceability and review completeness in the cases that previously exposed those gaps, while the current 12-case paired run adds about 14% tokens instead of the historical 153% overhead.

This result does **not** prove that the skill produces a superior rendered Mac interface. The implementation track still reaches build evidence only; no automated launch, window interaction, VoiceOver, or expert visual review was performed.

## Why it changed

Two prior task histories were synthesized in:

- [`session-evidence-optimization.md`](/Users/example/Project/mac-app-design-skill-research/reviews/session-evidence-optimization.md)

The convergent failures were excessive reference loading, 480-second non-delivery, missing review corrections, research-before-patch behavior, a blank-template validator false positive, poor localized-heading support, and collapsing build evidence into stronger completion claims.

The optimized skill now provides:

- explicit design/review/implement/translate routing and non-UI exclusions;
- a quick default and hard reference budget;
- mandatory bounded local-evidence discovery with exact path citation;
- provisional delivery before research expansion;
- state ownership and active-window command scope;
- compact review and evidence-boundary output contracts;
- patch/build-first implementation and an explicit verification ladder;
- MenuBarExtra lifecycle, permission, recovery, and activation/Dock decisions;
- a structural/evidence linter that rejects placeholders and accepts substantive Chinese specs.

## Deterministic verification

| Check | Result |
| --- | --- |
| Evaluation schema | 12 cases loaded successfully |
| Validator regressions | 5/5 pass |
| Grader regressions | 8/8 pass |
| Python syntax | `validate_spec.py` and `grade_case.py` compile |
| Blank template | Fails default and strict validation; passes only with `--template` |
| Substantive Chinese spec | Passes structural/evidence lint |
| Main paired run | No case timed out |

The current regression command passes 13/13 tests:

```bash
python3 -m unittest discover -s evals/regressions -p 'test_*.py' -v
```

## Paired 12-case result

The no-skill arm ran in an isolated Codex home containing only system skills and the existing login credential. Both arms used the same prompts, fixtures, model, timeouts, and offline Apple evidence.

| Measure | With skill | No skill | Delta |
| --- | ---: | ---: | ---: |
| Raw deterministic case passes | 9/12 | 9/12 | tie before adjudication |
| Replayed passes after tested false-negative fixes | 12/12 | 9/12 | +3 cases |
| Sum of case durations | 535.3 s | 509.6 s | +5.0% |
| Median case duration | 38.3 s | 33.6 s | +13.9% |
| Input tokens | 1,657,030 | 1,452,139 | +14.1% |
| Output tokens | 19,002 | 17,304 | +9.8% |

The runner's combined raw summary was 18/24 because it counts both arms. It must not be read as the target's score.

### Adjudication boundary

Three target artifacts initially failed the script grader even though manual inspection showed that the required relationship was present:

1. a quick Export decision said “current focused Library window” and “selection is empty → disabled,” but the regex recognized only a Chinese-only word order;
2. a false-positive audit correctly found no confirmed defect, so requiring an invented “smallest correction” contradicted the task and the skill;
3. a menu-bar design expressed user-initiated permission, popover-independent recording, and explicit Settings handoff with semantically equivalent wording.

The fixes were narrow and regression-tested. They did not remove evidence, state-scope, recovery, or verification requirements. Replaying the stored target artifacts then passed all three. Replaying the three baseline failures still failed:

- review findings lacked a concrete smallest correction;
- an API implementation omitted a source/unverified boundary;
- a build-evidence answer did not cite the inspected `build.log` and `MainView.swift` paths.

## Repeated high-risk result

The build-versus-runtime evidence case was repeated three times after strengthening the trigger description and review output contract. The post-fix result below distinguishes stored raw grading from replay under the current regression-tested grader.

| Arm | Raw PASS | Post-fix replay | Traceable evidence-path result |
| --- | ---: | ---: | --- |
| With skill | 2/3 | 3/3 | All 3 cited `evidence/build.log` and `Sources/BoundaryApp/MainView.swift`, separated build from visual/keyboard/VoiceOver/HIG claims, and proposed runtime checks |
| No skill | 0/3 | 0/3 | No artifact met the exact evidence-path gate |

The third target artifact was initially marked FAIL only because the grader treated “全面符合 HIG should be limited to the reviewed scope” as a positive blanket-compliance claim. A regression now distinguishes scoped/negated language from an actual unsupported claim.

## What is proven

- bounded cases now deliver rather than timing out after broad reference reading;
- quick tasks can stay compact and use actual project evidence;
- review findings reliably include evidence scope, user impact, smallest correction, and verification when a real finding exists;
- no-finding reviews do not manufacture corrections merely to satisfy a template;
- build evidence is kept separate from rendered, interaction, accessibility, and HIG claims;
- implementation fixtures preserve deployment targets, make bounded edits, and build successfully;
- the specification validator no longer certifies an untouched template.

## What remains unproven

- launch, window restoration/resizing, focus, menu scope, and pointer/keyboard behavior in a packaged app;
- VoiceOver, Full Keyboard Access, display preferences, and localization at runtime;
- stable visual-design superiority under expert blind review;
- broad stability across all 12 cases at three to five repetitions.

The next release gate should be one real multiwindow sample app with scripted launch/screenshots plus manual keyboard and VoiceOver evidence, followed by two independent Mac experts reviewing anonymized target/no-skill artifacts.
