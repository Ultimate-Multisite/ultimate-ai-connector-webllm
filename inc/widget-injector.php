<?php
/**
 * Floating widget bootstrap injector.
 *
 * Registers a tiny capability-detect bootstrap on every admin page (and
 * optionally the front-end footer for users with edit_posts) which lazy-loads
 * the full floating-widget bundle only when SharedWorker + WebGPU are
 * supported. Honours the runtime-mode and widget-enabled settings registered
 * by `inc/settings.php` (t009) but falls back to sensible defaults so it
 * works even on installs that pre-date those options.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Builds the `webllmConnector` config blob localised onto the bootstrap script.
 *
 * @return array<string, mixed>
 */
function get_localized_widget_config(): array {
	$known_models = [];
	if ( class_exists( __NAMESPACE__ . '\\WebLlmModelDirectory' ) ) {
		try {
			$directory = new WebLlmModelDirectory();
			foreach ( $directory->getAll() as $meta ) {
				if ( is_object( $meta ) && method_exists( $meta, 'id' ) ) {
					$known_models[] = (string) $meta->id();
				}
			}
		} catch ( \Throwable $e ) {
			// SDK not loaded yet; widget will populate via /webllm/v1/models.
			$known_models = [];
		}
	}

	$is_preferred = false;
	if ( function_exists( '\\WordPress\\AI\\get_preferred_models_for_text_generation' ) ) {
		$preferred = (array) \WordPress\AI\get_preferred_models_for_text_generation();
		foreach ( $preferred as $entry ) {
			if ( is_array( $entry ) && isset( $entry[0] ) && 'ultimate-ai-connector-webllm' === $entry[0] ) {
				$is_preferred = true;
				break;
			}
		}
	}

	return [
		'providerId'                   => 'ultimate-ai-connector-webllm',
		'runtimeMode'                  => (string) get_option( 'webllm_runtime_mode', 'auto' ),
		'widgetEnabled'                => (bool) get_option( 'webllm_widget_enabled', true ),
		'widgetAutostart'              => (bool) get_option( 'webllm_widget_autostart', false ),
		// Auto-load the engine when a pending job is detected (t014/t015).
		// Distinct from `widgetAutostart` which loads on page-ready.
		'autoStart'                    => (bool) get_option( 'webllm_auto_start', false ),
		// Append the plugin version to every bundle URL so browser and
		// SharedWorker caches invalidate on upgrade. SharedWorkers are
		// keyed by script URL — without this query-param, Chrome reuses
		// the old worker script across rebuilds and changes to
		// src/shared-worker.js only take effect after chrome://inspect
		// terminate-and-reload or a manual service worker reset.
		'widgetBundleUrl'              => add_query_arg( 'v', ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION, plugins_url( 'build/floating-widget.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ) ),
		'middlewareBundleUrl'          => add_query_arg( 'v', ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION, plugins_url( 'build/apifetch-middleware.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ) ),
		'sharedWorkerUrl'              => add_query_arg( 'v', ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION, plugins_url( 'build/shared-worker.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ) ),
		'defaultModel'                 => (string) get_option( 'webllm_default_model', '' ),
		'knownModelIds'                => $known_models,
		'isPreferredForTextGeneration' => $is_preferred,
		'webllmAbilityPrefixes'        => [ 'ai/' ],
		'restNonce'                    => wp_create_nonce( 'wp_rest' ),
		'restUrl'                      => esc_url_raw( rest_url( 'webllm/v1/' ) ),
	];
}

/**
 * True if the widget should be injected for the current user & settings.
 */
function widget_should_inject(): bool {
	if ( ! is_user_logged_in() ) {
		return false;
	}
	if ( ! current_user_can( 'edit_posts' ) ) {
		return false;
	}
	$mode = (string) get_option( 'webllm_runtime_mode', 'auto' );
	if ( 'disabled' === $mode || 'dedicated-tab' === $mode ) {
		return false;
	}
	if ( ! (bool) get_option( 'webllm_widget_enabled', true ) ) {
		return false;
	}
	return true;
}

/**
 * Enqueues the widget bootstrap script in the footer.
 *
 * Gated on user permissions and the runtime-mode/widget-enabled options so
 * disabling the widget in settings has zero page-weight cost. Loads on both
 * admin pages (always) and the front-end (whenever the admin bar is showing,
 * since that's where the status indicator lives).
 */
function inject_widget_bootstrap(): void {
	if ( ! widget_should_inject() ) {
		return;
	}

	$handle = 'webllm-widget-bootstrap';
	wp_register_script(
		$handle,
		plugins_url( 'build/widget-bootstrap.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		[],
		ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION,
		true
	);
	wp_localize_script( $handle, 'webllmConnector', get_localized_widget_config() );
	wp_enqueue_script( $handle );
}

/**
 * Adds the WebLLM status node to the WordPress admin bar.
 *
 * Renders an empty placeholder whose label and colour are updated at runtime
 * by src/floating-widget.jsx via SharedWorker state broadcasts. The submenu
 * nodes map to the widget's public API (Start / Stop / Open worker page).
 *
 * @param \WP_Admin_Bar $bar
 */
function register_admin_bar_node( $bar ): void {
	if ( ! ( $bar instanceof \WP_Admin_Bar ) ) {
		return;
	}
	if ( ! widget_should_inject() ) {
		return;
	}

	// Top-level status node — label is a placeholder until the widget
	// boots and pushes the real state into the DOM.
	$bar->add_menu(
		[
			'id'    => 'webllm-status',
			'title' => '<span class="ab-icon webllm-admin-bar-dot" data-state="connecting" aria-hidden="true"></span><span class="ab-label webllm-admin-bar-label">WebLLM</span>',
			'href'  => '#',
			'meta'  => [
				'class' => 'webllm-admin-bar-root',
				'title' => __( 'WebLLM (in-browser AI) status', 'ultimate-ai-connector-webllm' ),
			],
		]
	);

	$bar->add_menu(
		[
			'parent' => 'webllm-status',
			'id'     => 'webllm-status-start',
			'title'  => __( 'Start / load model', 'ultimate-ai-connector-webllm' ),
			'href'   => '#',
			'meta'   => [ 'class' => 'webllm-admin-bar-start' ],
		]
	);

	$bar->add_menu(
		[
			'parent' => 'webllm-status',
			'id'     => 'webllm-status-stop',
			'title'  => __( 'Stop / unload model', 'ultimate-ai-connector-webllm' ),
			'href'   => '#',
			'meta'   => [ 'class' => 'webllm-admin-bar-stop' ],
		]
	);

	$bar->add_menu(
		[
			'parent' => 'webllm-status',
			'id'     => 'webllm-status-open',
			'title'  => __( 'Open worker diagnostics', 'ultimate-ai-connector-webllm' ),
			'href'   => admin_url( 'tools.php?page=webllm-worker' ),
		]
	);

	$bar->add_menu(
		[
			'parent' => 'webllm-status',
			'id'     => 'webllm-status-settings',
			'title'  => __( 'Connector settings', 'ultimate-ai-connector-webllm' ),
			'href'   => admin_url( 'options-general.php?page=ultimate-ai-connector-webllm' ),
		]
	);
}

/**
 * Prints the tiny stylesheet for the admin bar status dot + submenu entries.
 */
function print_admin_bar_styles(): void {
	if ( ! widget_should_inject() ) {
		return;
	}
	?>
	<style id="webllm-admin-bar-styles">
		#wpadminbar .webllm-admin-bar-dot {
			display: inline-block;
			width: 10px;
			height: 10px;
			border-radius: 50%;
			margin: 10px 6px 0 0;
			background: #888;
			vertical-align: top;
			box-shadow: 0 0 0 1px rgba(255,255,255,0.15) inset;
			transition: background 120ms ease;
		}
		#wpadminbar .webllm-admin-bar-dot[data-state="connecting"] { background: #888; }
		#wpadminbar .webllm-admin-bar-dot[data-state="idle"]       { background: #aaa; }
		#wpadminbar .webllm-admin-bar-dot[data-state="loading"]    { background: #f0b429; animation: webllm-pulse 1.2s ease-in-out infinite; }
		#wpadminbar .webllm-admin-bar-dot[data-state="ready"]      { background: #46b450; }
		#wpadminbar .webllm-admin-bar-dot[data-state="busy"]       { background: #00a0d2; animation: webllm-pulse 0.8s ease-in-out infinite; }
		#wpadminbar .webllm-admin-bar-dot[data-state="needs-load"] { background: #f0b429; animation: webllm-pulse 0.6s ease-in-out infinite; }
		#wpadminbar .webllm-admin-bar-dot[data-state="error"]      { background: #dc3232; }
		@keyframes webllm-pulse {
			0%, 100% { opacity: 1; }
			50%      { opacity: 0.35; }
		}
	</style>
	<?php
}

/**
 * Registers the admin and front-end footer hooks + admin bar node.
 *
 * Called from the plugin entry point at load time.
 */
function register_widget_injector_hooks(): void {
	// Bootstrap injection on every admin page.
	add_action( 'admin_footer', __NAMESPACE__ . '\\inject_widget_bootstrap' );

	// Front-end bootstrap injection whenever the admin bar is visible — the
	// status node lives there, so we need the widget JS to drive it. The
	// legacy `webllm_widget_on_frontend` option is still honoured as an
	// explicit opt-in that runs even when the admin bar is hidden.
	add_action( 'wp_footer', __NAMESPACE__ . '\\maybe_inject_frontend_bootstrap' );

	// Admin bar node + stylesheet.
	add_action( 'admin_bar_menu', __NAMESPACE__ . '\\register_admin_bar_node', 100 );
	add_action( 'wp_before_admin_bar_render', __NAMESPACE__ . '\\print_admin_bar_styles' );
	add_action( 'wp_head', __NAMESPACE__ . '\\print_admin_bar_styles' );
	add_action( 'admin_head', __NAMESPACE__ . '\\print_admin_bar_styles' );
}

/**
 * Front-end footer hook that only injects when there's somewhere useful for
 * the widget to attach (the admin bar) or when the admin has explicitly
 * opted in via `webllm_widget_on_frontend`.
 */
function maybe_inject_frontend_bootstrap(): void {
	if ( ! is_admin_bar_showing() && ! (bool) get_option( 'webllm_widget_on_frontend', false ) ) {
		return;
	}
	inject_widget_bootstrap();
}
