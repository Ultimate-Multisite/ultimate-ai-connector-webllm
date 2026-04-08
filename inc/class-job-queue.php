<?php
/**
 * Transient-backed job queue used to broker requests between PHP and the
 * browser worker tab running WebLLM.
 *
 * Single FIFO. Each job has its own transient holding payload + result.
 * `wait_for_result()` long-polls in 250 ms steps until the result transient
 * is populated by the worker (via `POST /jobs/{id}/result`).
 *
 * @package UltimateAiConnectorWebLlm
 */

namespace UltimateAiConnectorWebLlm;

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Job_Queue {

	const QUEUE_OPTION         = 'webllm_queue';
	const JOB_TRANSIENT_PREFIX = 'webllm_job_';
	const WORKER_SEEN          = 'webllm_worker_seen';
	const MODEL_CACHE          = 'webllm_model_cache';
	const ACTIVE_MODEL         = 'webllm_active_model';

	/**
	 * Push a new job onto the queue. Returns the job id.
	 *
	 * @param string               $type    Job type: 'chat' or 'models'.
	 * @param array<string, mixed> $payload Arbitrary JSON-serializable payload.
	 * @param int                  $ttl     Transient TTL seconds.
	 */
	public static function enqueue( string $type, array $payload, int $ttl = 240 ): string {
		$id = wp_generate_uuid4();

		set_transient(
			self::JOB_TRANSIENT_PREFIX . $id,
			[
				'id'      => $id,
				'type'    => $type,
				'payload' => $payload,
				'status'  => 'pending',
				'result'  => null,
				'created' => time(),
			],
			$ttl
		);

		$queue   = get_option( self::QUEUE_OPTION, [] );
		$queue   = is_array( $queue ) ? $queue : [];
		$queue[] = $id;
		update_option( self::QUEUE_OPTION, $queue, false );

		return $id;
	}

	/**
	 * Claim the next pending job (FIFO). Returns null if queue empty.
	 *
	 * @return array<string, mixed>|null
	 */
	public static function claim_next(): ?array {
		global $wpdb;
		// Same issue as wait_for_result(): the implicit REPEATABLE READ
		// snapshot of this request's $wpdb connection plus WP's option
		// memoization would freeze the queue. COMMIT first to start a
		// fresh snapshot, then read the option directly from the DB.
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		$wpdb->query( 'COMMIT' );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		$raw = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
				self::QUEUE_OPTION
			)
		);
		$queue = is_string( $raw ) ? maybe_unserialize( $raw ) : [];
		if ( ! is_array( $queue ) || empty( $queue ) ) {
			return null;
		}

		while ( ! empty( $queue ) ) {
			$id   = array_shift( $queue );
			$opt  = '_transient_' . self::JOB_TRANSIENT_PREFIX . $id;
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$row  = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
					$opt
				)
			);
			$job  = is_string( $row ) ? maybe_unserialize( $row ) : null;
			if ( ! is_array( $job ) ) {
				continue; // expired or unknown.
			}
			if ( ( $job['status'] ?? '' ) !== 'pending' ) {
				continue;
			}
			$job['status']  = 'claimed';
			$job['claimed'] = time();
			set_transient( self::JOB_TRANSIENT_PREFIX . $id, $job, 240 );
			update_option( self::QUEUE_OPTION, $queue, false );
			return $job;
		}

		update_option( self::QUEUE_OPTION, $queue, false );
		return null;
	}

	/**
	 * Store the result for a job.
	 *
	 * @param array<string, mixed> $result Worker response payload.
	 */
	public static function store_result( string $id, array $result ): bool {
		$job = get_transient( self::JOB_TRANSIENT_PREFIX . $id );
		if ( ! is_array( $job ) ) {
			return false;
		}
		$job['status']    = 'done';
		$job['result']    = $result;
		$job['completed'] = time();
		set_transient( self::JOB_TRANSIENT_PREFIX . $id, $job, 240 );
		return true;
	}

	/**
	 * Block (long-poll) until a result is available or timeout reached.
	 *
	 * @param int $timeout_seconds Max time to wait.
	 * @return array<string, mixed>|null Result or null on timeout.
	 */
	public static function wait_for_result( string $id, int $timeout_seconds ): ?array {
		global $wpdb;
		$key      = self::JOB_TRANSIENT_PREFIX . $id;
		$opt_name = '_transient_' . $key;
		$deadline = microtime( true ) + max( 1, $timeout_seconds );

		// IMPORTANT: WordPress's `get_transient` ultimately calls `get_option`,
		// which memoizes both hits and misses inside a per-request static
		// array — and `$wpdb` reuses one DB connection per request. With
		// MySQL's default REPEATABLE READ isolation, every SELECT inside
		// the long-poll would see the same point-in-time snapshot the
		// first read took. We bypass the option API and explicitly COMMIT
		// before each SELECT so each tick starts a fresh transaction and
		// sees whatever the worker process committed.
		while ( microtime( true ) < $deadline ) {
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$wpdb->query( 'COMMIT' );
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$row = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
					$opt_name
				)
			);
			if ( is_string( $row ) && $row !== '' ) {
				$job = maybe_unserialize( $row );
				if ( is_array( $job ) && ( $job['status'] ?? '' ) === 'done' ) {
					delete_transient( $key );
					return is_array( $job['result'] ) ? $job['result'] : null;
				}
			}
			usleep( 250000 ); // 250 ms.
		}
		delete_transient( $key );
		return null;
	}

	/**
	 * Mark a worker as currently online. Called from heartbeat.
	 */
	public static function mark_worker_seen(): void {
		set_transient( self::WORKER_SEEN, time(), 90 );
	}

	/**
	 * True if a worker has checked in within the last 90 seconds.
	 */
	public static function is_worker_online(): bool {
		return (bool) get_transient( self::WORKER_SEEN );
	}

	/**
	 * Cache the model list reported by the worker on registration.
	 *
	 * @param array<int, array<string, mixed>> $models OpenAI-style {id, name} entries.
	 */
	public static function set_model_cache( array $models ): void {
		update_option( self::MODEL_CACHE, $models, false );
	}

	/**
	 * Get the cached model list.
	 *
	 * @return array<int, array<string, mixed>>
	 */
	public static function get_model_cache(): array {
		$m = get_option( self::MODEL_CACHE, [] );
		return is_array( $m ) ? $m : [];
	}

	/**
	 * Record which model the worker currently has loaded (empty string = none).
	 */
	public static function set_active_model( string $model_id ): void {
		if ( $model_id === '' ) {
			delete_transient( self::ACTIVE_MODEL );
			return;
		}
		set_transient( self::ACTIVE_MODEL, $model_id, 90 );
	}

	/**
	 * Returns the currently-loaded worker model, or '' if none.
	 */
	public static function get_active_model(): string {
		$v = get_transient( self::ACTIVE_MODEL );
		return is_string( $v ) ? $v : '';
	}

	/**
	 * Count pending (unclaimed) jobs without mutating the queue.
	 *
	 * Used by /webllm/v1/status so idle SharedWorkers can detect incoming
	 * traffic and prompt the user to start the engine. Bypasses option
	 * memoisation for the same reason `claim_next()` and `wait_for_result()`
	 * do — otherwise a SharedWorker looping inside one PHP request would
	 * see a stale snapshot.
	 *
	 * @return int Number of pending jobs in the queue.
	 */
	public static function get_pending_count(): int {
		global $wpdb;
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		$wpdb->query( 'COMMIT' );
		// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
		$raw = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
				self::QUEUE_OPTION
			)
		);
		$queue = is_string( $raw ) ? maybe_unserialize( $raw ) : [];
		if ( ! is_array( $queue ) || empty( $queue ) ) {
			return 0;
		}
		// Count only entries whose transient still exists and is pending;
		// expired/orphaned entries shouldn't trigger a user prompt.
		$count = 0;
		foreach ( $queue as $id ) {
			$opt = '_transient_' . self::JOB_TRANSIENT_PREFIX . $id;
			// phpcs:ignore WordPress.DB.DirectDatabaseQuery.DirectQuery
			$row = $wpdb->get_var(
				$wpdb->prepare(
					"SELECT option_value FROM {$wpdb->options} WHERE option_name = %s",
					$opt
				)
			);
			$job = is_string( $row ) ? maybe_unserialize( $row ) : null;
			if ( is_array( $job ) && ( $job['status'] ?? '' ) === 'pending' ) {
				$count++;
			}
		}
		return $count;
	}
}
