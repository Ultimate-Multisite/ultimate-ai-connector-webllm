<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t007: Phase 3 — Floating widget UI + state machine

**Session origin:** `opencode:interactive:2026-04-07` (Phase 3 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#7](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/7)
**Tier:** `tier:standard`
**Status:** `status:blocked` (waiting on t006)
**Estimate:** ~7h
**Auto-dispatch:** yes (once unblocked)
**Parent plan:** [p001](../PLANS.md) — Phase 3 of 8
**Blocks:** t008, t009, t010, t011, t012
**Blocked-by:** t006 (needs the SharedWorker + RPC surface)

## What

Create `src/floating-widget.jsx` — a React component tree that auto-connects to the SharedWorker built in t006, renders a small floating icon + status in the corner of every admin page, shows a start modal when the user triggers an AI feature without a loaded model, and broadcasts a small public API on `window.webllmWidget` for the apiFetch middleware (t010) to call.

Also exposes `window.webllmWidget.getStatus()` and `window.webllmWidget.promptAndLoad()` — the two methods the Phase 6 middleware will await.

## Why

Phase 2 (t006) built the brain (SharedWorker + MLCEngine). This phase builds the face (UI) and the public JS API that integrates with the rest of the plugin and the apiFetch middleware. Without this, the SharedWorker is unreachable from normal admin pages and the "floating icon + start modal" UX spec from p001 has nothing rendering it.

## How

### Files to modify

**NEW:** `src/floating-widget.jsx` (~400 LOC)
**NEW:** `src/floating-widget.css` (~80 LOC) — scoped styles that don't leak into wp-admin
**EDIT:** `webpack.config.js` — add `'floating-widget'` entry

### Reference pattern

- Component structure: model on `src/worker.jsx` (the existing dedicated-tab page) — it uses React 18 + `@wordpress/element`, has similar state shape (model, progress, error)
- Styles: model on `src/connector.jsx` CSS approach — minimal, no global leak
- The SharedWorker RPC schema is defined in t006 brief. This task is the CLIENT of that schema.

### Architecture

```
src/floating-widget.jsx
 |
 +-- <WidgetRoot>               // top-level, manages SharedWorker connection
 |    |
 |    +-- useSharedWorker() hook  // opens SharedWorker, subscribes to state broadcasts
 |    |                            // calls handshake + setNonce on mount
 |    |
 |    +-- <FloatingIcon>        // the small corner badge (always visible when enabled)
 |    |    +-- shows state: idle / loading / ready / busy / error
 |    |    +-- click → toggle expanded panel
 |    |    +-- click Stop → dispatch 'unloadModel'
 |    |
 |    +-- <StartModal>          // shown when promptAndLoad() is called
 |    |    +-- hardware detection summary (GPU name, VRAM estimate)
 |    |    +-- recommended model + size + ETA
 |    |    +-- [Start] [Cancel] buttons
 |    |    +-- Start → dispatch 'loadModel', show progress, resolve on 'ready'
 |    |    +-- Cancel → reject promptAndLoad promise
 |    |
 |    +-- <ProgressBar>         // shown in modal during loading
 |    |
 |    +-- <ErrorBanner>         // shown when state === 'error'
```

### Public API on window

The widget mounts itself and exposes:

```js
window.webllmWidget = {
  // Returns current state snapshot ('idle'|'loading'|'ready'|'busy'|'error').
  getStatus: () => Promise<StateSnapshot>,

  // Shows the start modal if not ready; resolves when ready; rejects on cancel/error.
  promptAndLoad: () => Promise<void>,

  // For power users: explicit load with a specific model id.
  loadModel: (modelId) => Promise<void>,

  // Explicit unload.
  unloadModel: () => Promise<void>,

  // Subscribe to state changes; returns an unsubscribe function.
  subscribe: (callback) => () => void,
};
```

The apiFetch middleware in t010 consumes exactly this shape.

### Code skeleton

```jsx
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
//
// src/floating-widget.jsx — React floating widget + public JS API.

import { createRoot } from '@wordpress/element';
import { useEffect, useState, useCallback, useMemo, useRef } from '@wordpress/element';
import { __ } from '@wordpress/i18n';
import './floating-widget.css';

// ---------------------------------------------------------------------------
// SharedWorker client (wraps MessagePort)
// ---------------------------------------------------------------------------

function createSharedWorkerClient() {
    const url = window.webllmConnector?.sharedWorkerUrl || '/wp-content/plugins/ultimate-ai-connector-webllm/build/shared-worker.js';
    const worker = new SharedWorker(url, { type: 'module', name: 'ultimate-ai-connector-webllm' });
    const port = worker.port;
    port.start();

    const listeners = new Set();
    const pending = new Map(); // id -> {resolve, reject}
    let nextId = 1;

    port.onmessage = (event) => {
        const msg = event.data || {};
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            if (msg.type === 'error') reject(new Error(msg.error));
            else resolve(msg);
        }
        // Unsolicited state broadcasts
        if (msg.type === 'state' || msg.type === 'hello') {
            for (const fn of listeners) fn(msg);
        }
    };

    function call(type, payload = {}) {
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            port.postMessage({ id, type, ...payload });
        });
    }

    return {
        handshake: () => call('handshake'),
        getStatus: () => call('getStatus'),
        setNonce: (nonce) => call('setNonce', { nonce }),
        loadModel: (modelId) => call('loadModel', { modelId }),
        unloadModel: () => call('unloadModel'),
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    };
}

// ---------------------------------------------------------------------------
// State hook
// ---------------------------------------------------------------------------

function useSharedWorker() {
    const clientRef = useRef(null);
    const [state, setState] = useState({ state: 'connecting' });

    useEffect(() => {
        const client = createSharedWorkerClient();
        clientRef.current = client;

        const unsub = client.subscribe((msg) => {
            setState((prev) => ({ ...prev, ...msg }));
        });

        // Kick off handshake and pass the REST nonce.
        client.handshake().then(() => {
            const nonce = window.webllmConnector?.restNonce;
            if (nonce) client.setNonce(nonce);
        }).catch(() => {});

        return () => {
            unsub();
        };
    }, []);

    return { state, client: clientRef.current };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function FloatingIcon({ state, onClick, onStop }) {
    // TODO: render the corner badge based on state
    return (
        <div className="webllm-widget-icon" data-state={state?.state} onClick={onClick}>
            {/* ... */}
        </div>
    );
}

function StartModal({ recommendedModel, progress, error, onStart, onCancel }) {
    // TODO: render the start modal with hardware detection, recommended model, buttons
    return (
        <div className="webllm-widget-modal" role="dialog" aria-modal="true">
            {/* ... */}
        </div>
    );
}

function WidgetRoot() {
    const { state, client } = useSharedWorker();
    const [modalOpen, setModalOpen] = useState(false);
    const [recommendedModel, setRecommendedModel] = useState(null);
    const pendingPromiseRef = useRef(null); // resolve/reject of current promptAndLoad

    // Hardware detection on mount (reuse logic from src/worker.jsx autoPickModel)
    useEffect(() => {
        // TODO: call a function that inspects navigator.gpu.requestAdapter()
        // and picks a model from window.webllmConnector.knownModelIds
        setRecommendedModel(/* ... */);
    }, []);

    // ---------------------------------------------------------------------
    // Public API wiring: expose window.webllmWidget
    // ---------------------------------------------------------------------
    useEffect(() => {
        if (!client) return;

        window.webllmWidget = {
            getStatus: () => client.getStatus(),
            promptAndLoad: () => {
                if (state?.state === 'ready') return Promise.resolve();
                return new Promise((resolve, reject) => {
                    pendingPromiseRef.current = { resolve, reject };
                    setModalOpen(true);
                });
            },
            loadModel: (id) => client.loadModel(id),
            unloadModel: () => client.unloadModel(),
            subscribe: (fn) => client.subscribe(fn),
        };

        return () => {
            delete window.webllmWidget;
        };
    }, [client, state?.state]);

    // Resolve/reject pendingPromiseRef when state transitions
    useEffect(() => {
        if (!pendingPromiseRef.current) return;
        if (state?.state === 'ready') {
            pendingPromiseRef.current.resolve();
            pendingPromiseRef.current = null;
            setModalOpen(false);
        } else if (state?.state === 'error') {
            pendingPromiseRef.current.reject(new Error(state.error || 'Load failed'));
            pendingPromiseRef.current = null;
        }
    }, [state?.state]);

    const handleStart = useCallback(async () => {
        if (!recommendedModel) return;
        try {
            await client.loadModel(recommendedModel);
        } catch (_) { /* state broadcast handles UI */ }
    }, [client, recommendedModel]);

    const handleCancel = useCallback(() => {
        if (pendingPromiseRef.current) {
            pendingPromiseRef.current.reject(new Error('User cancelled'));
            pendingPromiseRef.current = null;
        }
        setModalOpen(false);
    }, []);

    const handleStop = useCallback(() => {
        client?.unloadModel();
    }, [client]);

    return (
        <>
            <FloatingIcon state={state} onClick={() => setModalOpen(true)} onStop={handleStop} />
            {modalOpen && (
                <StartModal
                    recommendedModel={recommendedModel}
                    progress={state?.progress}
                    error={state?.error}
                    onStart={handleStart}
                    onCancel={handleCancel}
                />
            )}
        </>
    );
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

(function mount() {
    const root = document.createElement('div');
    root.id = 'webllm-widget-root';
    document.body.appendChild(root);
    createRoot(root).render(<WidgetRoot />);
})();
```

### Gotchas

1. **`window.webllmConnector`** is the data blob passed by `wp_localize_script` in t008 — this task assumes it exists (has `knownModelIds`, `restNonce`, `sharedWorkerUrl`, etc.). If it's missing (e.g. during standalone testing), the widget should degrade gracefully by using hardcoded defaults.
2. **Do NOT auto-load on mount.** The widget only loads a model when `promptAndLoad()` is called by the middleware OR the user clicks Start in the modal. Auto-loading is a separate opt-in (handled in t009 via a setting).
3. **Handshake timing.** The `handshake()` call MUST return a valid response before the widget trusts the state. Until then, show "connecting…". This prevents a race where the widget thinks the worker is idle but it's actually still booting.
4. **Accessibility.** Modal must be keyboard-dismissible (Esc), focus-trapped, and announce state changes to screen readers via `aria-live="polite"` on the status region.
5. **CSS scoping.** Use a unique prefix like `.webllm-widget-*` and avoid generic selectors. wp-admin has a lot of global CSS and we don't want a collision.
6. **Out of scope:** NOT this task — the bootstrap that actually injects the widget (t008), the apiFetch middleware (t010), any wp_localize_script PHP code.

## Acceptance criteria

1. `src/floating-widget.jsx` and `src/floating-widget.css` exist.
2. `npm run build` produces `build/floating-widget.js` and `build/floating-widget.css` without errors.
3. Standalone test HTML page (not shipped) mounts the widget against a mock SharedWorker stub and all state transitions render correctly: `connecting → idle → loading → ready → busy → ready → idle`.
4. `window.webllmWidget.getStatus()` returns current state as promise.
5. `window.webllmWidget.promptAndLoad()` resolves when state becomes `ready` and rejects when user clicks Cancel.
6. Modal is keyboard-accessible: Tab cycles focusable elements, Esc cancels, Enter activates Start.
7. No regression: existing `build/worker.js` and `build/connector.js` still build cleanly.
8. Diff touches only `src/floating-widget.jsx`, `src/floating-widget.css`, `webpack.config.js`.

## Verification commands

```bash
npm run build
ls -l build/floating-widget.js build/floating-widget.css
# Open src/floating-widget-test.html (create locally, gitignored) in Chrome and exercise every state transition
composer test
```

## Context

- **Parent:** [PLANS.md p001](../PLANS.md)
- **PRD:** [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md)
- **Prerequisite:** [t006-brief.md](t006-brief.md) — the SharedWorker this widget connects to
- **API consumer:** t010 (Phase 6) will call `window.webllmWidget.getStatus()` and `window.webllmWidget.promptAndLoad()` from inside an apiFetch middleware
- **Reference component:** `src/worker.jsx` — existing React surface with similar state shape
