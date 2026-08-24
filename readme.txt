=== Ultimate AI Connector for WebLLM (Browser GPU) ===
Contributors: ultimatemultisite
Tags: ai, webllm, webgpu, llm, on-device
Requires at least: 6.9
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 1.2.2
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Run private, local LLM inference in the browser with WebGPU and WebLLM while WordPress securely brokers requests.

== Description ==

This plugin registers a `WebLLM (Browser GPU)` provider with the WordPress AI Client. Inference runs **entirely in your browser** using [WebLLM](https://github.com/mlc-ai/web-llm) on WebGPU. Prompts and generated responses are not sent to an external AI API.

In Chrome 124+ and Edge 124+, a SharedWorker loads the model automatically when you open any wp-admin page — no dedicated tab required. The model stays loaded as you navigate between admin pages. On older browsers, a dedicated Tools → WebLLM Worker tab acts as the fallback. Because the WordPress site itself acts as a broker, any logged-in device on the same install — phone, tablet, second laptop — can submit a request and have it served by your desktop GPU.

= Requirements =
* Modern browser with WebGPU (Chrome / Edge desktop strongly recommended).
* Dedicated GPU with plenty of VRAM for larger models.
* WordPress 6.9+ (bundled AI Client SDK).

== Installation ==

1. Upload the plugin ZIP through Plugins > Add Plugin > Upload Plugin, or install the extracted directory under `wp-content/plugins`.
2. Activate the plugin.
3. Open any wp-admin page in a supported desktop browser.
4. Click the WebLLM status control, choose a model, and start the worker. The first start downloads model files into the browser cache.

== External services ==

The plugin bundles its JavaScript inference runtime. When you explicitly start a model, WebLLM downloads that model's weights and compiled model library directly to your browser cache. WebLLM's bundled model catalog currently points to:

* [Hugging Face Hub](https://huggingface.co/) for model weights and metadata. Your browser connects only when a model is started; prompts and generated responses are not sent. [Terms](https://huggingface.co/terms-of-service) and [Privacy Policy](https://huggingface.co/privacy).
* [GitHub raw content](https://raw.githubusercontent.com/) for compiled WebAssembly model libraries. Your browser connects only when a model is started; prompts and generated responses are not sent. [Terms](https://docs.github.com/site-policy/github-terms/github-terms-of-service) and [Privacy Statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

These providers receive ordinary web-request information such as the user's IP address and browser user agent. Downloaded files remain in the browser cache until the user clears site data. Individual models may have their own licences and terms, shown by their publishers on the model page.

The human-readable source and build instructions for the compiled JavaScript are maintained at [the public source repository](https://github.com/Ultimate-Multisite/ultimate-ai-connector-webllm).

== Changelog ==

= 1.2.2 =
* Compliance: reduced the installable package below the WordPress.org submission limit by shipping only the WebLLM runtime.
* Security: sanitized the loopback authorization header before validating it.
* Documentation: disclosed model-download services, privacy implications, source code, and build instructions.

= 1.2.1 =
Version 1.2.1 - Released on 2026-08-19
- Improved: WordPress compatibility metadata now reflects testing through WordPress 7.1.

= 1.2.0 =
Released on 2026-04-09

* New: auto-pick heuristic now prefers newer model families, so the best available model is selected by default.
* New: WebGPU troubleshooting diagnostics panel — shown automatically when hardware or driver problems are detected.
* Fix: connector settings link now points to the correct options-connectors.php URL.
* Fix: cold-start model is always advertised so SDK capability matching passes before the worker has loaded.
* Fix: Ministral Reasoning models ranked at the same level as Instruct variants for consistent model selection.
* Improved: build/ directory committed for WordPress Playground git:directory support.

= 1.1.0 =
Released on 2026-04-09

* New: zero-config SharedWorker runtime — the LLM survives page navigation and shows a floating widget in the corner of admin pages. No more keeping a dedicated worker tab open.
* New: floating chat widget with admin-bar status indicator — any logged-in user can prompt the browser-side LLM directly from the front end.
* New: apiFetch middleware interceptor — WordPress REST requests that match the AI Client SDK pattern are transparently routed to the local WebLLM broker, no loopback HTTP round-trip needed. Shows a friendly start modal when the model is not loaded yet.
* New: widget settings UI in the Connector panel for toggling the chat widget and configuring auto-prompt behaviour.
* New: auto-detected recommended model based on hardware capabilities.
* New: settings panel for the runtime mode (auto / shared-worker / dedicated-tab / disabled).
* New: hooks into wpai_preferred_text_models filter so AI Experiments (WordPress/ai plugin) routes through WebLLM when configured.
* Fix: force IndexedDB cache backend so model weight downloads survive HuggingFace xet CDN redirects that break the default Cache API path.
* Fix: skip the context_window KV-cache override for embedding models (they have no decoder and the override caused a runtime error).
* Fix: advertise the cold-start candidate model in /webllm/v1/models before the worker tab has loaded, so SDK consumers see a model immediately.
* Improved: cache-busting, content normalisation, and hardware-reference fixes surfaced during end-to-end testing.
* Fallback: older browsers without SharedWorker + WebGPU support automatically fall back to the existing Tools → WebLLM Worker (Manual mode) page.
* Requires: Chrome 124+ or Edge 124+ for the SharedWorker runtime. Older browsers use the fallback.

= 1.0.2 =
* Fix: re-assert our `registerConnector()` call across multiple ticks (microtask + 0/50/250/1000ms) so the WP core `registerDefaultConnectors()` auto-register can't clobber our custom card with the generic API-key UI. The two scripts can run in either order depending on import-graph resolution; this guarantees we end up last. Resolves the regression where the WebLLM connector card showed an "API Key" input field instead of the worker-status panel.

= 1.0.1 =
* Performance: split `@mlc-ai/web-llm` into a separate webpack chunk loaded via dynamic `import()`. The Tools → WebLLM Worker page shell is now ~17 KB instead of ~5.8 MB; the heavy MLC bundle is fetched as `mlc-ai-web-llm.js` only when the worker page is opened.
* Fix: shorten the `/jobs/next` server-side long-poll from 25 s to 3 s so the worker doesn't pin a PHP-FPM slot for the full cycle. This avoids `pm.max_children` starvation on small installs (typical default is 5 workers) and reduces effective job-pickup latency to well under a second.

= 1.0.0 =
* Initial release.
