# design-macos-apps evaluation

This suite separates deterministic contract checks from semantic quality and live-source freshness.

Latest optimized result: [`results/2026-08-16-optimization.md`](results/2026-08-16-optimization.md).
The earlier baseline report remains at [`results/2026-08-16-evaluation.md`](results/2026-08-16-evaluation.md).

## Tracks

1. `eval.yaml` — 14 deterministic cases, each run with and without the target Skill.
   The script grader checks workspace immutability for design/review cases, real `swift build`
   results for implementation cases, deployment preservation, native-platform boundaries,
   evidence calibration, a bounded quick path, build-versus-runtime claims, required
   recovery/accessibility coverage, and the mandatory Apple-reference/runtime-screenshot/
   interaction acceptance gate.
2. `eval-semantic.yaml` — four high-discrimination design/review/translation cases scored by an
   independent `gpt-5.6-sol` judge. The judge does not receive the target Skill and evaluates
   task fit, supported claims, false positives, and concrete trade-offs rather than keyword count.
3. `eval-upstream.yaml` — the six shared core cases using the frozen EHMO
   `macos-design-guidelines` Skill as the installed comparator. Run it with the same runner model,
   fixture, case prompt, timeout, and iteration count as the target.
4. `regressions/test_validator_contract.py` and `regressions/test_grader_contract.py` — direct
   contract tests for the specification linter and deterministic grader. An untouched template
   must pass only with `--template`, not in default or strict completed-spec validation. Grader
   regressions protect scoped HIG language, evidence paths, review corrections, quick window
   scope, and menu-bar lifecycle phrasing from known false positives.

The main tracks are offline and use `fixtures/offline/evidence/apple-contract.md`. Live Apple URL,
SDK-signature, and documentation-freshness checks are a separate diagnostic track because network
availability must not change the main quality score.

Run comparative arms with an isolated `CODEX_HOME` that contains the existing login credential but
no user-installed Skills. Otherwise a nominal `without_skill` arm can still discover the globally
installed target Skill, invalidating causal attribution. System Skills may remain available equally
to every arm.

## Reproducible commands

```bash
eval_codex_home=$(mktemp -d /tmp/design-macos-eval-codex-home.XXXXXX)
chmod 700 "$eval_codex_home"
ln -s /Users/example/.codex/auth.json "$eval_codex_home/auth.json"

skill-up validate evals/eval.yaml
skill-up validate evals/eval-semantic.yaml
skill-up validate evals/eval-upstream.yaml

CODEX_HOME="$eval_codex_home" skill-up run evals/eval.yaml \
  --baseline --iteration 1 --parallelism 2 \
  --output-dir /Users/example/.codex/skills/design-macos-apps-offline-eval-workspace

CODEX_HOME="$eval_codex_home" skill-up run evals/eval-semantic.yaml \
  --baseline --iteration 1 --parallelism 2 \
  --output-dir /Users/example/.codex/skills/design-macos-apps-semantic-workspace

CODEX_HOME="$eval_codex_home" skill-up run evals/eval-upstream.yaml \
  --baseline --iteration 1 --parallelism 2 \
  --output-dir /Users/example/.codex/skills/design-macos-apps-upstream-workspace

python3 -m unittest discover -s evals/regressions -p 'test_*.py' -v
```

For stability, rerun failed and high-risk cases for at least three iterations before treating a
single pass or failure as representative.

## Interpretation

- A deterministic PASS means the recorded deliverable met the case's reproducible contract. It is
  not proof that an unlaunched Mac UI is visually correct or accessible at runtime.
- An implementation PASS additionally means the fixture still targets macOS 14 and `swift build`
  succeeded. Window behavior, VoiceOver, focus, resizing, and appearance still require runtime
  evidence unless explicitly exercised.
- A semantic PASS means an independent judge found the recommendations supported and task-fit; it
  does not replace build or immutability checks.
- Report paired per-case outcomes, hard-violation rate, unsupported-claim rate, time, and tokens.
  Do not collapse the result into a prose-quality score.
