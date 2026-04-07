<?php
/**
 * Admin integration: worker page + Connectors card script module.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Adds the Tools → "WebLLM Worker" page.
 */
function register_worker_admin_page(): void {
	add_management_page(
		__( 'WebLLM Worker', 'ultimate-ai-connector-webllm' ),
		__( 'WebLLM Worker', 'ultimate-ai-connector-webllm' ),
		'manage_options',
		'webllm-worker',
		__NAMESPACE__ . '\\render_worker_page'
	);
}

/**
 * Renders the empty mount-point div + a helpful banner. The React/MLCEngine
 * code lives in build/worker.js (compiled from src/worker.jsx).
 */
function render_worker_page(): void {
	?>
	<div class="wrap">
		<h1><?php esc_html_e( 'WebLLM Worker', 'ultimate-ai-connector-webllm' ); ?></h1>
		<div style="background:#fff8e1;border-left:4px solid #f0b849;padding:12px 16px;margin:12px 0;max-width:760px">
			<strong><?php esc_html_e( 'This LLM runs entirely on your device.', 'ultimate-ai-connector-webllm' ); ?></strong>
			<p style="margin:6px 0 0">
				<?php esc_html_e( 'Keep this tab open while you want WebLLM to be available. A dedicated GPU with plenty of VRAM is strongly recommended — large models may freeze low-end machines. Phones, tablets, and other devices on the same WordPress install can route requests to this tab once "Allow remote clients" is enabled in the connector settings.', 'ultimate-ai-connector-webllm' ); ?>
			</p>
		</div>
		<div id="webllm-worker-root"></div>
	</div>
	<?php
}

/**
 * Enqueues the worker bundle on the worker page only.
 *
 * @param string $hook Current admin page hook.
 */
function enqueue_worker_assets( string $hook ): void {
	if ( 'tools_page_webllm-worker' !== $hook ) {
		return;
	}

	$build = plugin_dir_path( ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ) . 'build/worker.js';
	$ver   = file_exists( $build ) ? (string) filemtime( $build ) : ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION;

	wp_enqueue_script(
		'webllm-worker',
		plugins_url( 'build/worker.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		[ 'wp-element', 'wp-components', 'wp-i18n', 'wp-api-fetch' ],
		$ver,
		true
	);

	wp_localize_script(
		'webllm-worker',
		'WEBLLM_WORKER',
		[
			'restRoot'       => esc_url_raw( rest_url( 'webllm/v1' ) ),
			'nonce'          => wp_create_nonce( 'wp_rest' ),
			'requestTimeout' => get_request_timeout(),
			'defaultModel'   => (string) get_option( 'webllm_default_model', '' ),
			'contextWindow'  => get_context_window(),
		]
	);

	// The worker bundle is an ES module (webpack outputModule). Ensure the
	// <script> tag carries type="module" so the browser actually parses it.
	add_filter(
		'script_loader_tag',
		static function ( $tag, $handle ) {
			if ( 'webllm-worker' !== $handle ) {
				return $tag;
			}
			return str_replace( '<script ', '<script type="module" ', $tag );
		},
		10,
		2
	);
}

/**
 * Enqueues the connector module on the WP 7.0 Connectors page.
 */
function enqueue_connector_module(): void {
	wp_register_script_module(
		'ultimate-ai-connector-webllm',
		plugins_url( 'build/connector.js', ULTIMATE_AI_CONNECTOR_WEBLLM_FILE ),
		[
			[
				'id'     => '@wordpress/connectors',
				'import' => 'static',
			],
		],
		ULTIMATE_AI_CONNECTOR_WEBLLM_VERSION
	);
	wp_enqueue_script_module( 'ultimate-ai-connector-webllm' );
}
