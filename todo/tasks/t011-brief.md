<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t011: Phase 7 — Cross-browser testing + dedicated-tab fallback verification

**Session origin:** `opencode:interactive:2026-04-07` (Phase 7 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#11](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/11)
**Tier:** `tier:standard`
**Status:** `status:blocked` (waiting on t006-t010)
**Estimate:** ~4h
**Auto-dispatch:** no — needs human on real hardware
**Parent plan:** [p001](../PLANS.md) — Phase 7 of 8
**Blocks:** t012
**Blocked-by:** t006, t007, t008, t009, t010 (needs everything built and integrated)

## What

Manually verify the full t004 implementation across the browsers and hardware configurations listed in the PRD. Produce a test report (markdown) attached to the eventual PR. Capture any failures as follow-up tasks.

**This task is NOT auto-dispatched.** Cross-browser testing requires physical hardware (integrated GPU, discrete GPU, different OS), multiple browser installs, and human judgement for UX regressions. A headless worker cannot do this meaningfully.

## Why

Software that ships with "works on my machine" has no future. The SharedWorker runtime touches multiple Chromium APIs, WebGPU, IndexedDB, and the interaction between tabs. Bugs will surface only on certain GPUs or certain browser versions. A structured test pass before merge is the cheapest way to catch them.

## How

### Environments to cover (from PRD acceptance criteria 1-6)

| # | Environment | Expected outcome |
|---|---|---|
| 1 | Chrome 124 desktop (discrete NVIDIA) | Full happy path. Phase 4 bootstrap loads, widget mounts, modal triggers on first AI call, model loads from IndexedDB cache on reload |
| 2 | Chrome 130 desktop (same hardware) | Same as #1 |
| 3 | Chrome 140 desktop (same hardware) | Same as #1 |
| 4 | Edge latest (Chromium-based) | Same as #1 |
| 5 | Chrome on Linux (integrated Intel iGPU) | Slow (single-digit tok/s) but functional. No crash. |
| 6 | Chrome on Linux (discrete NVIDIA) | Fast, full functionality |
| 7 | Chromium <124 (if we can get it) | Bootstrap detects no WebGPU-in-SharedWorker, falls back to dedicated tab link |
| 8 | Firefox stable | Bootstrap silently returns; existing dedicated tab option is also unavailable because Firefox has no WebGPU. Error message is clear. |
| 9 | Safari macOS | Same as Firefox — graceful degradation, clear error |

### Multi-tab scenarios

| # | Scenario | Expected |
|---|---|---|
| M1 | Open 3 wp-admin tabs | Only ONE SharedWorker instance (verify in `chrome://inspect/#workers`) |
| M2 | Load model in tab 1 | State broadcast reaches tab 2 and tab 3 within ~1s |
| M3 | Close 2 of 3 tabs | Worker stays alive, model still loaded |
| M4 | Close the last tab | Worker terminates (confirm in `chrome://inspect/#workers`) |
| M5 | Reopen wp-admin | Widget reconnects, status shows "idle" (SharedWorker was terminated). Next AI call shows modal with faster load (from IndexedDB) |

### Multi-user scenarios

| # | Scenario | Expected |
|---|---|---|
| U1 | Admin A logged in on Chrome, Admin B on Firefox, same browser, different profiles | Each has their own SharedWorker (per-profile); no interference |
| U2 | Same user on laptop + phone | Laptop serves AI requests; phone's REST client (via the broker) can submit jobs as before |

### Integration scenarios (require t005 merged)

| # | Scenario | Expected |
|---|---|---|
| I1 | Fresh session, no model loaded, click "Generate excerpt" in AI Experiments | Modal appears, user clicks Start, model loads, excerpt is generated |
| I2 | Same as I1 but user clicks Cancel | Editor shows a clean "WebLLM not ready" error, not 503 |
| I3 | After I1, navigate to a different post, click "Generate excerpt" again | No modal, excerpt generated immediately (model still loaded) |
| I4 | AI Experiments request for a non-WebLLM-routed feature (e.g. image gen with a commercial provider) | Middleware passes through, no modal, request goes to commercial provider |

### Regression scenarios (existing behaviour must still work)

| # | Scenario | Expected |
|---|---|---|
| R1 | Existing Tools → WebLLM Worker tab | Still loads, still functional (as fallback) |
| R2 | Connector card in Settings | Still shows existing settings + new runtime mode panel |
| R3 | `composer test` | All PHPUnit tests pass |
| R4 | `npm run build` | Produces all bundles without warnings |

### Output

Create `todo/tasks/t011-test-report.md` with one row per scenario: Pass / Fail / Skipped + notes. For each Fail: a root-cause hypothesis + whether to create a follow-up task or fix inline.

### Gotchas

1. **Don't skip WebGPU memory checks.** Load a 3B model, leave it loaded for 10 minutes, verify no memory leak in DevTools Memory profiler.
2. **Verify the SharedWorker URL is stable.** Check `chrome://inspect/#workers` across plugin rebuilds to ensure only one instance exists post-update.
3. **Network throttling.** Test on throttled 3G to see how the initial model download behaves for first-time users. The UI should stay responsive.
4. **Capture screenshots** of every unique UI state (idle icon, loading modal, ready icon, busy icon, error banner) for t012 docs to reference.

## Acceptance criteria

1. `todo/tasks/t011-test-report.md` exists and covers all scenarios above with Pass/Fail and notes.
2. Every Fail has either (a) a fix committed in a subsequent task, or (b) a captured follow-up issue on GitHub with the test scenario ID referenced.
3. Screenshots of every unique UI state captured and stored (either committed to `docs/screenshots/` or attached to the PR).
4. No Pass scenarios require manual intervention outside the start modal (e.g. no hidden "also open this URL" steps).
5. Multi-tab scenarios M1-M5 all Pass on at least Chrome 124 + Chrome latest.

## Context

- Depends on: all of t006-t010 merged
- Blocks: t012 (docs describe the verified behaviour)
- PRD reference: [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) → "Acceptance criteria (overall plan)"
- Risks table in PRD lists several items this task should verify (cross-browser test matrix overflow, multisite scope issue, etc.)
