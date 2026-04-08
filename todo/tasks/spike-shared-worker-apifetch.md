<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# Spike: AI Client SDK editor integration hooks

**Plan:** [todo/PLANS.md p001](../PLANS.md)
**PRD:** [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) (D1)
**Phase:** 1 of 8
**Date:** 2026-04-07
**Session:** interactive
**Status:** Complete

## Purpose

Determine whether the "better path" of apiFetch interception (Phase 6) is achievable in 2h or balloons to 8h. Lock design decision D1 before Phase 6 can be sized.

## Question

When a plugin like AI Experiments invokes an AI feature (e.g. excerpt generator) from the block editor, can we intercept the request on the JS side *before* it fails with 503 if the WebLLM SharedWorker has no model loaded, show the start modal, wait for the user to load the model, then transparently let the request proceed?

## Method

Traced the actual request path from user click to network by reading:

- `WordPress/ai` (the AI Experiments plugin) — `src/experiments/excerpt-generation/`, `src/utils/run-ability.ts`, `includes/Abilities/Excerpt_Generation/Excerpt_Generation.php`, `includes/helpers.php`
- `WordPress/wp-ai-client` — `src/builders/prompt-builder.ts`, `src/index.ts`, `src/providers/api.ts`, `includes/REST_API/AI_Prompt_REST_Controller.php`
- `WordPress/abilities-api` — `packages/client/src/api.ts`, `includes/rest-api/endpoints/class-wp-rest-abilities-v1-run-controller.php`
- `@wordpress/api-fetch` README for middleware contract
- This plugin's `inc/class-provider.php` and `ultimate-ai-connector-webllm.php`

## Findings

### 1. There are two distinct entry points for AI requests, not one

The investigation PRD assumed a single path (`/wp-ai/v1/generate`). There are actually two, used by different client-side layers:

| Path | Called by | Who uses it |
|---|---|---|
| `POST /wp-ai/v1/generate` | `wp.aiClient.prompt(...).generateText()` (PromptBuilder) | Plugins calling the AI Client SDK directly |
| `POST /wp-abilities/v1/abilities/{name}/run` | `wp.abilities.executeAbility(name, input)` → falls back to `apiFetch` when the client script isn't enqueued | Plugins using the higher-level Abilities API — including AI Experiments |

**AI Experiments uses the Abilities API path, NOT the `/wp-ai/v1/generate` path.** See `WordPress/ai/src/utils/run-ability.ts:95-113` — it calls `wp.abilities.executeAbility('ai/excerpt-generation', input)` with an apiFetch fallback to `/wp-abilities/v1/abilities/ai/excerpt-generation/run`.

The server-side handler for the abilities route eventually calls `wp_ai_client_prompt(...)->generate_text()`, which hits the same server-side AI Client as the direct path — but **from the browser's perspective, the two network requests look completely different**.

This is the single most important finding in the spike. The middleware has to handle both.

### 2. Neither entry point tells us the provider directly

**`/wp-ai/v1/generate`** includes these fields in the POST body (see `wp-ai-client/src/builders/prompt-builder.ts:584-596`):

```ts
{
  messages: [...],
  modelConfig: {...},
  providerId: "ultimate-ai-connector-webllm",  // MAY be empty
  modelId: "Llama-3.2-3B-Instruct-q4f32_1-MLC",  // MAY be empty
  modelPreferences: [["provider", "model"], ...],  // MAY be empty
  capability: "text_generation",
  requestOptions: {...}
}
```

So *sometimes* we can see `providerId === 'ultimate-ai-connector-webllm'` in the body and know this is definitely ours. But the caller can (and AI Experiments does) omit providerId entirely and rely on server-side preference resolution — in which case we can't tell from the body alone.

**`/wp-abilities/v1/abilities/{name}/run`** has a body shape like `{input: {...}}`. The ability name is in the URL. The body says *nothing* about providers. Routing decisions happen entirely server-side when the PHP ability callback calls `wp_ai_client_prompt(...)`.

### 3. The AI Experiments plugin's preferred-models list does NOT include WebLLM

`WordPress/ai/includes/helpers.php:142-176` hardcodes the default preferred text models:

```php
$preferred_models = array(
    array( 'anthropic', 'claude-sonnet-4-6' ),
    array( 'google', 'gemini-3-flash-preview' ),
    array( 'google', 'gemini-2.5-flash' ),
    array( 'openai', 'gpt-5.4-mini' ),
    array( 'openai', 'gpt-4.1-mini' ),
);
return (array) apply_filters( 'wpai_preferred_text_models', $preferred_models );
```

**Our plugin currently does not hook into `wpai_preferred_text_models`.** That means: even with the current plugin installed and the worker running, AI Experiments will NEVER route its excerpt-generation requests to WebLLM — it'll skip our provider entirely and try Anthropic/Google/OpenAI first, failing (or succeeding with a commercial provider) before WebLLM gets a chance.

This is a pre-existing gap in our plugin, separate from the SharedWorker work. Captured as follow-up task (see "Incidental findings" below).

**For the purpose of the spike:** once the pre-existing gap is fixed, our plugin will be first in the `wpai_preferred_text_models` list, and effectively all text-generation ability calls will route to WebLLM. That means the middleware can assume "if the ability is a text-gen ability, it's going to us".

### 4. `@wordpress/api-fetch` middleware API is exactly what we need

From the `@wordpress/api-fetch` README:

```js
apiFetch.use( ( options, next ) => {
  // options.path, options.method, options.data available
  // can delay, modify, or fail the request
  return next( options );  // pass through
} );
```

Middleware can:

- Inspect the full request (path, method, data)
- Return any Promise (including one that waits on user interaction)
- Delay `next(options)` arbitrarily
- Reject to fail the request with a custom error
- Replace the request entirely

This is exactly the interception point we need. There is no need for monkey-patching, no need for upstream cooperation, no need to fork the AI Client SDK or Abilities API client.

### 5. There is no JS event bus in wp-ai-client or abilities-api

Neither SDK emits events for request lifecycle. There's a `@wordpress/data` Redux store in each, but the stores track cached data (provider list, ability list) — they don't model in-flight requests. This rules out a cleaner "subscribe to generation start" pattern; middleware is the only hook.

### 6. The WebLLM provider ID is stable and plugin-owned

`inc/class-provider.php:68` — `'ultimate-ai-connector-webllm'`. This string is controlled by us and stable across versions. Safe to hardcode in the middleware as the provider marker.

## D1 recommendation: Hybrid-narrow

Lock in this strategy for Phase 6:

### Interception rules (in order)

Register ONE `apiFetch` middleware. For each outgoing request, evaluate:

1. **Direct AI Client request** — path matches `/wp-ai/v1/generate`:
   - If `body.providerId === 'ultimate-ai-connector-webllm'` → **definitely ours, intercept**
   - Else if `body.modelId` is in our known model ID set → **ours, intercept**
   - Else if `body.modelPreferences` contains a `['ultimate-ai-connector-webllm', *]` tuple → **ours, intercept**
   - Else → pass through (routes to OpenAI/Anthropic/whatever)

2. **Abilities API request** — path matches `/wp-abilities/v1/abilities/(.+)/run`:
   - Extract ability name from path
   - If ability name starts with `ai/` **AND** our plugin is configured as a preferred provider for text generation (a boolean flag we pass at page load) → **probably ours, intercept**
   - Else → pass through

3. **Everything else** → pass through unmodified (saves, post updates, media, etc. — most apiFetch traffic)

### Interception behaviour

When a request is classified as "ours":

- If the SharedWorker has a model loaded → **pass through immediately**. The request hits the broker, the broker enqueues the job, the SharedWorker's polling loop picks it up, and life is good. Zero latency penalty.
- If the SharedWorker is idle → **hold the request, tell the floating widget to show the start modal**. When the user clicks Start and the model finishes loading, release `next(options)`. If the user clicks Cancel, reject with a WP_Error-shaped error (`{code: 'webllm_cancelled', message: '...'}`) so the editor surfaces a clean message instead of an opaque 503.
- If the SharedWorker errors out during load → reject with a WP_Error-shaped error explaining the failure.

### Why this is narrow enough to be safe

The middleware only intercepts when strong evidence says "this request is going to WebLLM". The worst-case false positive is an ability with an `ai/` prefix that would actually route elsewhere on the server — and even then, the user gets a prompt to load a model they don't strictly need. They click Cancel and the request proceeds.

The worst-case false negative (a request routes to WebLLM server-side but we didn't intercept) is the existing 503 failure path — exactly what happens today. No regression.

### Data the widget needs at page load

Our plugin's `inc/widget-injector.php` (Phase 4) should pass this JSON blob via `wp_localize_script` to the bootstrap:

```php
wp_localize_script( 'webllm-widget-bootstrap', 'webllmConnector', array(
    'providerId'                  => 'ultimate-ai-connector-webllm',
    'knownModelIds'               => array( /* list from WebLlmModelDirectory */ ),
    'isPreferredForTextGeneration' => (bool) in_array(
        'ultimate-ai-connector-webllm',
        wp_list_pluck( get_preferred_models_for_text_generation(), 0 ),
        true
    ),
    'webllmAbilityPrefixes'       => array( 'ai/' ),
    'restNonce'                   => wp_create_nonce( 'wp_rest' ),
    'brokerStatusUrl'             => rest_url( 'webllm/v1/status' ),
) );
```

The middleware reads `window.webllmConnector.*` and makes all decisions client-side with no extra network round-trips.

### Middleware code sketch (concrete, ready to ship)

```js
// src/apifetch-middleware.js — loaded by widget-bootstrap.js when runtime is SharedWorker mode
import apiFetch from '@wordpress/api-fetch';

const config = window.webllmConnector || {};
const knownModelIds = new Set( config.knownModelIds || [] );
const abilityPrefixes = config.webllmAbilityPrefixes || [ 'ai/' ];

function isWebLlmGenerateRequest( path, data ) {
    if ( ! path.startsWith( '/wp-ai/v1/generate' ) ) return false;
    if ( ! data ) return false;
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
    const match = path.match( /^\/wp-abilities\/v1\/abilities\/(.+?)\/run(\?|$)/ );
    if ( ! match ) return false;
    if ( ! config.isPreferredForTextGeneration ) return false;
    const abilityName = decodeURIComponent( match[ 1 ] );
    return abilityPrefixes.some( ( prefix ) => abilityName.startsWith( prefix ) );
}

apiFetch.use( async ( options, next ) => {
    const path = options.path || '';
    const data = options.data || {};
    const isOurs =
        isWebLlmGenerateRequest( path, data ) || isWebLlmAbilityRequest( path );

    if ( ! isOurs ) {
        return next( options );
    }

    // Ours — check SharedWorker state before letting the request through.
    const status = await window.webllmWidget.getStatus();
    if ( status === 'ready' ) {
        return next( options );
    }

    // Not ready — show the modal and await user decision.
    try {
        await window.webllmWidget.promptAndLoad();
        // Model loaded, release the request.
        return next( options );
    } catch ( err ) {
        // User cancelled or load failed — translate to a WP_Error-shaped rejection.
        throw {
            code: 'webllm_not_ready',
            message: err.message || 'WebLLM model is not loaded.',
            data: { status: 503 },
        };
    }
} );
```

`window.webllmWidget.getStatus()` and `window.webllmWidget.promptAndLoad()` are methods exposed by the Phase 3 widget. The widget internally talks to the SharedWorker via `MessagePort`. Keeping the middleware thin (just a classifier + status check + status update listener) is important because middleware runs on *every* apiFetch call in the editor — it must not block or allocate heavily on non-AI requests.

## Phase 6 sizing

With the Hybrid-narrow strategy locked in:

| Task | Est |
|---|---|
| Write `src/apifetch-middleware.js` | 1.5h |
| Extend `inc/widget-injector.php` with the `wp_localize_script` data blob | 0.5h |
| Add `webllmWidget.getStatus()` and `webllmWidget.promptAndLoad()` to Phase 3 widget surface | 1h |
| Wire middleware into widget-bootstrap.js loader | 0.5h |
| Manual integration test with AI Experiments excerpt generator | 1h |
| Edge cases: abort, cancel, load failure, nonce refresh | 0.5h |
| **Total** | **5h** |

Same as the original PRD estimate — no change. Good: the original sizing was accurate because the middleware pattern is straightforward, the complexity was all in figuring out WHICH requests to intercept.

## Incidental findings (follow-up tasks)

### F1. Plugin does not register itself as a preferred text-gen provider

Our plugin does not hook into the `wpai_preferred_text_models` filter. Without this, AI Experiments and any other plugin using `get_preferred_models_for_text_generation()` will route to Anthropic/Google/OpenAI and skip WebLLM entirely — even with the worker running. This is a pre-existing bug separate from the SharedWorker work.

**Recommended fix:** Add to `ultimate-ai-connector-webllm.php`:

```php
add_filter( 'wpai_preferred_text_models', function ( array $preferred_models ): array {
    $active = (string) get_option( 'webllm_default_model', '' );
    if ( '' === $active ) {
        return $preferred_models;
    }
    array_unshift( $preferred_models, array( 'ultimate-ai-connector-webllm', $active ) );
    return $preferred_models;
}, 5 );
```

Priority 5 ensures we win against any other plugin hooking at default priority 10.

**Scope:** ~30 minutes. Should be a separate small task (`t005` or so). It's a correctness bug for the current architecture and shouldn't wait for the SharedWorker rewrite.

### F2. The Abilities API client has a server-side ability cache we could query

`wp.abilities.getAbility(name)` returns the ability metadata including input/output schemas. In theory we could query this at widget init to build a more precise allowlist than "starts with `ai/`". Not required for the Hybrid-narrow strategy, but worth remembering if F1 ever changes upstream.

### F3. PromptBuilder `modelPreferences` uses a tuple shape `[[provider, model], ...]`

Our middleware code handles this correctly, but it's worth flagging in the code comment because it's easy to mis-model as `{provider, model}` objects on first read.

## D1 decision: LOCKED

**Hybrid-narrow.** Implementation estimated at 5h, unchanged from PRD. Phase 6 can proceed as planned.

## Links

- `WordPress/ai` — `src/utils/run-ability.ts`, `src/experiments/excerpt-generation/components/useExcerptGeneration.ts`, `includes/Abilities/Excerpt_Generation/Excerpt_Generation.php`, `includes/helpers.php`
- `WordPress/wp-ai-client` — `src/builders/prompt-builder.ts:581-599`, `src/index.ts:37-51`, `includes/AI_Client.php`, `includes/REST_API/AI_Prompt_REST_Controller.php`
- `WordPress/abilities-api` — `packages/client/src/api.ts:317-339`, `includes/rest-api/endpoints/class-wp-rest-abilities-v1-run-controller.php`
- `@wordpress/api-fetch` middleware docs — `https://github.com/WordPress/gutenberg/blob/trunk/packages/api-fetch/README.md#middlewares`
- This plugin — `inc/class-provider.php:67-74`, `ultimate-ai-connector-webllm.php`
