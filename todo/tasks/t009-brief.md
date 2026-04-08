<!-- SPDX-License-Identifier: MIT -->
<!-- SPDX-FileCopyrightText: 2025-2026 Marcus Quinn -->

# t009: Phase 5 — Settings + connector card UI update

**Session origin:** `opencode:interactive:2026-04-07` (Phase 5 of [p001](../PLANS.md))
**Issue:** [Ultimate-Multisite/ultimate-ai-connector-webllm#9](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm/issues/9)
**Tier:** `tier:standard`
**Status:** `status:blocked` (waiting on t008)
**Estimate:** ~3h
**Auto-dispatch:** yes (once unblocked)
**Parent plan:** [p001](../PLANS.md) — Phase 5 of 8
**Blocks:** t011, t012
**Blocked-by:** t008

## What

Register four new settings for the SharedWorker runtime mode and update the connector card UI (`src/connector.jsx`) to expose them. Also demote the "Open worker tab" button so it only appears when in dedicated-tab fallback mode.

## How

### Files to modify

**EDIT:** `inc/settings.php` — register four new options in `register_settings()`
**EDIT:** `src/connector.jsx` — add UI controls for the new settings, show "Active runtime" indicator, conditionally render the "Open worker tab" button
**EDIT:** `inc/rest-api.php` — extend the existing `/status` endpoint to include the new runtime fields (or add `/runtime-mode` if cleaner)

### New settings to register

| Option key | Type | Default | Description |
|---|---|---|---|
| `webllm_runtime_mode` | string | `'auto'` | One of `'auto'`, `'shared-worker'`, `'dedicated-tab'`, `'disabled'` |
| `webllm_widget_enabled` | bool | `true` | Master toggle for the floating widget |
| `webllm_widget_on_frontend` | bool | `false` | Also render the widget in `wp_footer` (for logged-in users with `edit_posts`) |
| `webllm_widget_autostart` | bool | `false` | Auto-load the default model on every admin page load (power-user opt-in) |

### Reference pattern

- Existing settings in `inc/settings.php` — all four new settings follow the same `register_setting(...)` + `add_settings_field(...)` pattern as `webllm_default_model`, `webllm_request_timeout`, etc.
- Connector card UI in `src/connector.jsx` — existing settings panels use `@wordpress/components` `SelectControl`, `ToggleControl`, `TextControl`, etc. Match the existing style.

### Settings code skeleton

Inside `register_settings()` in `inc/settings.php`, add:

```php
register_setting(
    'webllm_options',
    'webllm_runtime_mode',
    array(
        'type'              => 'string',
        'default'           => 'auto',
        'sanitize_callback' => static function ( $value ): string {
            $allowed = array( 'auto', 'shared-worker', 'dedicated-tab', 'disabled' );
            return in_array( $value, $allowed, true ) ? $value : 'auto';
        },
        'show_in_rest'      => true,
    )
);

register_setting(
    'webllm_options',
    'webllm_widget_enabled',
    array(
        'type'              => 'boolean',
        'default'           => true,
        'sanitize_callback' => static fn ( $v ) => (bool) $v,
        'show_in_rest'      => true,
    )
);

register_setting(
    'webllm_options',
    'webllm_widget_on_frontend',
    array(
        'type'              => 'boolean',
        'default'           => false,
        'sanitize_callback' => static fn ( $v ) => (bool) $v,
        'show_in_rest'      => true,
    )
);

register_setting(
    'webllm_options',
    'webllm_widget_autostart',
    array(
        'type'              => 'boolean',
        'default'           => false,
        'sanitize_callback' => static fn ( $v ) => (bool) $v,
        'show_in_rest'      => true,
    )
);
```

### Connector card additions

In `src/connector.jsx` add a new panel (above or below existing panels):

```jsx
<PanelBody title={__('Runtime mode', 'ultimate-ai-connector-webllm')} initialOpen={true}>
    <SelectControl
        label={__('Runtime', 'ultimate-ai-connector-webllm')}
        value={runtimeMode}
        options={[
            { label: __('Auto (SharedWorker if available)', 'ultimate-ai-connector-webllm'), value: 'auto' },
            { label: __('SharedWorker only', 'ultimate-ai-connector-webllm'), value: 'shared-worker' },
            { label: __('Dedicated tab only', 'ultimate-ai-connector-webllm'), value: 'dedicated-tab' },
            { label: __('Disabled', 'ultimate-ai-connector-webllm'), value: 'disabled' },
        ]}
        onChange={setRuntimeMode}
        help={__('Auto detects SharedWorker + WebGPU support and falls back to a dedicated tab on older browsers.', 'ultimate-ai-connector-webllm')}
    />
    <ToggleControl
        label={__('Enable floating widget', 'ultimate-ai-connector-webllm')}
        checked={widgetEnabled}
        onChange={setWidgetEnabled}
        help={__('Shows a small status icon in the corner of every admin page.', 'ultimate-ai-connector-webllm')}
    />
    <ToggleControl
        label={__('Also show widget on front-end pages', 'ultimate-ai-connector-webllm')}
        checked={widgetOnFrontend}
        onChange={setWidgetOnFrontend}
        disabled={!widgetEnabled}
        help={__('Only renders for logged-in users with permission to edit posts.', 'ultimate-ai-connector-webllm')}
    />
    <ToggleControl
        label={__('Auto-start model on page load', 'ultimate-ai-connector-webllm')}
        checked={widgetAutostart}
        onChange={setWidgetAutostart}
        disabled={!widgetEnabled}
        help={__('Uses GPU memory continuously. Leave off to load on demand when an AI feature is triggered.', 'ultimate-ai-connector-webllm')}
    />
    <p><strong>{__('Active runtime:', 'ultimate-ai-connector-webllm')}</strong> {activeRuntime}</p>
</PanelBody>
```

Read/write each option via the existing REST settings endpoint (same pattern as `webllm_default_model`).

### Demote "Open worker tab"

In the existing connector card body, wrap the "Open worker tab" button in a conditional:

```jsx
{(runtimeMode === 'dedicated-tab' || runtimeMode === 'auto' && !sharedWorkerAvailable) && (
    <Button variant="secondary" onClick={openWorkerTab}>
        {__('Open worker tab (fallback mode)', 'ultimate-ai-connector-webllm')}
    </Button>
)}
```

Where `sharedWorkerAvailable` comes from a capability check at mount time:

```jsx
const sharedWorkerAvailable = typeof SharedWorker !== 'undefined' && 'gpu' in navigator;
```

### Gotchas

1. **Setting defaults.** t008 already reads these options with `get_option(key, DEFAULT)` fallback, so this task can ship independently without breaking anything. After this task merges, both places agree on the defaults.
2. **`show_in_rest => true`** is required so the settings can be edited via the existing WP REST settings endpoint the connector card uses.
3. **Don't touch the existing option keys** (`webllm_default_model`, etc.). Additive only.

## Acceptance criteria

1. All four new options registered and visible via `GET /wp-json/wp/v2/settings` (when authenticated as admin).
2. Connector card UI shows the new panel with all four controls, defaults render correctly.
3. Changing a control updates the option via REST (verified by reloading the page and confirming persistence).
4. "Open worker tab" button only shown when mode is `dedicated-tab` or (`auto` + no SharedWorker support).
5. `composer test` passes.
6. Diff touches only `inc/settings.php`, `src/connector.jsx`, and possibly `inc/rest-api.php`.

## Verification commands

```bash
composer test
npm run build
# In admin: visit Settings → Connectors → WebLLM card, verify the new panel appears and saves correctly
curl -s http://localhost/wp-json/wp/v2/settings -u admin:password | jq '.webllm_runtime_mode, .webllm_widget_enabled, .webllm_widget_on_frontend, .webllm_widget_autostart'
```

## Context

- Depends on: [t008](t008-brief.md) (the injector reads these options)
- PRD reference: [prd-shared-worker-runtime.md](prd-shared-worker-runtime.md) → "Modified files"
