<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# PRD: SharedWorker runtime mode for WebLLM connector

**Plan:** [todo/PLANS.md#p001](../PLANS.md)
**Task:** t004
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#4](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/4)
**Logged:** 2026-04-07
**Status:** Planning
**Estimate:** ~30h (ai:24h test:5h read:1h)

## Problem statement

The current plugin requires every user to manually navigate to `Tools → WebLLM Worker`, click "Load model", and keep that browser tab open at all times. If the tab is closed or the user reloads any wp-admin page, the model unloads and AI features start returning 503. This breaks the "install + activate and it just works" promise of a WordPress plugin.

The user-facing goal: **after install + activate, AI tools just work**. The first AI feature invocation triggers a one-time start prompt; from then on, a small floating icon shows model status, and the model survives navigation across all wp-admin (and optionally front-end) pages until the user closes the last tab on the install.

## Background and constraints

### Technical findings (from investigation 2026-04-07)

- Chrome 124+ (April 2024) ships WebGPU support in **both** ServiceWorker AND SharedWorker global scopes. Source: [What's New in WebGPU (Chrome 124)](https://developer.chrome.com/blog/new-in-webgpu-124).
- The official `mlc-ai/web-llm-chat` (powering `chat.webllm.ai`) uses ServiceWorker, not SharedWorker — but only because it's a Next.js SPA without our cross-page navigation problem. They use a 5-second keep-alive ping (`KEEP_ALIVE_INTERVAL = 5_000`) to fight Chrome's idle-kill of the service worker.
- `@mlc-ai/web-llm` exports `WebWorkerMLCEngine` (dedicated) and `ServiceWorkerMLCEngine`, but **NO `SharedWorkerMLCEngine`**. We must build a thin handler ourselves modelled on `WebWorkerMLCEngineHandler`.
- For our use case (multi-page wp-admin), SharedWorker is actually a better fit than ServiceWorker:
  - Not killed by browser when idle — lives until the last connected tab closes
  - One natural instance per browser per origin (no coordination needed)
  - Same WebGPU semantics as ServiceWorker in Chrome 124+
  - Simpler lifecycle (no install/activate dance, no scope rules, no fetch interception)

### Browser support matrix

| Browser | WebGPU | + DedicatedWorker | + SharedWorker | + ServiceWorker |
|---|---|---|---|---|
| Chrome 124+ desktop | yes | yes | yes | yes |
| Chrome <124 | yes | yes | no | no |
| Edge 124+ | yes | yes | yes | yes |
| Safari (macOS/iOS) | no | n/a | n/a | n/a |
| Firefox stable | no (flag) | n/a | n/a | n/a |

Practical conclusion: anyone with WebGPU is on Chromium ≥124, which means the SharedWorker path is available. The dedicated-tab fallback is needed for the same browsers that need it today.

### Hard constraints (cannot change)

- All existing PHP REST routes (`/wp-json/webllm/v1/...`) must keep working unchanged.
- `Job_Queue` with its raw `$wpdb` + `COMMIT` long-polling trick stays unchanged.
- Bearer-token loopback auth + `client_permission_callback` stays unchanged.
- `WebLlmProvider` / `WebLlmModel` / `WebLlmModelDirectory` PHP classes stay unchanged.
- All existing settings stay (with additions, not replacements).
- The "phone uses desktop GPU" feature must keep working.
- Existing dedicated-tab worker page (`Tools → WebLLM Worker`) stays as a manual fallback.
- No new third-party PHP dependencies.

## Goals (success criteria)

1. **Zero-config first-run experience**: A user installing the plugin on Chrome 124+ desktop, without changing any settings, can use any AI feature successfully after one click in a start modal.
2. **Cross-page persistence**: Loading a model in one wp-admin page keeps it loaded as the user navigates between wp-admin pages and (optionally) the front-end.
3. **Resource discipline**: Closing the last wp-admin tab unloads the GPU buffers (no forever-resident memory after the user leaves).
4. **Floating status indicator**: A small floating icon visible on every page where the widget is enabled, showing model name + idle/busy state, with a one-click stop button.
5. **Graceful fallback**: Browsers without SharedWorker+WebGPU support automatically fall back to the existing dedicated-tab flow without an error or broken state.
6. **No regression**: All existing PHP-side AI consumers (AI Experiments excerpt generator, etc.) continue to work without code changes on their side.

## Non-goals

- Token streaming (same limitation as today; would require SSE upgrade in the broker).
- VLM (vision-language) model support.
- Multiple-model support (still one model loaded at a time).
- Mobile / iOS support (no WebGPU there yet).
- Replacing the PHP broker with a pure-JS architecture.
- Multi-user GPU sharing across browsers / multiple admins competing for one GPU.

## Open design decisions to resolve

These need answers before implementation phases 3, 5, and 6 can start.

### D1: apiFetch interception strategy

When a PHP-side AI consumer (e.g. AI Experiments) makes a request that would route through WebLLM and the model isn't loaded, how does the floating widget catch it and show the start modal?

| Option | Pros | Cons |
|---|---|---|
| **Soft (poll status)** | No coupling to other plugins; works without their cooperation | User sees the failure first, then the prompt — bad UX |
| **Better (intercept apiFetch)** | Can prevent the failed request entirely | Requires maintaining a list of "AI-using endpoints" or upstream cooperation |
| **Hybrid** | Best UX for known endpoints, graceful degradation for unknown ones | More code, more edge cases |

**Recommended:** Hybrid. Intercept the bundled WP AI Client SDK requests (well-known) by hooking `wp.apiFetch.use()` middleware on the editor side. For unknown endpoints, fall back to the soft path (post-failure prompt). Document the integration hook for plugin authors who want the better UX.

### D2: Auto-start vs on-demand model load default

Should the floating widget auto-load the model on every page load, or wait until the user explicitly clicks "start" / triggers an AI feature?

| Option | Pros | Cons |
|---|---|---|
| **Auto-start always** | AI is instant when needed | Multi-GB GPU buffer allocation on every page even if user never uses AI; battery drain |
| **On-demand only** | No wasted resources | First AI request has 2-15s wait |
| **Smart auto-start** | Auto-start if model loaded recently in this browser session | More logic, harder to predict for users |

**Recommended:** On-demand by default, with an opt-in "always keep loaded" setting for power users. First-run modal explains the trade-off.

### D3: SharedWorker URL stability

SharedWorkers are keyed by `(script URL, name)`. If we put a content hash in the URL on every build, users will end up running multiple SharedWorkers simultaneously after every plugin update — VRAM disaster.

| Option | Pros | Cons |
|---|---|---|
| **Stable URL, version via postMessage** | One worker per origin always | Version-mismatch handling needed |
| **Hash in URL** | Standard cache busting | Multi-worker hell |
| **Stable URL + query string version** | Compromise | Browsers may or may not key on query string |

**Recommended:** Stable URL (`build/shared-worker.js` with no hash), version sent via postMessage on connect, worker self-terminates if it detects a version mismatch from connecting clients. Document the trade-off in the changelog.

### D4: Floating widget on front-end pages

Should the widget render on the front-end (`wp_footer`) by default, or only in `admin_footer`?

| Option | Rationale |
|---|---|
| **Admin only by default** | Most plugins that need WebLLM are admin-side; less surprise for site visitors |
| **Admin + front-end opt-in** | Some plugins may want to use AI on the front-end (search assistant, chatbots); admin sets a checkbox |
| **Always both** | Maximum availability but visible to anonymous visitors |

**Recommended:** Admin only by default, opt-in setting `webllm_widget_on_frontend` (only renders for logged-in users with `manage_options` even when enabled).

## Architecture

### What stays exactly the same

- All PHP REST routes (`/wp-json/webllm/v1/chat/completions`, `/jobs/next`, `/jobs/{id}/result`, `/register-worker`, `/status`, `/models`)
- `inc/class-job-queue.php` (the broker queue)
- `inc/class-provider.php`, `inc/class-model.php`, `inc/class-model-directory.php`
- `inc/provider-registration.php`
- `inc/http-filters.php`
- All settings keys (with new ones added)
- The bearer-token loopback auth flow
- The "remote clients" (allow non-admin logged-in users) feature
- The existing `Tools → WebLLM Worker` page (kept as fallback, possibly renamed)

### New files

| File | Purpose | Est LOC |
|---|---|---|
| `src/shared-worker.js` | SharedWorker entry point. Hosts `MLCEngine` inside `SharedWorkerGlobalScope`, maintains `Set<MessagePort>` of connected tabs, holds the broker-polling loop, owns model state. | ~200 |
| `src/floating-widget.jsx` | React floating widget injected on every admin (and optionally front-end) page. Renders three states: hidden, floating icon corner badge, modal (first-run / start prompt / progress). Connects to SharedWorker via `new SharedWorker(...)`. UI surface only — never holds the engine. | ~400 |
| `src/widget-bootstrap.js` | <5 KB inline script. Capability-detects `SharedWorker` + `navigator.gpu`, reads user prefs, lazy-loads the floating widget. | ~80 |
| `inc/widget-injector.php` | Hooks `admin_footer` (and `wp_footer` if enabled) to render the mount point and enqueue the bootstrap. | ~60 |

### Modified files

| File | Change |
|---|---|
| `inc/settings.php` | Add `webllm_runtime_mode` (`auto`/`shared-worker`/`dedicated-tab`/`disabled`), `webllm_widget_on_frontend` (bool), `webllm_widget_autostart` (bool), `webllm_widget_enabled` (bool). |
| `src/connector.jsx` | Show "Active runtime: SharedWorker / Dedicated tab", expose new settings, demote "Open worker tab" button to a fallback action. |
| `inc/admin.php` | Rename dedicated worker page to "WebLLM Worker (Manual mode)", make conditionally visible. |
| `inc/rest-api.php` | Add `GET /runtime-mode` so the bootstrap script can check admin pref before loading the heavy widget bundle. |
| `ultimate-ai-connector-webllm.php` | Register new injector hook, conditionally enqueue widget bootstrap. |
| `webpack.config.js` | Add `shared-worker` and `widget-bootstrap` and `floating-widget` as additional entry points. |
| `.distignore` | No change expected (src/ already excluded). |
| `README.md` and `readme.txt` | Update to describe the new zero-config flow + fallback. |

### Data flow (new)

```text
PHP AI SDK -> /wp-json/webllm/v1/chat/completions
                  | enqueue job (UNCHANGED)
                  | wait_for_result long-poll (UNCHANGED)
                  v
        SharedWorker (one per browser per origin)
        polling /jobs/next   <-- this used to be worker.jsx in a dedicated tab
                  | engine.chat.completions.create(...)
                  | POST /jobs/{id}/result (UNCHANGED)

        Floating widget tabs (one per tab)
                  | connect to SharedWorker on page load
                  | listen for state updates via MessagePort
                  | render icon / modal / progress UI
                  v
              user sees status everywhere
```

## Phases

### Phase 1: Spike on AI Client SDK editor integration hooks (~2h)

**Output:** A short markdown note in `todo/tasks/spike-shared-worker-apifetch.md` documenting:

- How AI Experiments invokes the bundled WP AI Client SDK on the editor side
- What apiFetch hooks (`wp.apiFetch.use(...)`) are available to intercept requests
- Whether the bundled SDK exposes any JS event we can listen for
- A clear go/no-go on the "better path" (full apiFetch interception) vs. "soft path" (post-failure prompt)
- Recommended D1 answer with concrete code sketch

**Why first:** This determines whether Phase 6 is 2h or 8h.

**Acceptance:** Spike doc exists; D1 design decision is locked; the recommendation is reviewed and confirmed by the user.

### Phase 2: SharedWorker handler + MLCEngine wrapper (~5h)

**Output:**

- New `src/shared-worker.js` with:
  - `connect` event listener that adds incoming `MessagePort` to a connection set
  - Single `MLCEngine` instance reused across all connections
  - RPC dispatcher modelled on `WebWorkerMLCEngineHandler.onmessage`
  - Methods: `loadModel(modelId)`, `unloadModel()`, `chat(...)`, `getStatus()`, `getProgress()`
  - State broadcast: when state changes (loading, loaded, error), send to ALL connected ports
  - Connection-counting with disconnect detection (when last port closes, optional auto-unload)
  - Version handshake on connect (D3)
- Webpack entry point added
- Standalone test HTML page (gitignored, not shipped) that opens the worker, loads a small model, runs a chat completion, and verifies state broadcast across two tabs

**Acceptance:** Two browser tabs both pointing at the test HTML page can independently call chat completion against ONE shared MLCEngine instance, see each other's state updates in real-time, and the worker survives navigation between the tabs.

### Phase 3: Floating widget UI + state machine (~7h)

**Output:** New `src/floating-widget.jsx` with:

- React component tree: `<WidgetRoot>`, `<FloatingIcon>`, `<StartModal>`, `<ProgressBar>`, `<ErrorBanner>`
- State machine: `idle` -> `starting` -> `loading` -> `ready` -> (`busy` <-> `ready`) -> `unloaded`
- Connects to SharedWorker, listens for state, dispatches user actions
- Auto-detect recommended model based on hardware (reuse `autoPickModel` logic from existing `worker.jsx`)
- First-run onboarding modal (one-time)
- Stop button on the floating icon
- Accessible (keyboard navigation, ARIA labels, screen reader announcements for state changes)

**Acceptance:** Storybook-style standalone test HTML loads the widget connected to a stub SharedWorker; all state transitions render correctly; modal is keyboard-navigable.

### Phase 4: Bootstrap, injector, capability detection (~3h)

**Output:**

- `src/widget-bootstrap.js` (small): feature-detects and lazy-loads the widget
- `inc/widget-injector.php`: WordPress hook integration
- Conditional rendering based on `webllm_runtime_mode` and `webllm_widget_enabled`
- Capability detection: `'SharedWorker' in window`, `'gpu' in navigator`, plus a probe message to confirm WebGPU works inside the SharedWorker (fallback if Chrome version < 124)

**Acceptance:** Plugin activated, no settings touched, opening any wp-admin page injects the bootstrap, which detects capability and loads the widget. Older browser → bootstrap silently does nothing and the existing dedicated tab option still works.

### Phase 5: Settings + connector card UI update (~3h)

**Output:**

- New options registered in `inc/settings.php` with sane defaults
- Updated connector card in `src/connector.jsx`:
  - "Active runtime" indicator
  - Toggle for `webllm_widget_enabled` (default: on)
  - Toggle for `webllm_widget_on_frontend` (default: off)
  - Toggle for `webllm_widget_autostart` (default: off)
  - Mode override dropdown (`auto` / `shared-worker` / `dedicated-tab` / `disabled`)
  - Demoted "Open worker tab" link (only shown when in dedicated-tab mode)

**Acceptance:** All new settings persist; UI correctly reflects current state; defaults work for the zero-config flow.

### Phase 6: Editor middleware integration (apiFetch hook) (~5h)

**Output:** Implementation of whatever D1 strategy was locked in Phase 1.

If hybrid (recommended):

- A new small JS bundle that registers `wp.apiFetch.use()` middleware
- Middleware checks the local SharedWorker state for any request to a known WebLLM-using path
- If model not ready, holds the request, signals the floating widget to show the start modal, awaits user choice
- On modal accept + load complete, releases the held request
- On modal cancel, fails the request with a clear error

**Acceptance:** With AI Experiments installed and active, clicking the excerpt generator on a fresh post when no model is loaded shows the start modal, loading completes, and the excerpt is generated — all without an intermediate failure shown to the user.

### Phase 7: Cross-browser testing + dedicated-tab fallback (~4h)

**Output:** Manual test report covering:

- Chrome 124, Chrome 130, Chrome 140 (latest stable) — primary target
- Edge latest
- Chrome on Linux (integrated Intel iGPU) — slow but should work
- Chrome on Linux (NVIDIA discrete) — fast path
- Chromium <124 → fallback to dedicated tab
- Firefox stable → fallback to dedicated tab (and dedicated tab fails because no WebGPU; verify error message is clear)
- Safari → fallback to dedicated tab (same)
- Multi-tab scenarios: open 3 wp-admin tabs, verify only ONE worker is alive, verify state is consistent across tabs, close 2 tabs, verify worker stays alive, close last tab, verify worker terminates
- Multi-user scenarios: two admins logged in on different browsers, verify they don't interfere with each other

**Acceptance:** Test report with pass/fail per scenario, any failures captured as follow-up tasks.

### Phase 8: Docs, .distignore, readme updates (~2h)

**Output:**

- Updated `README.md` with the new zero-config flow as the primary path
- Updated `readme.txt` (WordPress.org metadata) with new screenshots and changelog entry
- Inline docblocks for new PHP files
- Update `AGENTS.md` "Architecture" section with the new diagram
- Update `.distignore` if any new dev-only files need exclusion

**Acceptance:** A user reading only `README.md` understands the new flow without needing to look at the code.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| `@mlc-ai/web-llm` engine internals change in a future version, breaking our custom SharedWorker handler | Med | High | Pin web-llm version; write integration tests; consider upstreaming a `SharedWorkerMLCEngine` PR |
| Chrome regresses WebGPU-in-SharedWorker | Low | High | Capability detection always runs at boot; auto-fallback to dedicated tab if probe fails |
| AI Experiments (or other consumer plugins) change their request shape | Med | Med | Hybrid D1 strategy gracefully degrades; soft path always works |
| SharedWorker URL hashing breaks state across plugin updates | Med | High | D3 stable-URL strategy; version mismatch handling in worker |
| User has multiple wp installs at the same hostname (e.g. multisite) | Med | Med | SharedWorker is per-origin, not per-install — needs investigation; may need to namespace by `wp_options.siteurl` |
| Cross-browser test matrix takes longer than estimated | High | Low | Time-box Phase 7 to 4h; capture overflow as follow-up tasks |

## Acceptance criteria (overall plan)

1. Fresh WordPress install + plugin activation + AI Experiments install + plugin activation → user clicks "Generate excerpt" on a new post → start modal appears → user clicks Start → progress bar fills → excerpt is generated. **Zero settings changes required.**
2. After step 1, the user navigates to a different wp-admin page (e.g. Posts list). The floating icon is visible in the corner showing model name and idle state. The model is NOT reloaded.
3. The user clicks "Generate excerpt" on a different post. The icon pulses (busy state); the excerpt is generated faster than step 1 because the model is already loaded.
4. The user closes ALL wp-admin tabs. Reopens wp-admin. The floating icon shows "offline" state. Clicking the next AI feature triggers re-load from IndexedDB cache (faster than first time, no re-download).
5. The user opens wp-admin in Safari. The bootstrap detects no WebGPU/SharedWorker. The floating widget does NOT appear. The existing `Tools → WebLLM Worker (Manual mode)` page is still available and functional.
6. All existing automated tests (`composer test`) still pass.

## Linkage (The Pin)

| Concept | Files | Lines | Synonyms |
|---|---|---|---|
| Existing dedicated-tab worker | `src/worker.jsx` | 1-end | worker tab, worker page, MLCEngine host, `Tools → WebLLM Worker` |
| Broker REST API | `inc/rest-api.php` | 1-end | broker, REST endpoints, `/wp-json/webllm/v1/*`, long-poll |
| Job queue | `inc/class-job-queue.php` | 1-end | queue, `Job_Queue`, `wait_for_result`, raw `$wpdb`, `COMMIT` |
| Provider/Model SDK glue | `inc/class-provider.php`, `inc/class-model.php`, `inc/class-model-directory.php` | all | WP AI Client SDK provider, WebLLM provider |
| Settings page + connector card | `inc/settings.php`, `src/connector.jsx` | all | options, connector UI, `webllm_*` options |
| Plugin entry + hook registration | `ultimate-ai-connector-webllm.php` | 1-end | bootstrap, plugin file, hook registration |
| WebLLM npm package | `node_modules/@mlc-ai/web-llm/lib/index.d.ts` | 1-end | `MLCEngine`, `WebWorkerMLCEngineHandler`, `ServiceWorkerMLCEngineHandler` (no SharedWorker variant!) |
| Reference: how mlc-ai/web-llm-chat does it | `https://github.com/mlc-ai/web-llm-chat/blob/main/app/client/webllm.ts` and `app/worker/service-worker.ts` | n/a | chat.webllm.ai, official demo, ServiceWorker keep-alive |
| Reference: Chrome 124 release notes | `https://developer.chrome.com/blog/new-in-webgpu-124` | n/a | WebGPU SharedWorker support |

## Definition of done

- All 8 phases marked complete in this PRD and in `todo/PLANS.md`
- t004 closed
- PR merged to `main`
- Acceptance criteria 1-6 verified manually and documented in the PR description
- Cross-browser test report attached to the PR
- Changelog updated in `readme.txt`
