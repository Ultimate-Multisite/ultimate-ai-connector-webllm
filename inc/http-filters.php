<?php
/**
 * HTTP filters that extend the default `wp_remote_request` timeout for our
 * loopback REST calls — the AI Client SDK's model and chat endpoints can
 * block for up to `webllm_request_timeout` seconds while the broker waits
 * for the browser worker to respond.
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Bumps the HTTP timeout for requests hitting our `/webllm/v1/*` REST
 * endpoints. WordPress's default 5-second timeout is way too short for a
 * long-polled inference request.
 *
 * @param array<string, mixed> $args Existing HTTP request arguments.
 * @param string               $url  Target URL.
 * @return array<string, mixed>
 */
function extend_loopback_timeout( array $args, string $url ): array {
	if ( false === strpos( $url, '/webllm/v1/' ) ) {
		return $args;
	}
	// Give ourselves a generous headroom over the configured broker timeout
	// so the client side never times out before the server-side long-poll.
	$timeout = get_request_timeout() + 30;
	$args['timeout'] = $timeout;
	return $args;
}
