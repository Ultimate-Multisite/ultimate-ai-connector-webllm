<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t008: Phase 4 — Bootstrap, injector, capability detection

**Session origin:** `opencode:interactive:2026-04-07` (Phase 4 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#8](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/8)
**Tier:** `tier:standard`
**Status:** `status:blocked` (waiting on t007)
**Estimate:** ~3h
**Auto-dispatch:** yes (once unblocked)
**Parent plan:** [p001](../PLANS.md) — Phase 4 of 8
**Blocks:** t009, t010, t011, t012
**Blocked-by:** t007 (needs the floating widget bundle to load)

## What

Glue the floating widget into WordPress. Detect SharedWorker + WebGPU capability, lazy-load the widget only when supported, and ship a small bootstrap script + PHP injector that runs on every `admin_footer` (and optionally `wp_footer`).

## How

### Files to modify

**NEW:** `src/widget-bootstrap.js` (~80 LOC) — capability detect, lazy-load
**NEW:** `inc/widget-injector.php` (~80 LOC) — WordPress hook integration, `wp_localize_script` for the `webllmConnector` data blob
**EDIT:** `ultimate-ai-connector-webllm.php` — `require_once __DIR__ . '/inc/widget-injector.php';` and register the admin_footer hook
**EDIT:** `webpack.config.js` — add `'widget-bootstrap'` entry

### Reference pattern

- `inc/admin.php` — existing admin enqueue pattern (see `enqueue_worker_assets`)
- `inc/settings.php:register_settings` — existing option registration style (t009 will add new options; this task just reads them)

### Bootstrap logic

```javascript
// src/widget-bootstrap.js
(function () {
    // Read server-provided config
    const config = window.webllmConnector || {};
    if (!config.widgetEnabled) return;

    // Capability detect
    if (typeof SharedWorker === 'undefined') {
        console.debug('[WebLLM] SharedWorker not supported, falling back');
        return;
    }
    if (!('gpu' in navigator)) {
        console.debug('[WebLLM] WebGPU not supported, falling back');
        return;
    }

    // Lazy-load the widget bundle
    const script = document.createElement('script');
    script.src = config.widgetBundleUrl;
    script.type = 'module';
    script.async = true;
    script.onerror = () => console.warn('[WebLLM] Failed to load widget bundle');
    document.head.appendChild(script);
})();
```

### PHP injector

```php
// inc/widget-injector.php
namespace UltimateAiConnectorWebLlm;

function inject_widget_bootstrap(): void {
    if ( ! is_user_logged_in() ) {
        return;
    }
    if ( ! current_user_can( 'edit_posts' ) ) {
        return;
    }
    $mode = get_option( 'webllm_runtime_mode', 'auto' );
    if ( 'disabled' === $mode || 'dedicated-tab' === $mode ) {
        return;
    }
    if ( ! (bool) get_option( 'webllm_widget_enabled', true ) ) {
        return;
    }

    $handle = 'webllm-widget-bootstrap';
    wp_register_script(
        $handle,
        plugins_url( 'build/widget-bootstrap.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
        array(),
        ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION,
        true
    );
    wp_localize_script( $handle, 'webllmConnector', get_localized_config() );
    wp_enqueue_script( $handle );
}

function get_localized_config(): array {
    $directory = new WebLlmModelDirectory();
    $known_models = array();
    try {
        foreach ( $directory->getAll() as $meta ) {
            $known_models[] = $meta->id();
        }
    } catch ( \Throwable $e ) {
        // SDK not loaded yet; model list will be populated client-side via /wp-json/webllm/v1/models
    }

    return array(
        'providerId'                    => 'ultimate-ai-connector-webllm',
        'widgetEnabled'                 => true,
        'widgetBundleUrl'               => plugins_url( 'build/floating-widget.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
        'sharedWorkerUrl'               => plugins_url( 'build/shared-worker.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
        'knownModelIds'                 => $known_models,
        'isPreferredForTextGeneration'  => function_exists( '\\WordPress\\AI\\get_preferred_models_for_text_generation' )
            ? in_array(
                'ultimate-ai-connector-webllm',
                wp_list_pluck( (array) \WordPress\AI\get_preferred_models_for_text_generation(), 0 ),
                true
              )
            : false,
        'webllmAbilityPrefixes'         => array( 'ai/' ),
        'restNonce'                     => wp_create_nonce( 'wp_rest' ),
        'restUrl'                       => esc_url_raw( rest_url( 'webllm/v1/' ) ),
    );
}

add_action( 'admin_footer', __NAMESPACE__ . '\\inject_widget_bootstrap' );
if ( (bool) get_option( 'webllm_widget_on_frontend', false ) ) {
    add_action( 'wp_footer', __NAMESPACE__ . '\\inject_widget_bootstrap' );
}
```

### Gotchas

1. **`widgetBundleUrl` is loaded dynamically** — do NOT register it with `wp_register_script`. It's a module script loaded by the bootstrap at runtime after capability detection passes. This keeps the initial page weight minimal on unsupported browsers.
2. **Nonce freshness.** WordPress REST nonces expire. For long-lived sessions we'll need to refresh them. Out of scope for this task — the bootstrap just sends the current nonce; nonce refresh is a follow-up if it becomes an issue in testing (t011).
3. **`is_user_logged_in` + `edit_posts`** — defensive gates so the widget never renders for anonymous front-end visitors even if `webllm_widget_on_frontend` is enabled.
4. **Run on `admin_footer`, not `admin_init`** — the widget injects DOM, so it needs the document body to exist.
5. **Out of scope:** the settings registration themselves. t009 registers `webllm_runtime_mode`, `webllm_widget_enabled`, `webllm_widget_on_frontend`, `webllm_widget_autostart`. This task reads them with sensible defaults (`'auto'`, `true`, `false`, `false` respectively) via `get_option(key, default)` — so the widget works even before t009 ships.

## Acceptance criteria

1. Loading any admin page injects the bootstrap script in the footer (verified via View Source).
2. On Chrome 124+ with WebGPU, the bootstrap loads the widget bundle; on Safari or Chrome <124, it does not (verify via Network tab).
3. The `webllmConnector` global is present on the page before the bootstrap runs, with all the keys above populated.
4. The widget actually mounts and shows the idle floating icon.
5. Closing the last admin tab kills the SharedWorker (verify in Chrome's chrome://inspect/#workers).
6. Diff touches only the four files listed above. No modifications to `inc/class-*.php` or `inc/rest-api.php`.

## Verification commands

```bash
npm run build
composer test
php -l inc/widget-injector.php
# Visit /wp-admin/ in Chrome 124+; DevTools → Network → confirm widget-bootstrap.js loads and triggers floating-widget.js
# Visit /wp-admin/ in Safari; confirm widget-bootstrap.js loads and returns silently without loading floating-widget.js
```

## Context

- Depends on: [t006](t006-brief.md) (SharedWorker), [t007](t007-brief.md) (widget component)
- Consumed by: [t010](t010-brief.md) (apiFetch middleware reads `window.webllmConnector`)
- PRD reference: [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) → "New files" table
