/**
 * WebLLM widget bootstrap.
 *
 * Tiny no-dependency script enqueued on every admin page (and optionally
 * the front-end footer for logged-in editors). Reads the `webllmConnector`
 * config blob localised by `inc/widget-injector.php`, performs a
 * SharedWorker + WebGPU capability check, and lazy-loads the heavy
 * `floating-widget.js` bundle only when the browser actually supports it.
 *
 * Keeping this script tiny and dependency-free means unsupported browsers
 * (Safari today, anything without WebGPU) pay near-zero page weight.
 *
 * @package UltimateAiConnectorWebLlm
 */

( function () {
	'use strict';

	const config = window.webllmConnector || {};

	if ( ! config.widgetEnabled ) {
		return;
	}

	const mode = config.runtimeMode || 'auto';
	if ( mode === 'disabled' || mode === 'dedicated-tab' ) {
		// Dedicated-tab mode is handled by the existing Tools → WebLLM Worker
		// admin page; the floating widget is not used in that mode.
		return;
	}

	const hasSharedWorker = typeof SharedWorker !== 'undefined';
	const hasWebGpu = typeof navigator !== 'undefined' && 'gpu' in navigator;

	if ( ! hasSharedWorker ) {
		// eslint-disable-next-line no-console
		console.debug( '[WebLLM] SharedWorker not supported; widget disabled. Use Tools → WebLLM Worker for dedicated-tab fallback.' );
		return;
	}
	if ( ! hasWebGpu ) {
		// eslint-disable-next-line no-console
		console.debug( '[WebLLM] WebGPU not supported; widget disabled.' );
		return;
	}

	if ( ! config.widgetBundleUrl ) {
		// eslint-disable-next-line no-console
		console.warn( '[WebLLM] widgetBundleUrl missing from webllmConnector config.' );
		return;
	}

	// Avoid double-injection if the bootstrap fires twice (admin_footer +
	// wp_footer can both run on some hybrid template pages).
	if ( window.__webllmWidgetBootstrapped ) {
		return;
	}
	window.__webllmWidgetBootstrapped = true;

	const script = document.createElement( 'script' );
	script.src = config.widgetBundleUrl;
	script.type = 'module';
	script.async = true;
	script.onerror = function () {
		// eslint-disable-next-line no-console
		console.warn( '[WebLLM] Failed to load widget bundle from', config.widgetBundleUrl );
		window.__webllmWidgetBootstrapped = false;
	};
	document.head.appendChild( script );
} )();
