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
		'widgetBundleUrl'              => plugins_url( 'build/floating-widget.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		'middlewareBundleUrl'          => plugins_url( 'build/apifetch-middleware.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		'sharedWorkerUrl'              => plugins_url( 'build/shared-worker.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		'defaultModel'                 => (string) get_option( 'webllm_default_model', '' ),
		'knownModelIds'                => $known_models,
		'isPreferredForTextGeneration' => $is_preferred,
		'webllmAbilityPrefixes'        => [ 'ai/' ],
		'restNonce'                    => wp_create_nonce( 'wp_rest' ),
		'restUrl'                      => esc_url_raw( rest_url( 'webllm/v1/' ) ),
	];
}

/**
 * Enqueues the widget bootstrap script in the footer.
 *
 * Gated on user permissions and the runtime-mode/widget-enabled options so
 * disabling the widget in settings has zero page-weight cost.
 */
function inject_widget_bootstrap(): void {
	if ( ! is_user_logged_in() ) {
		return;
	}
	if ( ! current_user_can( 'edit_posts' ) ) {
		return;
	}

	$mode = (string) get_option( 'webllm_runtime_mode', 'auto' );
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
		[],
		ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION,
		true
	);
	wp_localize_script( $handle, 'webllmConnector', get_localized_widget_config() );
	wp_enqueue_script( $handle );
}

/**
 * Registers the admin and (optionally) front-end footer hooks.
 *
 * Called from the plugin entry point at load time.
 */
function register_widget_injector_hooks(): void {
	add_action( 'admin_footer', __NAMESPACE__ . '\\inject_widget_bootstrap' );
	if ( (bool) get_option( 'webllm_widget_on_frontend', false ) ) {
		add_action( 'wp_footer', __NAMESPACE__ . '\\inject_widget_bootstrap' );
	}
}
