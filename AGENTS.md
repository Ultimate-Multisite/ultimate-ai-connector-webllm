# AGENTS.md — Ultimate AI Connector for WebLLM

WordPress plugin that registers a WebLLM provider with the bundled WordPress AI Client SDK. LLM inference runs entirely in the user's browser on WebGPU via `@mlc-ai/web-llm`. The WordPress site is a broker — a persistent admin worker tab acts as the GPU, and any logged-in device on the install can submit prompts that get served by that tab.

No third-party API. No API keys. No per-token cost. Model weights live in the browser cache.

## Project Overview

- **Type**: WordPress plugin (`wordpress-plugin` composer package type)
- **Minimum WordPress**: 7.0 (uses the bundled AI Client SDK)
- **Minimum PHP**: 7.4 (composer platform pinned to 8.2.0)
- **Licence**: GPL-2.0-or-later
- **Entry point**: `ultimate-ai-connector-webllm.php`
- **Namespace**: `UltimateAiConnectorWebLlm`
- **Text domain**: `ultimate-ai-connector-webllm`

## Architecture

```
PHP AI Client SDK ──▶ WebLlmProvider / WebLlmModel
                       │  createRequest() → POST /wp-json/webllm/v1/chat/completions
                       ▼
             REST broker (inc/rest-api.php)
                       │ enqueue job
                       │ long-poll wait for result (raw $wpdb + COMMIT per tick)
                       ▼
             Browser worker tab (Tools → WebLLM Worker)
                       │ GET /jobs/next (long-poll)
                       │ engine.chat.completions.create(...)
                       │ POST /jobs/{id}/result
                       ▼
             REST broker returns OpenAI-shaped response → SDK
```

The broker bypasses WordPress's option/transient memoization and MySQL's REPEATABLE READ isolation with raw `$wpdb` queries plus an explicit `COMMIT` between iterations — otherwise the long-poll loop would freeze on its first read.

## Directory Structure

```
ultimate-ai-connector-webllm/
├── ultimate-ai-connector-webllm.php   # Plugin entry point, hook registrations
├── inc/                                # Server-side PHP
│   ├── class-job-queue.php             # In-memory + transient job queue
│   ├── class-provider.php              # AI SDK provider implementation
│   ├── class-model.php                 # AI SDK model implementation
│   ├── class-model-directory.php       # Exposes currently-loaded model only
│   ├── provider-registration.php       # Hooks into AI SDK registry
│   ├── rest-api.php                    # /webllm/v1/* REST endpoints
│   ├── settings.php                    # Options registration + connector UI
│   ├── admin.php                       # Tools → WebLLM Worker admin page
│   └── http-filters.php                # Extends loopback HTTP timeout
├── src/                                # JSX source (webpack entry points)
│   ├── worker.jsx                      # Worker admin page (WebGPU runtime)
│   └── connector.jsx                   # Connector settings UI
├── build/                              # Compiled JS (generated; gitignored)
├── package.json                        # wp-scripts build pipeline
├── composer.json                       # Classmap autoload from inc/
└── webpack.config.js                   # wp-scripts override
```

## Build Commands

```bash
composer install --no-dev    # Install PHP dependencies (no tests)
composer install             # Install PHP dependencies with PHPUnit
npm install                  # Install Node dependencies (@mlc-ai/web-llm + wp-scripts)
npm run build                # wp-scripts build → build/ (then archive)
npm run start                # wp-scripts dev mode (watch + rebuild)
npm run archive              # composer archive → ultimate-ai-connector-webllm.zip
composer test                # Run PHPUnit
```

`npm run build` automatically triggers `postbuild` → `archive` → `postarchive` which produces a clean distributable zip in the repo root.

## REST API

All routes under `/wp-json/webllm/v1/`:

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/chat/completions` | admin cookie / remote client / bearer | Broker chat completion to worker tab |
| `GET` | `/models` | public | Currently-loaded model in OpenAI list shape |
| `GET` | `/jobs/next` | admin cookie | Worker long-poll: next pending job (204 if none) |
| `POST` | `/jobs/{id}/result` | admin cookie | Worker delivers inference result |
| `POST` | `/register-worker` | admin cookie | Worker reports prebuilt model list + active model |
| `GET` | `/status` | public | `{worker_online, active_model, model_count}` |

The `/jobs/{id}/result` handler reads `$request->get_url_params()['id']` directly, not `$request->get_param('id')` — the WebLLM JSON body itself has an `id` field that would shadow the URL pattern match otherwise.

## Settings (wp_options)

| Option key | Type | Default | Purpose |
|---|---|---|---|
| `webllm_default_model` | string | `''` | Model id from live prebuilt list; empty = auto-pick |
| `webllm_request_timeout` | int | `180` | Seconds PHP waits for worker result |
| `webllm_context_window` | int | `8192` | KV cache size in tokens (overrides MLC's 4K default) |
| `webllm_allow_remote_clients` | bool | `false` | Allow non-admin logged-in users to submit jobs |
| `webllm_loopback_secret` | string | auto | 48-char bearer token for SDK loopback auth |

## Code Style & Conventions

- PHP namespace: `UltimateAiConnectorWebLlm` (plus per-subfeature sub-namespaces)
- Constants prefix: `ULTIMATE_AI_CONNECTOR_WEBLLM_*`
- Autoloading: classmap over `inc/`
- Text domain: `ultimate-ai-connector-webllm`
- Commits: Conventional Commits
- Branches: `feature/`, `bugfix/`, `hotfix/`, `refactor/`, `chore/`

## Distribution

`.distignore` controls what composer excludes from the release archive. Current excludes: `.git`, `.github`, `.gitignore`, `.distignore`, `.idea`, `.vscode`, `.phpunit.result.cache`, `.DS_Store`, `node_modules`, `src`, `tests`, `phpunit.xml.dist`, `phpcs.xml.dist`, `webpack.config.js`, `package.json`, `package-lock.json`, `composer.lock`, `TODO.md`.

**Note**: `.agents/`, `.aidevops.json`, `todo/`, and `AGENTS.md` should also be excluded from distribution — see `.distignore`.

## Known Limitations

- Single worker tab at a time (no load balancing; most recently-active wins)
- No streaming (broker buffers full completion; SSE would require a loopback-path upgrade)
- VLM (vision-language) models not yet supported — worker normalises content-parts arrays to plain strings
- Inference speed on integrated GPUs is single-digit tokens/sec; fine for async tasks, slow for chat
