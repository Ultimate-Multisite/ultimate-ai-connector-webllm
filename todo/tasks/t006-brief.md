<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t006: Phase 2 — SharedWorker handler + MLCEngine wrapper

**Session origin:** `opencode:interactive:2026-04-07` (Phase 2 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#6](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/6)
**Tier:** `tier:standard`
**Status:** `status:available` (first phase, no blockers)
**Estimate:** ~5h
**Auto-dispatch:** yes
**Parent plan:** [p001 SharedWorker runtime](../PLANS.md) — Phase 2 of 8
**Blocks:** t007 (Phase 3), t008 (Phase 4), t009 (Phase 5), t010 (Phase 6), t011 (Phase 7), t012 (Phase 8)
**Blocked-by:** none

## What

Create `src/shared-worker.js` — a new SharedWorker entry point that hosts a single `MLCEngine` instance inside `SharedWorkerGlobalScope`, maintains a set of connected `MessagePort`s (one per browser tab), and exposes an RPC-style message API for loading models, running chat completions, and broadcasting state changes to all connected tabs.

Also add the new entry point to `webpack.config.js` so `npm run build` produces `build/shared-worker.js` alongside the existing `build/worker.js` and `build/connector.js`.

This is the foundation for every other phase of p001. Without it, Phase 3 (floating widget) has nothing to connect to.

## Why

The current dedicated `Tools → WebLLM Worker` tab (`src/worker.jsx`) holds the `MLCEngine` inside a regular React page that dies on navigation. For p001's zero-config UX to work, the engine has to survive page navigation and be reachable from any tab on the origin. A `SharedWorker` is the right primitive because:

- It lives until the LAST connected tab closes (unlike ServiceWorkers which Chrome kills after ~30s idle).
- It's automatically shared across all same-origin pages (unlike DedicatedWorkers which are per-page).
- Chrome 124+ ships `navigator.gpu` inside `SharedWorkerGlobalScope`, so WebGPU works there ([Chrome 124 release notes](https://developer.chrome.com/blog/new-in-webgpu-124)).

Full rationale in the PRD: [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) → "Background and constraints".

## How

### Files to modify

**NEW:** `src/shared-worker.js` (~200 LOC)
**EDIT:** `webpack.config.js` — add `'shared-worker': path.resolve(__dirname, 'src/shared-worker.js')` to the entry map (current file has `worker` and `connector` entries — model on them).

### Reference pattern

Model the handler structure on the existing dedicated-worker handler from `@mlc-ai/web-llm`:

- `node_modules/@mlc-ai/web-llm/lib/web_worker.d.ts` — shows `WebWorkerMLCEngineHandler` API surface (`onmessage(msg)`, `setInitProgressCallback`, etc.)
- `https://github.com/mlc-ai/web-llm-chat/blob/main/app/worker/web-worker.ts` — the minimal real-world dedicated worker implementation (just ~20 lines wrapping `WebWorkerMLCEngineHandler`)
- `https://github.com/mlc-ai/web-llm-chat/blob/main/app/worker/service-worker.ts` — shows how the service-worker variant handles `navigator.gpu` probing and the multi-port message routing pattern

The key difference for SharedWorker: we DON'T have a ready-made `SharedWorkerMLCEngineHandler` class from the upstream package. We wrap `MLCEngine` directly and implement message routing ourselves.

Also model the existing dedicated worker page's auto-model selection logic at `src/worker.jsx` — the `autoPickModel` function (hardware detection based on `navigator.gpu.requestAdapter()` + heuristics). That logic is reusable verbatim inside the SharedWorker.

### Architecture

```
src/shared-worker.js (runs in SharedWorkerGlobalScope)
 |
 +-- single MLCEngine instance (created lazily on first "load" command)
 +-- Set<MessagePort> of connected tabs
 +-- current state: 'idle' | 'loading' | 'ready' | 'busy' | 'error'
 +-- current model ID + init progress
 +-- polling loop for /wp-json/webllm/v1/jobs/next (when ready)
 |
 +-- on 'connect' event:
 |    +-- push port into the set
 |    +-- send current state snapshot to the new port
 |    +-- attach port.onmessage handler
 |    +-- attach port.onmessageerror/disconnect handler
 |
 +-- on port.onmessage (RPC dispatcher):
      +-- 'handshake': reply with version, supported models
      +-- 'getStatus': reply with current state
      +-- 'loadModel': call engine.reload(modelId), stream progress, set state
      +-- 'unloadModel': dispose engine, set state to idle
      +-- 'chat': pass through to engine.chat.completions.create, stream chunks
      +-- 'setNonce': store WP REST nonce for broker polling
```

### Code skeleton (fill in during implementation)

```javascript
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
//
// src/shared-worker.js — WebLLM engine host inside SharedWorkerGlobalScope.
//
// See todo/PLANS.md p001 and todo/tasks/prd-shared-worker-runtime.md
// for the full architectural context.

import {
    MLCEngine,
    prebuiltAppConfig,
} from '@mlc-ai/web-llm';

// ---------------------------------------------------------------------------
// Module-level state (shared across all connected tabs)
// ---------------------------------------------------------------------------

const VERSION = 1; // bump on breaking message-schema changes

/** @type {MLCEngine|null} */
let engine = null;

/** @type {'idle'|'loading'|'ready'|'busy'|'error'} */
let state = 'idle';

/** @type {string|null} */
let currentModelId = null;

/** @type {object|null} */
let currentProgress = null;

/** @type {string|null} */
let lastError = null;

/** @type {string|null} */
let restNonce = null;

/** @type {Set<MessagePort>} */
const ports = new Set();

/** @type {boolean} */
let pollingActive = false;

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

function broadcast(message) {
    for (const port of ports) {
        try { port.postMessage(message); } catch (_) {}
    }
}

function snapshot() {
    return {
        type: 'state',
        state,
        currentModelId,
        progress: currentProgress,
        error: lastError,
        version: VERSION,
    };
}

function setState(next, extra = {}) {
    state = next;
    if ('progress' in extra) currentProgress = extra.progress;
    if ('error' in extra) lastError = extra.error;
    broadcast(snapshot());
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

async function ensureEngine() {
    if (engine) return engine;
    engine = new MLCEngine({
        appConfig: prebuiltAppConfig,
        initProgressCallback: (report) => {
            setState('loading', { progress: report });
        },
    });
    return engine;
}

async function loadModel(modelId) {
    try {
        setState('loading', { progress: null, error: null });
        const e = await ensureEngine();
        await e.reload(modelId);
        currentModelId = modelId;
        setState('ready');
        startBrokerPolling();
    } catch (err) {
        setState('error', { error: String(err?.message || err) });
        throw err;
    }
}

async function unloadModel() {
    stopBrokerPolling();
    if (engine) {
        try { await engine.unload(); } catch (_) {}
        engine = null;
    }
    currentModelId = null;
    setState('idle', { progress: null, error: null });
}

// ---------------------------------------------------------------------------
// Broker polling (replaces the dedicated tab's job consumer role)
// ---------------------------------------------------------------------------

async function startBrokerPolling() {
    if (pollingActive) return;
    pollingActive = true;
    (async () => {
        while (pollingActive && state === 'ready') {
            try {
                const headers = { 'Content-Type': 'application/json' };
                if (restNonce) headers['X-WP-Nonce'] = restNonce;
                const res = await fetch('/wp-json/webllm/v1/jobs/next', {
                    method: 'GET',
                    headers,
                    credentials: 'same-origin',
                });
                if (res.status === 204) continue; // no job
                if (!res.ok) { /* log + back off */ continue; }
                const job = await res.json();
                await runJob(job);
            } catch (err) {
                // Network error or similar — back off 1s
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    })();
}

function stopBrokerPolling() {
    pollingActive = false;
}

async function runJob(job) {
    setState('busy');
    try {
        const result = await engine.chat.completions.create(job.request);
        await fetch(`/wp-json/webllm/v1/jobs/${job.id}/result`, {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...(restNonce ? { 'X-WP-Nonce': restNonce } : {}),
            },
            body: JSON.stringify({ result }),
        });
    } catch (err) {
        // Report job error back to broker
    } finally {
        if (state === 'busy') setState('ready');
    }
}

// ---------------------------------------------------------------------------
// Port / RPC handling
// ---------------------------------------------------------------------------

/**
 * @param {MessagePort} port
 * @param {MessageEvent} event
 */
async function handlePortMessage(port, event) {
    const msg = event.data || {};
    const reply = (data) => port.postMessage({ id: msg.id, ...data });

    switch (msg.type) {
        case 'handshake':
            reply({ type: 'handshake', version: VERSION, state: snapshot() });
            break;
        case 'getStatus':
            reply({ type: 'status', ...snapshot() });
            break;
        case 'setNonce':
            restNonce = msg.nonce || null;
            reply({ type: 'ok' });
            break;
        case 'loadModel':
            try {
                await loadModel(msg.modelId);
                reply({ type: 'ok' });
            } catch (err) {
                reply({ type: 'error', error: String(err?.message || err) });
            }
            break;
        case 'unloadModel':
            await unloadModel();
            reply({ type: 'ok' });
            break;
        default:
            reply({ type: 'error', error: `Unknown message type: ${msg.type}` });
    }
}

// ---------------------------------------------------------------------------
// SharedWorker entrypoint
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-restricted-globals
self.addEventListener('connect', (event) => {
    const port = event.ports[0];
    ports.add(port);

    port.onmessage = (ev) => handlePortMessage(port, ev);

    // Send initial state to this newly-connected port.
    port.postMessage({ type: 'hello', ...snapshot() });

    port.start?.();
});
```

### Testing (standalone, not shipped)

Create a throwaway `src/shared-worker-test.html` (add to `.gitignore`) that:
- Loads `build/shared-worker.js` via `new SharedWorker('build/shared-worker.js', { type: 'module' })`
- Has two iframes or two manual tabs both connecting to the same worker
- Sends `handshake`, `getStatus`, `loadModel`, `chat` RPCs and logs state broadcasts to both tabs
- Verifies that only ONE MLCEngine instance exists (memory footprint, not two)

Don't commit the test HTML. The acceptance criteria below cover what needs to demonstrably work.

### Gotchas

1. **SharedWorker URL identity (PRD D3).** SharedWorkers are keyed by `(script URL, name)`. Do NOT include a content hash in the URL or every plugin update will spawn a second worker alongside the first. Use a stable URL `build/shared-worker.js` (no hash) and include `VERSION` in the handshake response so clients can detect version mismatches and reconnect.
2. **Webpack entry output.** The existing webpack config produces `build/worker.js` and `build/connector.js` via `wp-scripts`. Adding an entry should "just work" but verify the output file lands at `build/shared-worker.js` specifically (not `build/index.js` or nested).
3. **Module imports.** Use ES module imports (`import { MLCEngine } from '@mlc-ai/web-llm'`) — the SharedWorker needs to be loaded with `{ type: 'module' }`.
4. **Don't import React.** This is pure JS, no JSX. It's `src/shared-worker.js`, not `.jsx`.
5. **`self` in SharedWorkerGlobalScope.** `self` is the global, `self.addEventListener('connect', ...)` is the entry point. `self.postMessage` does NOT exist in SharedWorker (only in DedicatedWorker) — you post to the individual port from the `connect` event.
6. **Broker polling cookies.** The SharedWorker's `fetch()` calls with `credentials: 'same-origin'` DO include the user's WordPress session cookies. This is how admin auth works. But the REST nonce must be passed in the `X-WP-Nonce` header — the SharedWorker doesn't have its own nonce, so the widget (Phase 3) must send it via `setNonce` RPC.
7. **Out of scope:** NOT this task — the floating widget (t007), the bootstrap/capability detector (t008), the settings UI (t009), the apiFetch middleware (t010). This task produces a *runnable* SharedWorker that can be exercised via a test HTML page, but no WordPress integration yet.

## Acceptance criteria

1. **`src/shared-worker.js` exists** and implements the skeleton above (fill in the TODO comments, but keep the same exported entry point and message schema).
2. **`webpack.config.js` updated** with a new `shared-worker` entry; `npm run build` produces `build/shared-worker.js` without errors.
3. **Lint passes:** `npm run lint:js` (or whatever the project's lint command is) reports no new errors on `src/shared-worker.js`.
4. **Two-tab smoke test (documented in the PR body):**
   - Open two browser tabs both pointing at a local test HTML page that connects to `build/shared-worker.js`.
   - Call `loadModel('<small model id>')` from tab 1.
   - Both tabs see `state: 'loading'` broadcast, then `state: 'ready'` broadcast.
   - Call `getStatus` from tab 2 → same state returned.
   - Only ONE MLCEngine instance is loaded (verified by checking GPU memory, or by adding a module-level counter log).
   - Close tab 1 → tab 2's port still works. Close tab 2 → worker terminates (browser process list verification optional).
5. **No regression to existing dedicated tab.** `build/worker.js` still exists and the Tools → WebLLM Worker page still loads normally. This task is additive.
6. **No PHP or WordPress integration.** The diff should touch only `src/shared-worker.js`, `webpack.config.js`, and possibly `package.json` (if a lint script needs updating). No `inc/` files. No `ultimate-ai-connector-webllm.php`.

## Verification commands

```bash
npm install
npm run build
ls -l build/shared-worker.js
# Should exist and be several hundred KB (the MLCEngine is bundled)

# Optional: grep the output for the SharedWorker global handler
rg "addEventListener.*connect" build/shared-worker.js

composer test
git diff --stat
# Expected: src/shared-worker.js (new), webpack.config.js (1-3 line change)
```

## Context

- **Plan:** [PLANS.md p001](../PLANS.md)
- **PRD:** [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md)
- **Spike:** [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) — not directly relevant to this task but provides the broader context for the RPC surface this worker needs to expose (the later phases will call `getStatus`, `loadModel`, etc.)
- **Existing reference:** `src/worker.jsx` — the current dedicated tab implementation. The `autoPickModel` function and the broker polling loop logic should be lifted into this new file with minimal changes.
- **WebLLM upstream:** [`mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) — note that there is NO `SharedWorkerMLCEngine` or `SharedWorkerMLCEngineHandler` class in the package. This task is writing the equivalent from scratch, wrapping `MLCEngine` directly.
- **Chrome release notes:** `https://developer.chrome.com/blog/new-in-webgpu-124` — confirms WebGPU + SharedWorker is shipped since April 2024.
