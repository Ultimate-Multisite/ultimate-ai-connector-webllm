<?php
/**
 * Settings registration for the WebLLM AI connector.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers the plugin settings (REST + admin).
 */
function register_settings(): void {
	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_default_model',
		[
			'type'              => 'string',
			'sanitize_callback' => 'sanitize_text_field',
			'default'           => '',
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_request_timeout',
		[
			'type'              => 'integer',
			'sanitize_callback' => 'absint',
			'default'           => 180,
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_allow_remote_clients',
		[
			'type'              => 'boolean',
			'sanitize_callback' => static function ( $v ): bool {
				return (bool) $v;
			},
			'default'           => false,
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_context_window',
		[
			'type'              => 'integer',
			'sanitize_callback' => 'absint',
			'default'           => 8192,
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_runtime_mode',
		[
			'type'              => 'string',
			'sanitize_callback' => static function ( $value ): string {
				$allowed = [ 'auto', 'shared-worker', 'dedicated-tab', 'disabled' ];
				return in_array( (string) $value, $allowed, true ) ? (string) $value : 'auto';
			},
			'default'           => 'auto',
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_widget_enabled',
		[
			'type'              => 'boolean',
			'sanitize_callback' => static function ( $v ): bool {
				return (bool) $v;
			},
			'default'           => true,
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_widget_on_frontend',
		[
			'type'              => 'boolean',
			'sanitize_callback' => static function ( $v ): bool {
				return (bool) $v;
			},
			'default'           => false,
			'show_in_rest'      => true,
		]
	);

	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_widget_autostart',
		[
			'type'              => 'boolean',
			'sanitize_callback' => static function ( $v ): bool {
				return (bool) $v;
			},
			'default'           => false,
			'show_in_rest'      => true,
		]
	);

	// When enabled, a pending inference job detected via the /status
	// `pending_jobs` counter will automatically trigger model load without
	// showing the start modal. Users opt in once, then repeat sessions
	// resume seamlessly because the weights are already in IndexedDB.
	register_setting(
		'ultimate_ai_connector_webllm',
		'webllm_auto_start',
		[
			'type'              => 'boolean',
			'sanitize_callback' => static function ( $v ): bool {
				return (bool) $v;
			},
			'default'           => false,
			'show_in_rest'      => true,
		]
	);
}

/**
 * Returns the configured context window size in tokens.
 * MLC's prebuilt model configs cap most chat models at 4096 to limit KV
 * cache memory; we override that at engine init time so longer system
 * prompts (e.g. AI agent tool definitions) fit.
 */
function get_context_window(): int {
	$n = (int) get_option( 'webllm_context_window', 8192 );
	if ( $n < 1024 ) {
		$n = 1024;
	}
	if ( $n > 131072 ) {
		$n = 131072;
	}
	return $n;
}

/**
 * Returns the configured request timeout in seconds.
 */
function get_request_timeout(): int {
	$t = (int) get_option( 'webllm_request_timeout', 180 );
	if ( $t < 10 ) {
		$t = 10;
	}
	if ( $t > 600 ) {
		$t = 600;
	}
	return $t;
}
