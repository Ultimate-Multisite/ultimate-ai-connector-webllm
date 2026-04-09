# Ultimate AI Connector for WebLLM (Browser GPU)

A WordPress 7.0+ plugin that adds a **WebLLM** provider to the bundled AI Client SDK. Inference runs **entirely in the user's browser** on WebGPU via [`@mlc-ai/web-llm`](https://github.com/mlc-ai/web-llm) — no API keys, no data leaving the device, no usage fees.

A SharedWorker running in the browser acts as the GPU; the WordPress site brokers requests so any logged-in device on the install (a phone, a tablet, a second laptop) can send a prompt and have it served by the desktop GPU.

## Why

Every other WordPress AI provider sends prompts to a third-party API. This one doesn't. The model weights live in the browser cache, the inference runs on the user's own GPU, and the only network traffic is between the WordPress site and the user's own browser tab.

This is the right answer when:

- You don't want to expose customer prompts to OpenAI / Anthropic / Google.
- You want WP-AI features (excerpt generation, alt text, agents) at zero per-token cost.
- You have a workstation with a dedicated GPU sitting idle and want to put it to use.

## Quick start

1. Install and activate the plugin on WordPress 7.0+.
2. Visit any wp-admin page. A small floating icon appears in the corner.
3. The first time you click an AI feature (e.g. the excerpt generator in WordPress/ai), a start modal appears showing the recommended model for your hardware. Click **Start**.
4. Wait for the model to download (once per browser — cached in IndexedDB after that).
5. Done. Every AI feature in WordPress is now served by your browser's GPU.

The model stays loaded as you navigate between admin pages and between posts. Closing the last wp-admin tab frees the GPU memory. Reopening wp-admin reloads the model from cache in a few seconds.

### Browser support

- **Chrome 124+, Edge 124+ (desktop)** — full SharedWorker runtime, zero-config
- **Older Chromium / Firefox / Safari** — fall back to the classic "Tools → WebLLM Worker (Manual mode)" page

### Cross-device usage

Because the WordPress site brokers requests, any logged-in device on the install can use the desktop's GPU. Open WP admin on your phone, click Generate excerpt, and the request is served by the SharedWorker in your desktop Chrome tab.

## How it works

```
PHP AI SDK ──▶ WebLlmProvider / WebLlmModel
                │  POST /wp-json/webllm/v1/chat/completions
                ▼
      REST broker (inc/rest-api.php)
                │ enqueue job, long-poll
                │
    ┌───────────┴───────────┐
    ▼                       ▼
SharedWorker            Dedicated tab
(Chrome 124+,           (fallback for older
 every admin            browsers and manual
 tab shares one)        override)
    │                       │
    │  Both run              │
    │  @mlc-ai/web-llm       │
    │  on WebGPU             │
    ▼                       ▼
GPU inference → POST /jobs/{id}/result → broker → SDK
```

The WordPress site is the broker. Any device on the install can submit a prompt; the SharedWorker (or fallback dedicated tab) handles the inference. This is what enables "phone uses my desktop's GPU".

## Requirements

- **WordPress 7.0+** (uses the bundled AI Client SDK).
- **PHP 7.4+**.
- A modern desktop browser with **WebGPU** enabled. Chrome 124+ / Edge 124+ for the zero-config SharedWorker runtime. On Linux you may need to enable `chrome://flags/#enable-unsafe-webgpu`, `#enable-vulkan`, and `#ignore-gpu-blocklist`.
- A GPU with **at least ~4 GB of VRAM** for the smallest useful chat models. Bigger models want 8–16 GB. WebLLM will fall back to SwiftShader on machines without a real GPU but inference will be unusably slow.

## Install

### From source

```bash
git clone https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm.git
cd ultimate-ai-connector-webllm
composer install --no-dev
npm install
npm run build
```

Symlink or copy the directory into `wp-content/plugins/`, then network-activate (or activate per-site) on a WordPress 7.0+ install.

## Use

### Zero-config (Chrome 124+ / Edge 124+)

1. Activate the plugin. A floating icon appears in the corner of every wp-admin page.
2. Click any AI feature. A start modal shows the recommended model for your hardware.
3. Click **Start** and wait for the model to download (cached in IndexedDB; subsequent loads are instant).
4. Done. The SharedWorker stays loaded as you navigate between admin pages.

### Manual mode (fallback for older browsers)

1. Open **Tools → WebLLM Worker (Manual mode)** in a desktop Chrome/Edge tab.
2. Pick a model (the dropdown is the live `prebuiltAppConfig.model_list` from the installed `@mlc-ai/web-llm` package, with VRAM hints; the default is auto-selected based on your GPU's reported `maxBufferSize`).
3. Click **Load model & start serving** and wait for the weights to download.
4. The card flips to **● Online** and starts polling the job queue.
5. Keep this tab open. Closing it makes the provider go offline within ~90 seconds.

### Settings

Visit **Settings → Connectors**, find **WebLLM (Browser GPU)**, click **Configure**, and tune:

- **Runtime mode** — Auto (SharedWorker on supported browsers, dedicated tab otherwise), SharedWorker only, Dedicated tab only, or Disabled.
- **Default Model** — what the SDK should pick when no model is specified.
- **Request Timeout** — how long PHP waits for a worker response (default 180 s).
- **Context Window** — overrides MLC's baked-in 4 K cap. Bump to 8192 / 16384 if your AI agent has a large system prompt or tool definitions. Each doubling roughly doubles KV cache VRAM.
- **Allow remote clients** — when on, any logged-in user on the install can submit jobs that get served by your worker tab. Off = admin only.

Use any WP AI feature normally (block-editor excerpt generation, alt-text, AI agent, etc.). The provider shows up under "WebLLM (Browser GPU)" wherever model pickers are exposed.

## What gets advertised to the AI SDK

Only the **currently-loaded** model. Even though WebLLM ships with ~140 prebuilt models, the SDK's model directory only sees the one your worker has actually downloaded and initialized — so capability matching can never route a request to a model that isn't ready to serve it.

## Architecture notes

- **No external API.** The provider's `baseUrl()` is `rest_url('webllm/v1')` — a loopback to the same WordPress install.
- **Bearer auth for loopback.** A 48-char random secret is auto-generated on first use, stored in `webllm_loopback_secret`, and passed to the SDK via `ApiKeyRequestAuthentication`. The REST permission callback validates the secret with `hash_equals` so server-side `wp_remote_request` calls (which don't carry browser cookies) still authenticate.
- **Public model catalog.** `GET /webllm/v1/models` is unauthenticated — it returns the live worker-reported list, which is just the public `@mlc-ai/web-llm` package metadata, not sensitive.
- **Direct DB reads in the long-poll.** WordPress's `get_option`/`get_transient` memoize results in a per-request static array, *and* `$wpdb` reuses one connection per request with MySQL's REPEATABLE READ isolation. Either of those would freeze the long-poll loop on its first read. The broker bypasses both with raw `$wpdb` queries plus an explicit `COMMIT` between iterations to start a fresh snapshot each tick.
- **URL-param parsing.** The `/jobs/{id}/result` callback reads `$request->get_url_params()['id']` directly instead of `$request->get_param('id')` — the WebLLM completion JSON body itself contains an `id` field that would otherwise shadow the URL pattern match.
- **SharedWorker lifetime.** The SharedWorker is spawned by the floating widget injected into every wp-admin page. It persists as long as at least one wp-admin tab is open in the same browser profile. The dedicated-tab fallback (Tools → WebLLM Worker) is still available for browsers without SharedWorker + WebGPU support.

## Settings reference

| Option key | Type | Default | Notes |
|---|---|---|---|
| `webllm_runtime_mode` | string | `'auto'` | `auto`, `shared-worker`, `dedicated-tab`, or `disabled` |
| `webllm_default_model` | string | `''` | Model id from the live prebuilt list. Empty = auto-pick. |
| `webllm_request_timeout` | int | `180` | Seconds PHP waits for the worker to return a result. |
| `webllm_context_window` | int | `8192` | KV cache size in tokens. Override of MLC's 4 K default. |
| `webllm_allow_remote_clients` | bool | `false` | Allow non-admin logged-in users (and other devices) to submit jobs. |
| `webllm_loopback_secret` | string | auto | 48-char random; bearer token for SDK loopback auth. Don't touch. |

## REST endpoints

All under `webllm/v1`:

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/chat/completions` | admin cookie / remote client / bearer | Brokers an OpenAI-shaped chat completion request to the worker tab. |
| `GET` | `/models` | public | Returns the currently-loaded model in OpenAI list shape. |
| `GET` | `/jobs/next` | admin cookie | Worker long-poll: returns the next pending job (204 if none). |
| `POST` | `/jobs/{id}/result` | admin cookie | Worker delivers the inference result. |
| `POST` | `/register-worker` | admin cookie | Worker reports its prebuilt model list and active model. |
| `GET` | `/status` | public | Returns `{worker_online, active_model, model_count}`. |

## Limitations

- **Speed.** WebLLM on integrated GPUs is single-digit tokens per second. Fine for asynchronous tasks (alt text, summaries) but feels slow for interactive chat. A discrete GPU is much faster.
- **One active worker at a time.** No load balancing. The most recently-active SharedWorker (or dedicated tab) wins.
- **No streaming.** The broker buffers the full completion before returning. Token-by-token streaming would require an SSE upgrade to the loopback path.
- **VLM (vision-language) models not yet supported.** The worker normalizes content-parts arrays down to plain strings.
- **SharedWorker requires Chrome 124+ or Edge 124+.** Older browsers and Firefox/Safari fall back to the dedicated-tab mode automatically.

## License

GPL-2.0-or-later. See `LICENSE`.
