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

	// Full cached model catalogue — separate from /models which only
	// advertises a single candidate for the SDK capability matcher.
	// The connector settings UI uses this to let the admin pick any model
	// the worker has reported. Client-side filters (see connector.jsx)
	// hide variants the adapter can't compile (e.g. f16 on Pascal).
	register_rest_route(
		'webllm/v1',
		'/catalog',
		[
			'methods'             => 'GET',
			'callback'            => __NAMESPACE__ . '\\rest_catalog',
			'permission_callback' => __NAMESPACE__ . '\\client_permission_callback',
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
	// Note: we no longer bail early when no model is active. The new
	// SharedWorker runtime can detect an enqueued job via the /status
	// `pending_jobs` counter and auto-load the model while the client is
	// still long-polling. Enqueue unconditionally and let `wait_for_result`
	// do its job — if it times out we return a friendlier message that
	// points the user at the admin-bar start control.
	$payload = $request->get_json_params();
	if ( ! is_array( $payload ) ) {
		$payload = [];
	}

	$id      = Job_Queue::enqueue( 'chat', $payload, get_request_timeout() + 60 );
	$result  = Job_Queue::wait_for_result( $id, get_request_timeout() );

	if ( null === $result ) {
		$worker_online = Job_Queue::is_worker_online();
		$active        = Job_Queue::get_active_model();
		if ( ! $worker_online ) {
			return new \WP_Error(
				'webllm_no_worker',
				__( 'No WebLLM worker is currently connected. Open any admin page and click the WebLLM status in the top admin bar to start the in-browser AI.', 'ultimate-ai-connector-webllm' ),
				[ 'status' => 503 ]
			);
		}
		if ( '' === $active ) {
			return new \WP_Error(
				'webllm_not_loaded',
				__( 'A worker tab is open but no model is loaded yet. Click the WebLLM status in the admin bar and choose Start, or enable auto-start in the connector settings.', 'ultimate-ai-connector-webllm' ),
				[ 'status' => 503 ]
			);
		}
		return new \WP_Error(
			'webllm_timeout',
			__( 'Timed out waiting for the WebLLM worker to respond. The model is loaded but inference did not complete in time — try a smaller model or a simpler prompt.', 'ultimate-ai-connector-webllm' ),
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
 * GET /models — advertise a single candidate model.
 *
 * Resolution order:
 *   1. The currently-loaded worker model (hot path — honest answer).
 *   2. The configured `webllm_default_model` option, if set and present in
 *      the worker's reported catalog.
 *   3. The first entry from the cached worker catalog (auto-pick).
 *   4. The configured `webllm_default_model` even without a cache (admin
 *      set it but the worker hasn't registered yet).
 *   5. A hardcoded cold-start placeholder so the SDK never sees an empty
 *      model list.
 *
 * We deliberately never advertise the full `prebuiltAppConfig.model_list`:
 * the AI SDK's capability-matching treats every listed model as usable and
 * would happily route a request to a model that's not loaded. Exposing a
 * single candidate is safe because the apiFetch middleware intercepts the
 * request in the browser and calls `webllmWidget.promptAndLoad()` to bring
 * the engine online before the broker relays the job.
 *
 * Steps 4-5 are critical: without a cold-start candidate the PHP SDK
 * rejects the prompt during provider-side capability matching — "No models
 * found for provider … that support text_generation" — long before any JS
 * middleware can run. The placeholder ID is never sent to the engine; the
 * SharedWorker's `autoPickModel()` selects the real model at load time.
 * The broker's `rest_chat_completions` enqueues the job unconditionally
 * and the idle-peek loop / apiFetch middleware handle the cold-start UX.
 */
function rest_list_models( \WP_REST_Request $request ) {
	$candidate = Job_Queue::get_active_model();

	if ( '' === $candidate ) {
		$cache       = Job_Queue::get_model_cache();
		$cache_ids   = [];
		foreach ( $cache as $entry ) {
			if ( isset( $entry['id'] ) ) {
				$cache_ids[] = (string) $entry['id'];
			}
		}

		$default = (string) get_option( 'webllm_default_model', '' );
		if ( '' !== $default && in_array( $default, $cache_ids, true ) ) {
			$candidate = $default;
		} elseif ( ! empty( $cache_ids ) ) {
			$candidate = $cache_ids[0];
		} elseif ( '' !== $default ) {
			// Admin configured a default but the worker hasn't registered
			// yet (no cache). Trust the admin's choice as the cold-start
			// candidate — it will be validated when the worker loads.
			$candidate = $default;
		}
	}

	// Always advertise at least one model so the SDK's capability matcher
	// passes. The apiFetch middleware and SharedWorker idle-peek loop
	// handle the actual cold-start (prompting the user or auto-loading).
	// Without this fallback the SDK rejects every request with "No models
	// found for provider … that support text_generation" before any
	// browser-side code can intervene.
	if ( '' === $candidate ) {
		$candidate = 'webllm-cold-start-placeholder';
	}

	$data = [ [ 'id' => $candidate, 'name' => $candidate ] ];

	return rest_ensure_response(
		[
			'object' => 'list',
			'data'   => $data,
		]
	);
}

/**
 * GET /jobs/next — short-poll. Briefly waits for a job, then returns 204
 * so the worker can re-poll. Each request holds a PHP-FPM worker for at
 * most ~3 seconds, which is critical on installs with low `pm.max_children`
 * (typical default is 5). The worker JS reconnects immediately on 204, so
 * effective latency is ≪ 1 second when a job is enqueued.
 */
function rest_jobs_next( \WP_REST_Request $request ) {
	Job_Queue::mark_worker_seen();

	$deadline = microtime( true ) + 3.0;
	while ( microtime( true ) < $deadline ) {
		$job = Job_Queue::claim_next();
		if ( $job ) {
			return rest_ensure_response( $job );
		}
		usleep( 200000 ); // 200 ms.
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
/**
 * GET /catalog — full cached model list.
 *
 * Unlike /models (which deliberately advertises a single candidate to the
 * SDK), /catalog exposes everything the worker has reported. It's used by
 * the connector settings UI to let the admin pick any model — the client
 * filters out variants that require WebGPU extensions the adapter doesn't
 * expose.
 */
function rest_catalog( \WP_REST_Request $request ) {
	$cache = Job_Queue::get_model_cache();
	return rest_ensure_response(
		[
			'object' => 'list',
			'data'   => array_values( $cache ),
		]
	);
}

function rest_status( \WP_REST_Request $request ) {
	return rest_ensure_response(
		[
			'worker_online' => Job_Queue::is_worker_online(),
			'active_model'  => Job_Queue::get_active_model(),
			'model_count'   => count( Job_Queue::get_model_cache() ),
			// Pending job count so idle SharedWorkers can detect incoming
			// traffic and prompt the user to start the engine. See t014.
			'pending_jobs'  => Job_Queue::get_pending_count(),
		]
	);
}
