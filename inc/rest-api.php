<?php
/**
 * REST API endpoints for the WebLLM connector.
 *
 * Routes (namespace `webllm/v1`):
 *
 *  POST /chat/completions   — OpenAI-shaped request, brokered to the worker, blocks until response.
 *  GET  /models             — Returns the worker-reported model catalog in OpenAI shape.
 *  GET  /jobs/next          — Worker long-poll: claim the next pending job (204 if none).
 *  POST /jobs/{id}/result   — Worker posts the inference result.
 *  POST /register-worker    — Worker reports model_list + heartbeats.
 *
 * Auth model:
 *   - chat/completions / models : `manage_options`, OR any logged-in user when
 *     `webllm_allow_remote_clients` is enabled (this is what allows a phone to
 *     consume the desktop GPU).
 *   - jobs/next, jobs/{id}/result, register-worker : `manage_options`
 *     (the user that opened the worker tab is presumed to be an admin).
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * Registers all REST routes.
 */
function register_rest_routes(): void {
	register_rest_route(
		'webllm/v1',
		'/chat/completions',
		[
			'methods'             => 'POST',
			'callback'            => __NAMESPACE__ . '\\rest_chat_completions',
			'permission_callback' => __NAMESPACE__ . '\\client_permission_callback',
		]
	);

	// Models catalog is the live `prebuiltAppConfig.model_list` from
	// `@mlc-ai/web-llm` — a public package, not sensitive. We leave it
	// unauthenticated so (a) the SDK's server-to-server loopback call from
	// the model directory succeeds without cookies, and (b) client UIs can
	// populate dropdowns without juggling nonces.
	register_rest_route(
		'webllm/v1',
		'/models',
		[
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\\rest_list_models',
			'permission_callback' => '__return_true',
		]
	);

	register_rest_route(
		'webllm/v1',
		'/jobs/next',
		[
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\\rest_jobs_next',
			'permission_callback' => __NAMESPACE__ . '\\worker_permission_callback',
		]
	);

	register_rest_route(
		'webllm/v1',
		'/jobs/(?P<id>[a-f0-9-]+)/result',
		[
			'methods'             => 'POST',
			'callback'            => __NAMESPACE__ . '\\rest_jobs_result',
			'permission_callback' => __NAMESPACE__ . '\\worker_permission_callback',
		]
	);

	register_rest_route(
		'webllm/v1',
		'/register-worker',
		[
			'methods'             => 'POST',
			'callback'            => __NAMESPACE__ . '\\rest_register_worker',
			'permission_callback' => __NAMESPACE__ . '\\worker_permission_callback',
		]
	);

	register_rest_route(
		'webllm/v1',
		'/status',
		[
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\\rest_status',
			'permission_callback' => '__return_true',
		]
	);
}

/**
 * Permission callback for client routes (chat completions).
 *
 * Accepts three identities:
 *   1. Admin cookie auth (`manage_options`).
 *   2. Any logged-in user, when the admin has enabled "allow remote clients".
 *   3. A server-side loopback call authenticated via a shared secret in the
 *      `Authorization: Bearer <secret>` header — this is how the WordPress
 *      AI Client SDK reaches us when PHP-side code calls `generateText()`,
 *      since `wp_remote_request` doesn't forward browser cookies.
 */
function client_permission_callback(): bool {
	if ( current_user_can( 'manage_options' ) ) {
		return true;
	}
	if ( get_option( 'webllm_allow_remote_clients', false ) && is_user_logged_in() ) {
		return true;
	}

	$secret = get_loopback_secret();
	if ( $secret ) {
		$auth = '';
		if ( ! empty( $_SERVER['HTTP_AUTHORIZATION'] ) ) {
			$auth = (string) $_SERVER['HTTP_AUTHORIZATION'];
		} elseif ( function_exists( 'getallheaders' ) ) {
			$headers = getallheaders();
			if ( is_array( $headers ) ) {
				foreach ( $headers as $k => $v ) {
					if ( strcasecmp( $k, 'Authorization' ) === 0 ) {
						$auth = (string) $v;
						break;
					}
				}
			}
		}
		if ( $auth && stripos( $auth, 'Bearer ' ) === 0 ) {
			$token = trim( substr( $auth, 7 ) );
			if ( hash_equals( $secret, $token ) ) {
				return true;
			}
		}
	}

	return false;
}

/**
 * Returns the shared loopback secret, generating one on first use.
 * This secret never leaves the PHP process — the SDK reads it via
 * `ApiKeyRequestAuthentication` when we register the provider.
 */
function get_loopback_secret(): string {
	$secret = get_option( 'webllm_loopback_secret', '' );
	if ( empty( $secret ) ) {
		$secret = wp_generate_password( 48, false, false );
		update_option( 'webllm_loopback_secret', $secret, false );
	}
	return (string) $secret;
}

/**
 * Permission callback for worker routes.
 */
function worker_permission_callback(): bool {
	return current_user_can( 'manage_options' );
}

/**
 * POST /chat/completions — broker to worker, return its response verbatim.
 */
function rest_chat_completions( \WP_REST_Request $request ) {
	$active = Job_Queue::get_active_model();
	if ( '' === $active ) {
		if ( ! Job_Queue::is_worker_online() ) {
			return new \WP_Error(
				'webllm_no_worker',
				__( 'No WebLLM worker is currently connected. Open the WebLLM Worker page in a desktop browser tab.', 'ultimate-ai-connector-webllm' ),
				[ 'status' => 503 ]
			);
		}
		return new \WP_Error(
			'webllm_no_model',
			__( 'The WebLLM worker tab is open but has not finished loading a model yet. Wait for the model to finish downloading, then try again.', 'ultimate-ai-connector-webllm' ),
			[ 'status' => 503 ]
		);
	}

	$payload = $request->get_json_params();
	if ( ! is_array( $payload ) ) {
		$payload = [];
	}

	$id      = Job_Queue::enqueue( 'chat', $payload, get_request_timeout() + 60 );
	$result  = Job_Queue::wait_for_result( $id, get_request_timeout() );

	if ( null === $result ) {
		return new \WP_Error(
			'webllm_timeout',
			__( 'Timed out waiting for the WebLLM worker to respond.', 'ultimate-ai-connector-webllm' ),
			[ 'status' => 504 ]
		);
	}

	if ( isset( $result['error'] ) ) {
		return new \WP_Error(
			'webllm_worker_error',
			is_string( $result['error'] ) ? $result['error'] : wp_json_encode( $result['error'] ),
			[ 'status' => 502 ]
		);
	}

	return rest_ensure_response( $result );
}

/**
 * GET /models — return only the currently-loaded worker model.
 *
 * We deliberately do NOT advertise the full `prebuiltAppConfig.model_list`:
 * the AI SDK's capability-matching treats every listed model as usable and
 * would happily route a request to a model that's not loaded, producing a
 * confusing "no worker" error. By exposing only the active model we make
 * the provider honest — the only model the caller can pick is the one the
 * worker can actually serve right now.
 */
function rest_list_models( \WP_REST_Request $request ) {
	$active = Job_Queue::get_active_model();
	$data   = [];
	if ( '' !== $active ) {
		$data[] = [ 'id' => $active, 'name' => $active ];
	}
	return rest_ensure_response(
		[
			'object' => 'list',
			'data'   => $data,
		]
	);
}

/**
 * GET /jobs/next — worker long-poll. Briefly waits for a job to appear.
 */
function rest_jobs_next( \WP_REST_Request $request ) {
	Job_Queue::mark_worker_seen();

	// Up to ~25 seconds of polling per request to keep the worker tab efficient.
	$deadline = microtime( true ) + 25.0;
	while ( microtime( true ) < $deadline ) {
		$job = Job_Queue::claim_next();
		if ( $job ) {
			return rest_ensure_response( $job );
		}
		usleep( 300000 );
	}

	return new \WP_REST_Response( null, 204 );
}

/**
 * POST /jobs/{id}/result — worker delivers the inference result.
 */
function rest_jobs_result( \WP_REST_Request $request ) {
	Job_Queue::mark_worker_seen();
	// Read the id from the URL pattern explicitly. `$request->get_param('id')`
	// would otherwise return the `id` field of the OpenAI completion JSON
	// body (which WebLLM populates with its own UUID), shadowing the URL
	// pattern match and routing the result to the wrong job.
	$url_params = $request->get_url_params();
	$id         = (string) ( $url_params['id'] ?? '' );
	$result     = $request->get_json_params();
	if ( ! is_array( $result ) ) {
		$result = [];
	}
	$ok = Job_Queue::store_result( $id, $result );
	return rest_ensure_response( [ 'stored' => $ok ] );
}

/**
 * POST /register-worker — worker introduces itself and reports prebuilt model list.
 */
function rest_register_worker( \WP_REST_Request $request ) {
	Job_Queue::mark_worker_seen();
	$body = $request->get_json_params();
	if ( ! is_array( $body ) ) {
		$body = [];
	}

	// Record which model (if any) the worker currently has loaded. An empty
	// string explicitly clears the active-model transient so the provider
	// reports "no model" instead of a stale one after an unload.
	if ( array_key_exists( 'active_model', $body ) ) {
		Job_Queue::set_active_model( (string) $body['active_model'] );
	}

	// The full prebuilt catalog is only used by the worker-page model picker
	// and the connectors card; it's no longer exposed to the SDK's model
	// directory (see rest_list_models for the rationale).
	$models = ( isset( $body['models'] ) && is_array( $body['models'] ) ) ? $body['models'] : [];
	$normalized = [];
	foreach ( $models as $m ) {
		if ( ! is_array( $m ) ) {
			continue;
		}
		$id = $m['id'] ?? $m['model_id'] ?? '';
		if ( empty( $id ) ) {
			continue;
		}
		$normalized[] = [
			'id'   => (string) $id,
			'name' => (string) ( $m['name'] ?? $id ),
		];
	}
	if ( ! empty( $normalized ) ) {
		Job_Queue::set_model_cache( $normalized );
	}

	return rest_ensure_response(
		[
			'ok'              => true,
			'cached_models'   => count( Job_Queue::get_model_cache() ),
			'active_model'    => Job_Queue::get_active_model(),
			'request_timeout' => get_request_timeout(),
		]
	);
}

/**
 * GET /status — public-ish status (no sensitive info) used by the connector card.
 */
function rest_status( \WP_REST_Request $request ) {
	return rest_ensure_response(
		[
			'worker_online' => Job_Queue::is_worker_online(),
			'active_model'  => Job_Queue::get_active_model(),
			'model_count'   => count( Job_Queue::get_model_cache() ),
		]
	);
}
