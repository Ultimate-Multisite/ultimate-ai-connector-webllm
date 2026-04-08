<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t010: Phase 6 — apiFetch middleware integration

**Session origin:** `opencode:interactive:2026-04-07` (Phase 6 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#10](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/10)
**Tier:** `tier:standard`
**Status:** `status:blocked` (waiting on t007)
**Estimate:** ~5h
**Auto-dispatch:** yes (once unblocked)
**Parent plan:** [p001](../PLANS.md) — Phase 6 of 8
**Blocks:** t011, t012
**Blocked-by:** t007 (needs `window.webllmWidget.getStatus` and `promptAndLoad`)

## What

Implement the **Hybrid-narrow** apiFetch middleware strategy locked during the Phase 1 spike. The middleware intercepts requests that are likely to route to WebLLM, holds them if the SharedWorker is idle, shows the start modal, and releases them once the model is loaded. If the user cancels, it rejects cleanly.

This is the piece that makes "user clicks AI tool → modal pops up → click Start → AI works" happen.

## Why

Without this middleware, the existing UX stays broken: a user on a fresh session clicks "Generate excerpt", the request hits the PHP broker, the broker has no worker connected, it returns 503, the editor shows an opaque error. With the middleware, the request is caught client-side **before** it hits the network, the user gets a friendly modal, and the excerpt is generated after a single click.

The full design rationale is in [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) — read that first.

## How

### Files to modify

**NEW:** `src/apifetch-middleware.js` (~100 LOC) — the middleware itself
**EDIT:** `src/floating-widget.jsx` (from t007) — add a small bootstrap snippet at the end that registers the middleware (OR load it as a separate bundle from the bootstrap in t008 — implementer's choice)
**EDIT:** `webpack.config.js` — add `'apifetch-middleware'` entry if shipping as a separate bundle

**RECOMMENDED:** ship as a separate bundle loaded by `src/widget-bootstrap.js` (t008) alongside the floating widget. This keeps the middleware loadable independently for testing and keeps the floating widget focused on UI.

### Reference pattern

- `@wordpress/api-fetch` README middleware example: `https://github.com/WordPress/gutenberg/blob/trunk/packages/api-fetch/README.md#middlewares`
- The classifier logic is already written out in full in [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) under "Middleware code sketch (concrete, ready to ship)"

### Exact code to ship

Copy from the spike doc's code sketch, adapted to project conventions:

```javascript
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
//
// src/apifetch-middleware.js — holds AI requests until the SharedWorker is ready.

import apiFetch from '@wordpress/api-fetch';

const config = window.webllmConnector || {};
const knownModelIds = new Set( config.knownModelIds || [] );
const abilityPrefixes = config.webllmAbilityPrefixes || [ 'ai/' ];

function isWebLlmGenerateRequest( path, data ) {
    if ( typeof path !== 'string' ) return false;
    if ( ! path.startsWith( '/wp-ai/v1/generate' ) ) return false;
    if ( ! data || typeof data !== 'object' ) return false;
    if ( data.providerId === config.providerId ) return true;
    if ( data.modelId && knownModelIds.has( data.modelId ) ) return true;
    if ( Array.isArray( data.modelPreferences ) ) {
        for ( const pref of data.modelPreferences ) {
            if ( Array.isArray( pref ) && pref[ 0 ] === config.providerId ) {
                return true;
            }
        }
    }
    return false;
}

function isWebLlmAbilityRequest( path ) {
    if ( typeof path !== 'string' ) return false;
    const match = path.match( /^\/wp-abilities\/v1\/abilities\/(.+?)\/run(\?|$)/ );
    if ( ! match ) return false;
    if ( ! config.isPreferredForTextGeneration ) return false;
    const abilityName = decodeURIComponent( match[ 1 ] );
    return abilityPrefixes.some( ( prefix ) => abilityName.startsWith( prefix ) );
}

apiFetch.use( async ( options, next ) => {
    const path = options.path || '';
    const data = options.data || null;
    const isOurs = isWebLlmGenerateRequest( path, data ) || isWebLlmAbilityRequest( path );

    if ( ! isOurs ) {
        return next( options );
    }

    // Wait for widget to be ready (t007 exposes it on window.webllmWidget)
    const widget = window.webllmWidget;
    if ( ! widget ) {
        // Widget not mounted yet — let the request through; server-side will 503 if needed
        return next( options );
    }

    const status = await widget.getStatus();
    if ( status?.state === 'ready' ) {
        return next( options );
    }

    try {
        await widget.promptAndLoad();
        return next( options );
    } catch ( err ) {
        const errorMessage = ( err && err.message ) || 'WebLLM model is not loaded.';
        const rejection = {
            code: 'webllm_not_ready',
            message: errorMessage,
            data: { status: 503 },
        };
        return Promise.reject( rejection );
    }
} );
```

### Gotchas

1. **Middleware runs on EVERY apiFetch call.** It must return `next(options)` untouched as fast as possible for non-AI requests. The classifier must be synchronous and cheap. No allocations, no deep cloning, no regex recompilation in the hot path. Benchmark: a single middleware invocation on a non-matching request should be <100µs.
2. **`window.webllmWidget` may not exist yet** on very early admin page loads (bootstrap runs in the footer, some apiFetch calls happen during initial React mount). The middleware falls through (`return next(options)`) rather than erroring in that case — the server-side 503 path remains as a safety net.
3. **Rejection shape.** `@wordpress/api-fetch` errors are expected in `{code, message, data}` shape (WP_Error-like). The rejection above matches that contract so the editor renders a clean notice instead of `[object Object]`.
4. **Don't intercept the `/wp-json/webllm/v1/*` routes** our own broker uses. The middleware should NEVER intercept our own endpoints — otherwise it creates an infinite loop (widget calls broker → broker call intercepted → widget asked to load → widget calls broker → ...). The classifier only matches `/wp-ai/v1/generate` and `/wp-abilities/v1/abilities/*/run`, so this is already safe by construction. Add a unit test or inline comment making this explicit.
5. **The `isWebLlmAbilityRequest` classifier has a small false-positive window** — any `ai/*` ability that routes to a non-WebLLM provider would also show the start modal. That's acceptable: the user clicks Cancel and the request proceeds normally. Documented in the spike under "Why this is narrow enough to be safe".
6. **Don't import the whole MLCEngine.** This middleware is tiny and must ship as a small bundle. It only imports `@wordpress/api-fetch`.

## Acceptance criteria

1. `src/apifetch-middleware.js` exists and matches the spike sketch.
2. `npm run build` produces `build/apifetch-middleware.js` (or bundles it into the widget bundle — implementer's choice).
3. The middleware is loaded on admin pages (via widget-bootstrap or widget itself — verify via DevTools).
4. **Integration test (documented in PR body):**
   - Install WordPress/ai plugin + this plugin + ensure t005 (preferred-models filter) is merged first
   - Fresh session, no model loaded
   - Open a post, click "Generate excerpt"
   - **Expected:** the excerpt generator's request is held by the middleware, the start modal appears, user clicks Start, model loads, excerpt is generated
   - **Regression test:** with a loaded model, the same click produces an excerpt with no modal intervention
   - **Cancel test:** with no model, user clicks Cancel → editor shows a clean error, not 503
5. Non-AI apiFetch requests are not affected (verify by saving a post — no modal, no delay, no error).
6. Diff touches only `src/apifetch-middleware.js`, `webpack.config.js`, and possibly `src/widget-bootstrap.js` (if the middleware is loaded from there).

## Verification commands

```bash
npm run build
composer test
# Manual integration test per acceptance criterion 4
```

## Context

- **Spike:** [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) — contains the full strategy, code sketch, and the "why" for every classifier decision. Read this first.
- **Dependency:** [t007](t007-brief.md) (`window.webllmWidget.getStatus` / `promptAndLoad` are consumed here)
- **Related fix:** [t005](t005-brief.md) (without t005, the excerpt generator won't actually route to WebLLM, so you can't meaningfully test this task). t005 should be merged before t010's integration test.
- **D1 decision:** Hybrid-narrow (locked in spike)
