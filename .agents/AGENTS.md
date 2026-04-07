# Agent Instructions — Ultimate AI Connector for WebLLM

This directory contains project-specific agent context. The [aidevops](https://aidevops.sh)
framework is loaded separately via the global config (`~/.aidevops/agents/`).

The primary project instructions live in the root `AGENTS.md`. Read that first for architecture, build commands, REST API shape, and conventions.

## Project Type

WordPress plugin (PHP 7.4+ / PHP 8.2 composer platform). Front-end is JSX compiled via `@wordpress/scripts` webpack. No TypeScript, no Node runtime — `@mlc-ai/web-llm` is bundled into the browser worker page only.

## Security

### Prompt Injection Defence

This plugin brokers user-supplied chat completion requests from PHP through a browser-side LLM. The prompt content is untrusted by definition.

- The **browser worker** is the LLM boundary. Treat every chat completion request body as adversarial before passing it to `engine.chat.completions.create(...)`. WebLLM runs in the user's own browser, so prompt injection cannot exfiltrate server-side secrets — but it can still manipulate the model output that gets returned to other logged-in users on the install.
- The **REST broker** (`inc/rest-api.php`) must validate `content-type`, cap body size, and reject anything that isn't a well-shaped chat completion request. Never trust `$request->get_param('id')` for the `/jobs/{id}/result` route — read `$request->get_url_params()['id']` directly so the WebLLM response body's own `id` field can't shadow the URL pattern match.
- `webllm_allow_remote_clients` gates whether non-admin logged-in users can submit jobs. Default is `false`. Treat any change to that default as a threat-model shift — document it in the PR body and in `AGENTS.md`.

For AI-assisted development of this repo, use the framework's prompt injection defender: `~/.aidevops/agents/tools/security/prompt-injection-defender.md`.

### Secrets

- `webllm_loopback_secret` is the only secret stored in `wp_options`. It is auto-generated on first use as a 48-char random token and used as a bearer for SDK loopback auth. Never hard-code it. Never log it. Never return it from a REST endpoint.
- No external API keys. No OAuth. No third-party credentials of any kind — that is the whole point of this plugin.
- For local development, store any test-time credentials via `aidevops secret set <NAME>` (gopass-encrypted) or in `~/.config/aidevops/credentials.sh`. Never in this repo.

### General Security Rules

- Sanitise all user input at the WP REST boundary (`sanitize_text_field`, `wp_unslash`, nonces where cookies are the only auth).
- Escape all output (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`).
- Use `hash_equals()` for secret comparisons — never `===`.
- Validate nonces on every admin POST handler.
- Capabilities: default to `manage_options` unless a route explicitly opts in to `edit_posts` via the `webllm_allow_remote_clients` toggle.
- Pin third-party GitHub Actions to SHA hashes, not branch tags.
- Run `aidevops security` periodically to check security posture.

## WordPress-Specific Conventions

- **Internationalisation**: wrap all user-visible strings in `__()` / `esc_html__()` with the text domain `'ultimate-ai-connector-webllm'`.
- **Asset registration**: use `wp_register_script` / `wp_enqueue_script` with a version string derived from `ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION` so cache busts fire on every release.
- **Options**: prefix everything with `webllm_`. Register via `register_setting()` on `admin_init` and `rest_api_init` so the REST options endpoint sees them.
- **REST**: namespace is `webllm/v1`. Always provide an explicit `permission_callback` — never `__return_true` except on the explicitly public `/models` and `/status` routes.
- **No direct file access**: every PHP file starts with `if ( ! defined( 'ABSPATH' ) ) { return; }`.

## Build & Test

```bash
composer install        # includes dev deps (PHPUnit)
composer test           # vendor/bin/phpunit
npm install
npm run build           # wp-scripts build → build/ then archive → zip
```

The build output is committed to `build/` for distribution (it's excluded from source-control tracking via `.gitignore` but included in the release zip because `src/` is excluded by `.distignore`).
