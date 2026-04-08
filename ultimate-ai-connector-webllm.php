<?php
/**
 * Plugin Name: Ultimate AI Connector for WebLLM (Browser GPU)
 * Description: Registers an AI Client provider that runs LLM inference entirely in the user's browser via WebGPU + WebLLM. A persistent worker tab acts as the GPU; the WordPress site brokers requests so any logged-in device (phone, tablet, second laptop) can use it.
 * Requires at least: 7.0
 * Requires PHP: 7.4
 * Version: 1.0.2
 * Author: Ultimate Multisite Community
 * Author URI: https://ultimatemultisite.com
 * License: GPL-2.0-or-later
 * License URI: https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain: ultimate-ai-connector-webllm
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	return;
}

define( 'ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION', '1.0.2' );
define( 'ULTIMATE_AI_CONNECTOR_WEBLLM_FILE', __FILE__ );
define( 'ULTIMATE_AI_CONNECTOR_WEBLLM_DIR', __DIR__ );

// ---------------------------------------------------------------------------
// Always-loaded files (no SDK dependency).
// ---------------------------------------------------------------------------

require_once __DIR__ . '/inc/class-job-queue.php';
require_once __DIR__ . '/inc/settings.php';
require_once __DIR__ . '/inc/admin.php';
require_once __DIR__ . '/inc/rest-api.php';
require_once __DIR__ . '/inc/http-filters.php';
require_once __DIR__ . '/inc/widget-injector.php';

// ---------------------------------------------------------------------------
// SDK-dependent files (only loaded when WordPress AI Client SDK is present).
// ---------------------------------------------------------------------------

if ( class_exists( 'WordPress\\AiClient\\Providers\\ApiBasedImplementation\\AbstractApiProvider' ) ) {
	require_once __DIR__ . '/inc/class-provider.php';
	require_once __DIR__ . '/inc/class-model.php';
	require_once __DIR__ . '/inc/class-model-directory.php';
	require_once __DIR__ . '/inc/provider-registration.php';
}

// ---------------------------------------------------------------------------
// Hook registrations.
// ---------------------------------------------------------------------------

add_action( 'admin_init', __NAMESPACE__ . '\\register_settings' );
add_action( 'rest_api_init', __NAMESPACE__ . '\\register_settings' );
add_action( 'rest_api_init', __NAMESPACE__ . '\\register_rest_routes' );

add_filter( 'http_request_args', __NAMESPACE__ . '\\extend_loopback_timeout', 10, 2 );

/**
 * Register WebLLM as a preferred text-generation provider so that consumers
 * of `wpai_preferred_text_models` (e.g. the WordPress/ai plugin's AI Experiments
 * features) route requests to the browser-side engine.
 *
 * Only prepended when a default model is configured — an empty model setting
 * leaves the preference list untouched so other providers remain usable.
 *
 * @param array<int, array{0: string, 1: string}> $preferred_models The existing preference list.
 * @return array<int, array{0: string, 1: string}>
 */
add_filter(
	'wpai_preferred_text_models',
	static function ( array $preferred_models ): array {
		$active = (string) get_option( 'webllm_default_model', '' );
		if ( '' === $active ) {
			return $preferred_models;
		}

		array_unshift( $preferred_models, array( 'ultimate-ai-connector-webllm', $active ) );
		return $preferred_models;
	},
	5
);

add_action( 'admin_menu', __NAMESPACE__ . '\\register_worker_admin_page' );
add_action( 'admin_enqueue_scripts', __NAMESPACE__ . '\\enqueue_worker_assets' );
add_action( 'options-connectors-wp-admin_init', __NAMESPACE__ . '\\enqueue_connector_module' );

register_widget_injector_hooks();

if ( function_exists( __NAMESPACE__ . '\\register_provider' ) ) {
	add_action( 'init', __NAMESPACE__ . '\\register_provider', 5 );
}
