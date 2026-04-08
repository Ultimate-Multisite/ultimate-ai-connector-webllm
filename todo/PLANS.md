---
mode: subagent
---

<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->
# Execution Plans

Complex, multi-session work requiring research, design decisions, and detailed tracking.

Based on [OpenAI's PLANS.md](https://cookbook.openai.com/articles/codex_exec_plans) with TOON-enhanced parsing and [Beads](https://github.com/steveyegge/beads) integration for dependency visualization.

<!--TOON:meta{version,format,updated}:
1.0,plans-md+toon,{{DATE}}
-->

## Format

Each plan includes:
- **Plan ID**: `p001`, `p002`, etc. (for cross-referencing)
- **Status**: Planning / In Progress (Phase X/Y) / Blocked / Completed
- **Time Estimate**: `~2w (ai:1w test:0.5w read:0.5w)`
- **Timestamps**: `logged:`, `started:`, `completed:`
- **Dependencies**: `blocked-by:p001` or `blocks:p003`
- **Linkage (The Pin)**: File:line references for search hit-rate (see below)
- **Progress**: Timestamped checkboxes with estimates and actuals
- **Decision Log**: Key decisions with rationale
- **Surprises & Discoveries**: Unexpected findings
- **Outcomes & Retrospective**: Results and lessons (when complete)

### Linkage (The Pin)

Based on [Loom's spec-as-lookup-table pattern](https://ghuntley.com/ralph/), each plan should include a Linkage section that functions as a lookup table for AI search:

| Concept | Files | Lines | Synonyms |
|---------|-------|-------|----------|
| {concept} | {file path} | {line range} | {related terms} |

**Why this matters:**
- Reduces hallucination by providing explicit anchors
- Improves search hit-rate with synonyms
- Points to exact file hunks for context
- Prevents AI from inventing when it should reference

## Active Plans

<!-- Add active plans here - see Plan Template below -->

### p001: SharedWorker runtime mode for WebLLM connector

**Status:** Planning
**Owner:** @themarcusquinn
**Tags:** #feature #enhancement #plan
**Estimate:** ~30h (ai:24h test:5h read:1h)
**Task:** t004
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#4](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/4)
**PRD:** [todo/tasks/prd-shared-worker-runtime.md](tasks/prd-shared-worker-runtime.md)
**Logged:** 2026-04-07

#### Purpose

Replace the dedicated `Tools → WebLLM Worker` tab with an auto-injected SharedWorker so the LLM survives page navigation and is invisible/zero-config for users. After install + activate, AI tools "just work": first AI request triggers a start modal, model loads, a small floating icon shows status across all subsequent admin pages, and the model stays loaded as long as any tab on the install is open.

The current dedicated worker tab requires the user to manually navigate, click "Load model", and keep that tab open. Users forget. AI features 503. This breaks the WordPress "install + activate and it just works" promise. SharedWorker (Chrome 124+) gives us cross-page persistence without ServiceWorker's idle-kill problem.

#### Development Environment

| Item | Value |
|---|---|
| Language/runtime | PHP 8.2+ (composer platform pin), Node 20+ for build |
| PHP install | `composer install` (devs) or `composer install --no-dev` (release) |
| JS install | `npm install` |
| Build | `npm run build` (auto-archives to `ultimate-ai-connector-webllm.zip` via `postbuild` → `archive`) |
| Watch | `npm run start` |
| Tests | `composer test` (PHPUnit) |
| Do NOT | edit `build/` (generated); commit `node_modules/`; commit `.zip` artefacts |

#### Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---|---|---|---|
| Existing dedicated-tab worker (the thing being replaced) | `src/worker.jsx` | all | worker tab, worker page, MLCEngine host, `Tools → WebLLM Worker` |
| Broker REST API (UNCHANGED) | `inc/rest-api.php` | all | broker, REST endpoints, `/wp-json/webllm/v1/*`, long-poll |
| Job queue (UNCHANGED) | `inc/class-job-queue.php` | all | queue, `Job_Queue`, `wait_for_result`, raw `$wpdb`, `COMMIT` |
| Provider/Model SDK glue (UNCHANGED) | `inc/class-provider.php`, `inc/class-model.php`, `inc/class-model-directory.php` | all | WP AI Client SDK provider, WebLLM provider |
| Settings page + connector card (will be modified) | `inc/settings.php`, `src/connector.jsx` | all | options, connector UI, `webllm_*` options |
| Plugin entry + hook registration (will be modified) | `ultimate-ai-connector-webllm.php` | all | bootstrap, plugin file, hook registration |
| Admin page (will be renamed/demoted) | `inc/admin.php` | all | `Tools → WebLLM Worker (Manual mode)` |
| WebLLM npm package (no SharedWorker variant!) | `node_modules/@mlc-ai/web-llm/lib/index.d.ts` | all | `MLCEngine`, `WebWorkerMLCEngineHandler`, `ServiceWorkerMLCEngineHandler` |
| Reference: web-llm-chat ServiceWorker pattern | external: `mlc-ai/web-llm-chat` `app/client/webllm.ts` and `app/worker/service-worker.ts` | n/a | chat.webllm.ai, official demo, ServiceWorker keep-alive |
| Reference: Chrome 124 SharedWorker WebGPU | external: `developer.chrome.com/blog/new-in-webgpu-124` | n/a | WebGPU SharedWorker support release notes |

#### Progress

- [ ] (2026-04-07) Phase 1: Spike on AI Client SDK editor integration hooks ~2h
- [ ] (2026-04-07) Phase 2: SharedWorker handler + MLCEngine wrapper ~5h
- [ ] (2026-04-07) Phase 3: Floating widget UI + state machine ~7h
- [ ] (2026-04-07) Phase 4: Bootstrap, injector, capability detection ~3h
- [ ] (2026-04-07) Phase 5: Settings + connector card UI update ~3h
- [ ] (2026-04-07) Phase 6: Editor middleware integration (apiFetch hook) ~5h
- [ ] (2026-04-07) Phase 7: Cross-browser testing + dedicated-tab fallback ~4h
- [ ] (2026-04-07) Phase 8: Docs, .distignore, readme updates ~2h

#### Open design decisions (locked in PRD)

- **D1 — apiFetch interception strategy**: hybrid (intercept known WP AI Client SDK requests, soft fallback for unknown plugins) — *spike in Phase 1 to confirm*
- **D2 — Auto-start vs on-demand**: on-demand by default, opt-in `webllm_widget_autostart` for power users
- **D3 — SharedWorker URL stability**: stable URL (`build/shared-worker.js` no hash), version sent via postMessage, worker self-terminates on mismatch
- **D4 — Front-end widget**: admin-only by default, opt-in `webllm_widget_on_frontend`

See [PRD](tasks/prd-shared-worker-runtime.md) for full rationale.

#### Context from discussion

Investigation findings (full detail in PRD):

1. **SharedWorker is the right primitive**, despite the official MLC team using ServiceWorker. They use SW because `chat.webllm.ai` is an SPA that doesn't have our cross-page navigation problem. SharedWorker is genuinely better for wp-admin's multi-page architecture: not killed by browser when idle, naturally one-per-origin, simpler lifecycle, no fetch interception side effects.
2. **Chrome 124+ ships WebGPU in SharedWorker**. The browser support cliff is in exactly the same place as today's WebGPU cliff, so no realistic users get worse off.
3. **`@mlc-ai/web-llm` does NOT ship `SharedWorkerMLCEngine`**. We must build a thin handler ourselves (~150 LOC), modelled on the existing `WebWorkerMLCEngineHandler`. This is a credible upstream contribution opportunity.
4. **The PHP broker stays unchanged**. Only the consumer (currently the dedicated tab; will become the SharedWorker) changes.
5. **Trickiest piece is the editor integration** (Phase 6). Phase 1 is a spike specifically to determine whether the "better path" (apiFetch interception) is 2h or 8h.

#### Decision Log

(To be populated during implementation)

#### Surprises & Discoveries

(To be populated during implementation)

<!--TOON:active_plans[1]{id,title,status,phase,total_phases,owner,tags,est,est_ai,est_test,est_read,logged,started}:
p001,SharedWorker runtime mode for WebLLM connector,Planning,0,8,@themarcusquinn,feature/enhancement,30h,24h,5h,1h,2026-04-07,
-->

## Completed Plans

<!-- Move completed plans here with Outcomes & Retrospective -->

<!--TOON:completed_plans[0]{id,title,owner,tags,est,actual,logged,started,completed,lead_time_days}:
-->

## Archived Plans

<!-- Plans that were abandoned or superseded -->

<!--TOON:archived_plans[0]{id,title,reason,logged,archived}:
-->

---

## Plan Template

```markdown
### p00X: Plan Title

**Status:** Planning
**Owner:** @username
**Tags:** #tag1 #tag2
**Estimate:** ~Xd (ai:Xd test:Xd read:Xd)
**Dependencies:** blocked-by:p001 (if any)
**PRD:** [todo/tasks/prd-{slug}.md](tasks/prd-{slug}.md)
**Tasks:** [todo/tasks/tasks-{slug}.md](tasks/tasks-{slug}.md)
**Logged:** YYYY-MM-DD

#### Purpose

Brief description of why this work matters.

#### Development Environment

<!-- Required for Python, Node.js, and any project with non-trivial setup.
     Workers read this section to avoid broken installs in worktrees. -->

| Item | Value |
|------|-------|
| Language/runtime | e.g. Python 3.12, Node 20 |
| Venv/install | e.g. `python3 -m venv .venv && pip install -e ".[dev]"` |
| Tests | e.g. `source .venv/bin/activate && pytest` |
| Do NOT | e.g. install globally; run `pip install -e` from worktree using canonical venv |

#### Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---------|-------|-------|----------|
| {main concept} | src/path/file.ts | 45-120 | {term1}, {term2} |
| {related concept} | src/path/other.ts | 12-89 | {term3}, {term4} |

#### Progress

- [ ] (YYYY-MM-DD HH:MMZ) Phase 1: Description ~Xh
- [ ] (YYYY-MM-DD HH:MMZ) Phase 2: Description ~Xh

#### Decision Log

(Decisions recorded during implementation)

#### Surprises & Discoveries

(Unexpected findings during implementation)
```

---

## Analytics

<!--TOON:dependencies-->
<!-- Format: child_id|relation|parent_id -->
<!--/TOON:dependencies-->

<!--TOON:analytics{total_plans,active,completed,archived,avg_lead_time_days,avg_variance_pct}:
0,0,0,0,,
-->
