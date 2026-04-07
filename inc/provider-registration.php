<?php
/**
 * Provider registration with the WordPress AI Client.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

use WordPress\AiClient\AiClient;
use WordPress\AiClient\Providers\Http\DTO\ApiKeyRequestAuthentication;

/**
 * Registers the WebLLM provider with the AI Client at init priority 5.
 */
function register_provider(): void {
	if ( ! class_exists( AiClient::class ) ) {
		return;
	}

	WebLlmProvider::$endpointUrl = rest_url( 'webllm/v1' );

	$registry = AiClient::defaultRegistry();

	if ( $registry->hasProvider( WebLlmProvider::class ) ) {
		return;
	}

	$registry->registerProvider( WebLlmProvider::class );

	// The SDK auto-injects `Authorization: Bearer <key>` into every request
	// via ApiKeyRequestAuthentication. We pass our shared loopback secret so
	// server-side loopback calls authenticate against the REST permission
	// check (see `client_permission_callback` in rest-api.php).
	$registry->setProviderRequestAuthentication(
		WebLlmProvider::class,
		new ApiKeyRequestAuthentication( get_loopback_secret() )
	);
}

/**
 * Returns the configured default model id.
 */
function get_default_model(): string {
	return (string) get_option( 'webllm_default_model', '' );
}
