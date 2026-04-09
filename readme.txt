=== Ultimate AI Connector for WebLLM (Browser GPU) ===
Contributors: ultimatemultisite
Tags: ai, webllm, webgpu, llm, on-device
Requires at least: 7.0
Tested up to: 7.0
Requires PHP: 7.4
Stable tag: 1.1.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Run LLM inference entirely in the user's browser via WebGPU + WebLLM. Routes through WordPress so phones, tablets, or other devices can use one desktop GPU.

== Description ==

This plugin registers a `WebLLM (Browser GPU)` provider with the WordPress 7.0 AI Client. Inference runs **entirely in your browser** using [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU — no API keys, no data leaving the device.

In Chrome 124+ and Edge 124+, a SharedWorker loads the model automatically when you open any wp-admin page — no dedicated tab required. The model stays loaded as you navigate between admin pages. On older browsers, a dedicated Tools → WebLLM Worker tab acts as the fallback. Because the WordPress site itself acts as a broker, any logged-in device on the same install — phone, tablet, second laptop — can submit a request and have it served by your desktop GPU.

= Requirements =
* Modern browser with WebGPU (Chrome / Edge desktop strongly recommended).
* Dedicated GPU with plenty of VRAM for larger models.
* WordPress 7.0+ (bundled AI Client SDK).

== Changelog ==

= 1.1.0 =
* NEW: Zero-config SharedWorker runtime — the LLM survives page navigation and shows a small floating icon in the corner of admin pages. No more keeping a dedicated worker tab open.
* NEW: Auto-detected recommended model based on hardware capabilities.
* NEW: apiFetch middleware intercepts AI requests from WordPress/ai experiments and shows a friendly start modal when the model isn't loaded yet.
* NEW: Settings panel for the runtime mode (auto / shared-worker / dedicated-tab / disabled).
* NEW: Hooks into `wpai_preferred_text_models` filter so AI Experiments (WordPress/ai plugin) actually routes through WebLLM when configured.
* FALLBACK: Older browsers without SharedWorker + WebGPU support automatically fall back to the existing Tools → WebLLM Worker (Manual mode) page.
* REQUIRES: Chrome 124+ or Edge 124+ for the SharedWorker runtime. Older browsers use the fallback.

= 1.0.2 =
* Fix: re-assert our `registerConnector()` call across multiple ticks (microtask + 0/50/250/1000ms) so the WP core `registerDefaultConnectors()` auto-register can't clobber our custom card with the generic API-key UI. The two scripts can run in either order depending on import-graph resolution; this guarantees we end up last. Resolves the regression where the WebLLM connector card showed an "API Key" input field instead of the worker-status panel.

= 1.0.1 =
* Performance: split `@mlc-ai/web-llm` into a separate webpack chunk loaded via dynamic `import()`. The Tools → WebLLM Worker page shell is now ~17 KB instead of ~5.8 MB; the heavy MLC bundle is fetched as `mlc-ai-web-llm.js` only when the worker page is opened.
* Fix: shorten the `/jobs/next` server-side long-poll from 25 s to 3 s so the worker doesn't pin a PHP-FPM slot for the full cycle. This avoids `pm.max_children` starvation on small installs (typical default is 5 workers) and reduces effective job-pickup latency to well under a second.

= 1.0.0 =
* Initial release.
