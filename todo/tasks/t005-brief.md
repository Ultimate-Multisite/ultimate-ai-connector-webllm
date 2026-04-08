<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t005: Hook WebLLM into `wpai_preferred_text_models` filter

**Session origin:** `opencode:interactive:2026-04-07` (spike finding F1 in [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#5](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/5)
**Tier:** `tier:simple`
**Status:** `status:available`
**Estimate:** ~30m
**Auto-dispatch:** yes
**Related plan:** [p001 SharedWorker runtime](../PLANS.md) — discovered as a blocker during the D1 spike
**Blocks:** none (independent correctness fix)

## What

Add a single `wpai_preferred_text_models` filter callback in `ultimate-ai-connector-webllm.php` that prepends the currently-configured WebLLM model to the list of preferred text generation models.

## Why

The spike for t004 Phase 1 (see [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) finding F1) traced the AI Experiments excerpt generator's actual runtime path and discovered that:

1. AI Experiments calls `get_preferred_models_for_text_generation()` in `WordPress/ai/includes/helpers.php:142-176`.
2. That function returns a hardcoded list of Anthropic, Google, and OpenAI models.
3. The list is passed through the `wpai_preferred_text_models` filter before use.
4. **Our plugin does not hook into that filter.**

Consequence: even with this plugin installed, activated, and a worker tab actively serving a loaded model, AI Experiments' excerpt generator (and any other consumer of `get_preferred_models_for_text_generation()`) will route to the commercial providers in the list and skip WebLLM entirely. The WebLLM provider is registered with the AI Client SDK, but it's invisible to AI Experiments because it's not in the preference list.

This is a correctness bug in the current architecture. It's independent of the SharedWorker rewrite (t004) but blocks any realistic testing of WebLLM-routed features. Fixing it here means t004's eventual testing will have a real AI path to exercise.

## How

### Files to modify

**EDIT:** `ultimate-ai-connector-webllm.php` — add one `add_filter` call inside the existing namespace block, near the other hook registrations (currently around lines 52-63).

### Reference pattern

Model on the existing hook registrations in `ultimate-ai-connector-webllm.php:52-63` — same style (top-level `add_filter` call in the namespace, short closure body).

Also model on the shape of `$preferred_models` returned by `get_preferred_models_for_text_generation()` in `WordPress/ai/includes/helpers.php:142-176`:

```php
array(
    array( 'anthropic', 'claude-sonnet-4-6' ),
    array( 'google', 'gemini-3-flash-preview' ),
    // ...
);
```

Each element is a `[provider_id, model_id]` tuple. Our provider ID is `'ultimate-ai-connector-webllm'` (see `inc/class-provider.php:68`).

### Exact code to insert

Add this block near the other `add_filter`/`add_action` calls (after the existing hook registrations, before the closing of the file body):

```php
/**
 * Register WebLLM as a preferred text-generation provider so that consumers
 * of `wpai_preferred_text_models` (e.g. the WordPress/ai plugin's AI Experiments
 * features) route requests to the browser-side engine.
 *
 * Only prepended when a default model is configured — an empty model setting
 * leaves the preference list untouched so other providers remain usable.
 *
 * @param array<int, array{0: string, 1: string}> $preferred_models The existing preference list.
 * @return array<int, array{0: string, 1: string}>
 */
add_filter(
    'wpai_preferred_text_models',
    static function ( array $preferred_models ): array {
        $active = (string) get_option( 'webllm_default_model', '' );
        if ( '' === $active ) {
            return $preferred_models;
        }

        array_unshift( $preferred_models, array( 'ultimate-ai-connector-webllm', $active ) );
        return $preferred_models;
    },
    5
);
```

**Priority 5** (not the default 10) ensures we win against any other plugin hooking the same filter at default priority. WordPress's AI Experiments does not hook the filter itself, so priority 5 just means "early" without conflict.

### Gotchas

1. **Empty model option.** When `webllm_default_model` is empty, we leave the list alone. Otherwise the worker has no model to load and we'd be pointing consumers at a dead endpoint.
2. **Namespace.** The file uses `namespace UltimateAiConnectorWebLlm;`. The `add_filter` call MUST be inside that namespace block to match the existing hook registration style. Don't add a `\add_filter(...)` with a leading backslash — match the existing code.
3. **No `use function` needed.** `add_filter` and `get_option` are WordPress globals; PHP falls back to the root namespace automatically when they're not found in the current namespace.
4. **Do NOT** modify `inc/class-provider.php`, `inc/class-model.php`, or any of the REST API files. This task only touches `ultimate-ai-connector-webllm.php`.

## Acceptance criteria

1. **The filter callback is registered** — `grep -n "wpai_preferred_text_models" ultimate-ai-connector-webllm.php` returns exactly one match (the new `add_filter` line).
2. **PHP lint passes** — `php -l ultimate-ai-connector-webllm.php` reports no errors.
3. **PHPUnit tests still pass** — `composer test` exits 0 (no regressions; no new test is required for this task because the fix is a one-line filter registration).
4. **Runtime behaviour** (verified by inspecting the filter application, not necessarily by live-running the plugin): when `webllm_default_model` is set to a valid model ID and `apply_filters( 'wpai_preferred_text_models', [] )` is called, the returned array's first element is `['ultimate-ai-connector-webllm', '<model id>']`. Optionally add a quick unit test at `tests/test-preferred-models-filter.php` but this is not required — the change is trivial enough to review by reading.
5. **No unrelated changes** — the diff touches only `ultimate-ai-connector-webllm.php` and (optionally) a new test file. No other files modified.

## Verification commands

```bash
php -l ultimate-ai-connector-webllm.php
composer test
git diff --stat  # should show only ultimate-ai-connector-webllm.php and optionally tests/
grep -n "wpai_preferred_text_models" ultimate-ai-connector-webllm.php
```

## Context

- **Spike source:** [spike-shared-worker-apifetch.md](spike-shared-worker-apifetch.md) section "Incidental findings" → F1
- **Plan:** [PLANS.md p001](../PLANS.md) — this task was discovered during Phase 1 of that plan but is independent work
- **Filter definition upstream:** `WordPress/ai/includes/helpers.php:142-176` (function `get_preferred_models_for_text_generation`)
- **Our provider ID:** `ultimate-ai-connector-webllm` — defined at `inc/class-provider.php:68`
- **Default model option key:** `webllm_default_model` — registered in `inc/settings.php` (exists since the plugin's first release; no migration needed)
