// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
//
// src/shared-worker.js — WebLLM engine host inside SharedWorkerGlobalScope.
//
// See todo/PLANS.md p001 and todo/tasks/prd-shared-worker-runtime.md
// for the full architectural context.
//
// Key design decisions:
//   - Single MLCEngine instance shared across all connected tabs.
//   - Multi-port message routing: each tab gets its own MessagePort.
//   - RPC-style message API: { type, id, ...args } → { id, type, ...result }
//   - State broadcasts: all ports receive state changes automatically.
//   - Broker polling: when engine is ready, polls /wp-json/webllm/v1/jobs/next.
//
// SharedWorker URL identity (Gotcha #1): keyed by (script URL, name).
// Do NOT hash the filename — use a stable URL and VERSION for mismatch detection.

import { MLCEngine, prebuiltAppConfig } from '@mlc-ai/web-llm';

// ---------------------------------------------------------------------------
// Module-level state (shared across all connected tabs)
// ---------------------------------------------------------------------------

const VERSION = 1; // bump on breaking message-schema changes

/** @type {MLCEngine|null} */
let engine = null;

/** @type {'idle'|'loading'|'ready'|'busy'|'error'} */
let state = 'idle';

/** @type {string|null} */
let currentModelId = null;

/** @type {object|null} */
let currentProgress = null;

/** @type {string|null} */
let lastError = null;

/** @type {string|null} */
let restNonce = null;

/** @type {Set<MessagePort>} */
const ports = new Set();

/** @type {boolean} */
let pollingActive = false;

/** @type {boolean} */
let idlePeekActive = false;

/** @type {number} */
let lastAnnouncedPendingJobs = 0;

// ---------------------------------------------------------------------------
// Broadcast helpers
// ---------------------------------------------------------------------------

/**
 * Send a message to all connected ports.
 *
 * @param {Object} message
 */
function broadcast( message ) {
	for ( const port of ports ) {
		try {
			port.postMessage( message );
		} catch ( _ ) {
			// Port may have been closed — remove it silently.
			ports.delete( port );
		}
	}
}

/**
 * Build a state snapshot object for broadcasting or replying.
 *
 * @return {Object} State snapshot with type, state, currentModelId, progress, error, version.
 */
function snapshot() {
	return {
		type: 'state',
		state,
		currentModelId,
		progress: currentProgress,
		error: lastError,
		version: VERSION,
	};
}

/**
 * Transition to a new state and broadcast to all ports.
 *
 * @param {'idle'|'loading'|'ready'|'busy'|'error'} next
 * @param {Object}                                  extra Optional overrides: { progress, error }
 */
function setState( next, extra = {} ) {
	state = next;
	if ( 'progress' in extra ) {
		currentProgress = extra.progress;
	}
	if ( 'error' in extra ) {
		lastError = extra.error;
	}
	broadcast( snapshot() );

	// Engine went active → broker polling handles traffic, peek loop is
	// redundant. Engine went inactive → start peeking for incoming jobs.
	if ( next === 'ready' || next === 'busy' || next === 'loading' ) {
		stopIdlePeeking();
	} else {
		startIdlePeeking();
	}
}

// ---------------------------------------------------------------------------
// Auto-pick model heuristic (lifted from src/worker.jsx)
// ---------------------------------------------------------------------------

/**
 * Estimate a VRAM budget from the WebGPU adapter and pick the best-fit model.
 *
 * Uses `adapter.limits.maxBufferSize` as a conservative VRAM proxy (WebGPU
 * doesn't expose total VRAM directly). Reserves 30% headroom for KV cache.
 * Prefers newer model families, then larger models within the same family.
 *
 * @param {Array<object>} list Array of prebuilt model descriptors.
 * @return {Promise<string>}   Model ID string.
 */
async function autoPickModel( list ) {
	let budgetMB = 1400; // fallback when WebGPU isn't available yet
	let hasShaderF16 = false;
	try {
		// eslint-disable-next-line no-undef
		const adapter = await self.navigator?.gpu?.requestAdapter();
		if ( adapter?.limits?.maxBufferSize ) {
			budgetMB = Math.floor(
				( adapter.limits.maxBufferSize / 1024 / 1024 ) * 0.7
			);
		}
		// Only consider models whose kernels the adapter can actually
		// compile. Without the `shader-f16` WebGPU extension, any model
		// with f16/BF16 weights throws "This model requires WebGPU
		// extension shader-f16" at load time — better to never attempt it.
		if ( adapter?.features && typeof adapter.features.has === 'function' ) {
			hasShaderF16 = adapter.features.has( 'shader-f16' );
		}
	} catch ( e ) {}

	const familyRank = ( id ) => {
		if ( /Llama-3\.2.*Instruct/i.test( id ) ) {
			return 6;
		}
		if ( /Llama-3\.1.*Instruct/i.test( id ) ) {
			return 5;
		}
		if ( /Qwen2\.5.*Instruct/i.test( id ) ) {
			return 4;
		}
		if ( /Phi-3.*mini.*Instruct/i.test( id ) ) {
			return 3;
		}
		if ( /SmolLM2.*Instruct/i.test( id ) ) {
			return 2;
		}
		if ( /TinyLlama.*Chat/i.test( id ) ) {
			return 1;
		}
		return 0;
	};

	// f16/BF16 variants cannot load without the shader-f16 WebGPU extension.
	const unsupported = ( id ) =>
		! hasShaderF16 && /f16|BF16/i.test( id || '' );

	const candidates = list
		.map( ( m ) => ( {
			id: m.model_id || m.id,
			vram:
				typeof m.vram_required_MB === 'number'
					? m.vram_required_MB
					: 99999,
		} ) )
		.filter(
			( m ) =>
				m.id &&
				! /embed|reranker/i.test( m.id ) &&
				/instruct|chat/i.test( m.id ) &&
				! unsupported( m.id ) &&
				m.vram <= budgetMB
		);

	if ( candidates.length === 0 ) {
		// Nothing fits the budget — fall back to absolute smallest
		// supported instruct model (still honours the f16 filter).
		const anyInstruct = list
			.map( ( m ) => ( {
				id: m.model_id || m.id,
				vram:
					typeof m.vram_required_MB === 'number'
						? m.vram_required_MB
						: 99999,
			} ) )
			.filter(
				( m ) =>
					m.id &&
					! /embed|reranker/i.test( m.id ) &&
					/instruct|chat/i.test( m.id ) &&
					! unsupported( m.id )
			)
			.sort( ( a, b ) => a.vram - b.vram );
		return anyInstruct[ 0 ]?.id || null;
	}

	// Prefer newer family, then larger model within the family (bigger = smarter).
	candidates.sort( ( a, b ) => {
		const r = familyRank( b.id ) - familyRank( a.id );
		if ( r !== 0 ) {
			return r;
		}
		return b.vram - a.vram;
	} );

	return candidates[ 0 ].id;
}

// ---------------------------------------------------------------------------
// Engine lifecycle
// ---------------------------------------------------------------------------

/**
 * Lazily create the MLCEngine singleton.
 *
 * @return {Promise<MLCEngine>} The shared engine instance.
 */
async function ensureEngine() {
	if ( engine ) {
		return engine;
	}
	// HuggingFace now redirects model shards to their xet CDN
	// (cas-bridge.xethub.hf.co). The browser Cache API's `cache.add()`
	// rejects redirected cross-origin responses with a NetworkError, so
	// WebLLM's default Cache-backed loader fails on every shard. Forcing
	// the IndexedDB-backed cache bypasses Cache.add entirely — weights
	// are fetched with plain fetch() and stored as blobs in IndexedDB.
	const appConfig = { ...prebuiltAppConfig, useIndexedDBCache: true };
	engine = new MLCEngine( {
		appConfig,
		initProgressCallback: ( report ) => {
			setState( 'loading', { progress: report } );
		},
	} );
	return engine;
}

/**
 * Load (or reload) a model by ID.
 *
 * Transitions: idle/ready/error → loading → ready (or error on failure).
 * Starts broker polling once the engine is ready.
 *
 * @param {string} modelId
 */
async function loadModel( modelId ) {
	try {
		setState( 'loading', { progress: null, error: null } );
		const e = await ensureEngine();
		await e.reload( modelId );
		currentModelId = modelId;
		setState( 'ready' );
		startBrokerPolling();
	} catch ( err ) {
		setState( 'error', { error: String( err?.message || err ) } );
		throw err;
	}
}

/**
 * Unload the current model and dispose the engine.
 *
 * Transitions: any → idle.
 */
async function unloadModel() {
	stopBrokerPolling();
	if ( engine ) {
		try {
			await engine.unload();
		} catch ( _ ) {}
		engine = null;
	}
	currentModelId = null;
	setState( 'idle', { progress: null, error: null } );
}

// ---------------------------------------------------------------------------
// Broker polling (replaces the dedicated tab's job consumer role)
// ---------------------------------------------------------------------------

/**
 * Start polling /wp-json/webllm/v1/jobs/next for pending inference jobs.
 *
 * Only one polling loop runs at a time. The loop exits when pollingActive is
 * set to false (via stopBrokerPolling) or when the engine leaves 'ready' state.
 *
 * The SharedWorker's fetch() calls include `credentials: 'same-origin'` so
 * WordPress session cookies are sent automatically. The REST nonce must be
 * passed separately via the 'setNonce' RPC (the worker has no DOM access).
 */
function startBrokerPolling() {
	if ( pollingActive ) {
		return;
	}
	pollingActive = true;

	( async () => {
		while ( pollingActive && state === 'ready' ) {
			try {
				const headers = { 'Content-Type': 'application/json' };
				if ( restNonce ) {
					headers[ 'X-WP-Nonce' ] = restNonce;
				}
				// eslint-disable-next-line no-undef
				const res = await fetch( '/wp-json/webllm/v1/jobs/next', {
					method: 'GET',
					headers,
					credentials: 'same-origin',
				} );

				if ( res.status === 204 ) {
					// No pending job — tight loop is fine; server long-polls.
					continue;
				}

				if ( ! res.ok ) {
					// Server error — back off 2s before retrying.
					await new Promise( ( r ) => setTimeout( r, 2000 ) );
					continue;
				}

				const job = await res.json();
				await runJob( job );
			} catch ( err ) {
				// Network error or similar — back off 1s.
				await new Promise( ( r ) => setTimeout( r, 1000 ) );
			}
		}
		pollingActive = false;
	} )();
}

/**
 * Stop the broker polling loop.
 */
function stopBrokerPolling() {
	pollingActive = false;
}

/**
 * Start the idle-peek loop.
 *
 * When the engine is NOT in `ready`/`busy`, the broker-polling loop above
 * is dormant — which means a pending job enqueued by a REST client would
 * go unserved until the user manually starts the model. To close that
 * gap we poll `/webllm/v1/status` at a low frequency and, on detecting
 * `pending_jobs > 0`, broadcast a `needs-load` event to all connected
 * ports. The widget reacts by auto-starting (if `autoStart` is enabled
 * via localised config) or by opening the start modal.
 *
 * Only one peek loop runs at a time, and it exits as soon as the engine
 * transitions to `loading`/`ready`/`busy` — at which point `startBrokerPolling`
 * takes over the same HTTP connection budget.
 */
function startIdlePeeking() {
	if ( idlePeekActive ) {
		return;
	}
	idlePeekActive = true;

	( async () => {
		// 3-second interval is a reasonable balance: fast enough that a
		// user-initiated request doesn't time out the REST client (which
		// long-polls for ~180s by default), slow enough not to hammer the
		// DB on a sleeping install.
		const INTERVAL_MS = 3000;

		while ( idlePeekActive && state !== 'ready' && state !== 'busy' ) {
			try {
				// eslint-disable-next-line no-undef
				const res = await fetch( '/wp-json/webllm/v1/status', {
					method: 'GET',
					credentials: 'same-origin',
				} );
				if ( res.ok ) {
					const data = await res.json();
					const pending =
						typeof data.pending_jobs === 'number'
							? data.pending_jobs
							: 0;

					if ( pending > 0 && lastAnnouncedPendingJobs === 0 ) {
						// Rising-edge trigger: broadcast once per burst so
						// the widget isn't spammed with duplicate modals.
						broadcast( {
							type: 'needs-load',
							pendingJobs: pending,
							activeModel:
								typeof data.active_model === 'string'
									? data.active_model
									: '',
						} );
					}
					lastAnnouncedPendingJobs = pending;
				}
			} catch ( _ ) {
				// Network blip — no-op, try again next tick.
			}
			await new Promise( ( r ) => setTimeout( r, INTERVAL_MS ) );
		}
		idlePeekActive = false;
	} )();
}

/**
 * Stop the idle-peek loop. Safe to call when already stopped.
 */
function stopIdlePeeking() {
	idlePeekActive = false;
	lastAnnouncedPendingJobs = 0;
}

/**
 * Execute a single inference job and POST the result back to the broker.
 *
 * Transitions: ready → busy → ready (or error on failure).
 *
 * @param {Object} job Job descriptor from /jobs/next: { id, request }
 */
async function runJob( job ) {
	setState( 'busy' );
	try {
		const result = await engine.chat.completions.create( job.request );
		// eslint-disable-next-line no-undef
		await fetch( `/wp-json/webllm/v1/jobs/${ job.id }/result`, {
			method: 'POST',
			credentials: 'same-origin',
			headers: {
				'Content-Type': 'application/json',
				...( restNonce ? { 'X-WP-Nonce': restNonce } : {} ),
			},
			body: JSON.stringify( { result } ),
		} );
	} catch ( err ) {
		// Report job error back to broker so it can unblock the waiting client.
		try {
			// eslint-disable-next-line no-undef
			await fetch( `/wp-json/webllm/v1/jobs/${ job.id }/result`, {
				method: 'POST',
				credentials: 'same-origin',
				headers: {
					'Content-Type': 'application/json',
					...( restNonce ? { 'X-WP-Nonce': restNonce } : {} ),
				},
				body: JSON.stringify( {
					error: String( err?.message || err ),
				} ),
			} );
		} catch ( _ ) {}
	} finally {
		if ( state === 'busy' ) {
			setState( 'ready' );
		}
	}
}

// ---------------------------------------------------------------------------
// Port / RPC handling
// ---------------------------------------------------------------------------

/**
 * Dispatch an incoming RPC message from a connected port.
 *
 * Message schema: { type: string, id?: string|number, ...args }
 * Reply schema:   { id: msg.id, type: string, ...result }
 *
 * @param {MessagePort}  port
 * @param {MessageEvent} event
 */
async function handlePortMessage( port, event ) {
	const msg = event.data || {};

	/**
	 * Send a reply to the originating port, echoing the request id.
	 *
	 * @param {Object} data
	 */
	const reply = ( data ) => {
		try {
			port.postMessage( { id: msg.id, ...data } );
		} catch ( _ ) {
			ports.delete( port );
		}
	};

	switch ( msg.type ) {
		case 'handshake':
			// Client connects and identifies itself. Reply with version + state.
			reply( {
				type: 'handshake',
				version: VERSION,
				state: snapshot(),
				models: prebuiltAppConfig?.model_list || [],
			} );
			break;

		case 'getStatus':
			reply( { type: 'status', ...snapshot() } );
			break;

		case 'setNonce':
			// Widget (Phase 3) sends the WP REST nonce so broker polling works.
			restNonce = msg.nonce || null;
			reply( { type: 'ok' } );
			break;

		case 'loadModel': {
			// Load a specific model by ID, or auto-pick if none given.
			let modelId = msg.modelId || null;
			if ( ! modelId ) {
				const list = prebuiltAppConfig?.model_list || [];
				modelId = await autoPickModel( list );
			}
			if ( ! modelId ) {
				reply( { type: 'error', error: 'No model available to load' } );
				break;
			}
			try {
				await loadModel( modelId );
				reply( { type: 'ok', modelId: currentModelId } );
			} catch ( err ) {
				reply( {
					type: 'error',
					error: String( err?.message || err ),
				} );
			}
			break;
		}

		case 'unloadModel':
			await unloadModel();
			reply( { type: 'ok' } );
			break;

		case 'chat': {
			// Direct chat completion (bypasses broker; used by widget in Phase 3).
			if ( state !== 'ready' ) {
				reply( {
					type: 'error',
					error: `Engine not ready (state: ${ state })`,
				} );
				break;
			}
			setState( 'busy' );
			try {
				const result = await engine.chat.completions.create(
					msg.request
				);
				reply( { type: 'chatResult', result } );
			} catch ( err ) {
				reply( {
					type: 'error',
					error: String( err?.message || err ),
				} );
			} finally {
				if ( state === 'busy' ) {
					setState( 'ready' );
				}
			}
			break;
		}

		default:
			reply( {
				type: 'error',
				error: `Unknown message type: ${ msg.type }`,
			} );
	}
}

/**
 * Remove a disconnected port from the active set.
 *
 * SharedWorker ports don't fire a 'close' event reliably across browsers.
 * We detect dead ports lazily in broadcast() when postMessage throws.
 * This handler covers the cases where the browser does fire it.
 *
 * @param {MessagePort} port
 */
function handlePortClose( port ) {
	ports.delete( port );
}

// ---------------------------------------------------------------------------
// SharedWorker entrypoint
// ---------------------------------------------------------------------------

/* global self */
self.addEventListener( 'connect', ( event ) => {
	const port = event.ports[ 0 ];
	if ( ! port ) {
		return;
	}

	ports.add( port );

	port.onmessage = ( ev ) => handlePortMessage( port, ev );
	port.onmessageerror = () => handlePortClose( port );

	// Send initial state snapshot to the newly-connected port so it can
	// render the current engine state without waiting for the next broadcast.
	port.postMessage( { type: 'hello', ...snapshot() } );

	// port.start() is required when using addEventListener instead of onmessage.
	// Calling it when onmessage is already set is a no-op, so this is safe.
	port.start();

	// Kick off idle peeking on first connect so we start watching for
	// incoming jobs immediately. setState() keeps it in sync from here on.
	if ( state !== 'ready' && state !== 'busy' && state !== 'loading' ) {
		startIdlePeeking();
	}
} );
