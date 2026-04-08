/**
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
 *
 * WebLLM admin-bar widget.
 *
 * Replaces the original floating corner badge (t007) with an admin-bar
 * status indicator (t013) plus a centred start modal. Also hooks the
 * SharedWorker's `needs-load` broadcast so an incoming inference job
 * wakes the engine automatically — either silently when `autoStart` is
 * enabled or by popping the start modal.
 *
 * Responsibilities:
 *   - Drive the pre-rendered admin-bar node (`#wp-admin-bar-webllm-status`)
 *     imperatively, since WordPress owns its DOM. Dot colour and label
 *     reflect live SharedWorker state.
 *   - Mount the React start modal into a detached root under <body>. The
 *     modal is only visible when `modalOpen` is true.
 *   - Expose the stable `window.webllmWidget` API consumed by the apiFetch
 *     middleware (t010) and any future consumers.
 *
 * Public API surface:
 *   window.webllmWidget = {
 *     getStatus()    : Promise<StateSnapshot>,
 *     promptAndLoad(): Promise<void>,   // shows modal if not ready
 *     loadModel(id)  : Promise<void>,
 *     unloadModel()  : Promise<void>,
 *     subscribe(fn)  : () => void,      // returns unsubscribe
 *   }
 *
 * Built with @wordpress/scripts → build/floating-widget.js. Babel pragma is
 * `createElement` (see webpack.config.js), and the codebase convention is to
 * alias it as `h(...)` and avoid JSX syntax — see src/worker.jsx.
 *
 * @package UltimateAiConnectorWebLlm
 */

import { FLOATING_WIDGET_CSS } from './floating-widget-styles';

const {
	createElement: h,
	Fragment,
	useState,
	useEffect,
	useRef,
	useCallback,
	render,
} = wp.element;
const { __ } = wp.i18n;

// ---------------------------------------------------------------------------
// Config blob (provided by t008 via wp_localize_script). Defaults are used
// when the widget is mounted standalone (e.g. the gitignored test harness).
// ---------------------------------------------------------------------------

const CFG = window.webllmConnector || {};
const SHARED_WORKER_URL =
	CFG.sharedWorkerUrl ||
	'/wp-content/plugins/ultimate-ai-connector-webllm/build/shared-worker.js';
const REST_NONCE = CFG.restNonce || '';
const KNOWN_MODEL_IDS = Array.isArray( CFG.knownModelIds )
	? CFG.knownModelIds
	: [];

// ---------------------------------------------------------------------------
// SharedWorker client — wraps the MessagePort RPC defined in t006.
// ---------------------------------------------------------------------------

/**
 * Open a SharedWorker connection and return a small RPC client.
 *
 * The SharedWorker (src/shared-worker.js) replies to requests by echoing the
 * request `id` field. Unsolicited messages with `type === 'state'` or
 * `type === 'hello'` are state broadcasts and get fanned out to subscribers.
 *
 * @return {Object} client — { handshake, getStatus, setNonce, loadModel, unloadModel, chat, subscribe, close }.
 */
function createSharedWorkerClient() {
	let worker;
	try {
		worker = new SharedWorker( SHARED_WORKER_URL, {
			type: 'module',
			name: 'ultimate-ai-connector-webllm',
		} );
	} catch ( err ) {
		// SharedWorker not supported (Safari, some mobile browsers). The
		// dedicated-tab fallback is t011 — for now, surface the error so the
		// caller can render a degraded state.
		const stub = {
			handshake: () =>
				Promise.reject(
					new Error( 'SharedWorker not supported in this browser' )
				),
			getStatus: () =>
				Promise.resolve( {
					type: 'state',
					state: 'error',
					error: 'SharedWorker not supported',
				} ),
			setNonce: () => Promise.resolve(),
			loadModel: () =>
				Promise.reject(
					new Error( 'SharedWorker not supported in this browser' )
				),
			unloadModel: () => Promise.resolve(),
			chat: () =>
				Promise.reject(
					new Error( 'SharedWorker not supported in this browser' )
				),
			subscribe: ( fn ) => {
				// Immediately broadcast an error state so subscribers render.
				queueMicrotask( () =>
					fn( {
						type: 'state',
						state: 'error',
						error: 'SharedWorker not supported',
					} )
				);
				return () => undefined;
			},
			close: () => undefined,
		};
		// eslint-disable-next-line no-console
		console.warn( '[webllm-widget] SharedWorker unavailable:', err );
		return stub;
	}

	const port = worker.port;
	port.start();

	const listeners = new Set();
	const pending = new Map(); // id -> { resolve, reject }
	let nextId = 1;

	port.onmessage = ( event ) => {
		const msg = event.data || {};
		// Resolve pending RPC calls keyed by `id`.
		if ( msg.id && pending.has( msg.id ) ) {
			const { resolve, reject } = pending.get( msg.id );
			pending.delete( msg.id );
			if ( msg.type === 'error' ) {
				reject( new Error( msg.error || 'Unknown SharedWorker error' ) );
			} else {
				resolve( msg );
			}
		}
		// Fan out state broadcasts (these have no id, or id we don't track).
		if ( msg.type === 'state' || msg.type === 'hello' ) {
			for ( const fn of listeners ) {
				try {
					fn( msg );
				} catch ( _ ) {
					// Ignore subscriber errors so one bad listener doesn't
					// take down the others.
				}
			}
		}
	};

	function call( type, payload = {} ) {
		const id = nextId++;
		return new Promise( ( resolve, reject ) => {
			pending.set( id, { resolve, reject } );
			try {
				port.postMessage( { id, type, ...payload } );
			} catch ( err ) {
				pending.delete( id );
				reject( err );
			}
		} );
	}

	return {
		handshake: () => call( 'handshake' ),
		getStatus: () => call( 'getStatus' ),
		setNonce: ( nonce ) => call( 'setNonce', { nonce } ),
		loadModel: ( modelId ) => call( 'loadModel', { modelId } ),
		unloadModel: () => call( 'unloadModel' ),
		chat: ( request ) => call( 'chat', { request } ),
		subscribe: ( fn ) => {
			listeners.add( fn );
			return () => listeners.delete( fn );
		},
		close: () => {
			listeners.clear();
			pending.clear();
			try {
				port.close();
			} catch ( _ ) {
				// no-op
			}
		},
	};
}

// ---------------------------------------------------------------------------
// Hardware detection — picks a recommended model based on a rough VRAM guess.
// Mirrors the heuristic in src/shared-worker.js / src/worker.jsx so the user
// sees a consistent recommendation.
// ---------------------------------------------------------------------------

/**
 * Detect WebGPU adapter info and pick a recommended model id.
 *
 * @return {Promise<{modelId: string|null, gpuName: string, vramHintGb: number}>}
 */
async function detectHardware() {
	const result = { modelId: null, gpuName: 'Unknown', vramHintGb: 0 };
	if ( ! navigator.gpu ) {
		return result;
	}
	try {
		const adapter = await navigator.gpu.requestAdapter();
		if ( ! adapter ) {
			return result;
		}
		const info =
			typeof adapter.requestAdapterInfo === 'function'
				? await adapter.requestAdapterInfo()
				: adapter.info || {};
		result.gpuName =
			info.description || info.vendor || info.architecture || 'WebGPU device';
		// Heuristic: pick the first known model that mentions a small size
		// (q4f16_1 / q4f32) — full ranking lives in shared-worker.js.
		const ranked = KNOWN_MODEL_IDS.slice().sort( ( a, b ) => {
			const score = ( id ) => {
				if ( /-?1[bB]-/.test( id ) ) return 1;
				if ( /-?3[bB]-/.test( id ) ) return 2;
				if ( /-?7[bB]-/.test( id ) ) return 3;
				if ( /-?8[bB]-/.test( id ) ) return 4;
				return 5;
			};
			return score( a ) - score( b );
		} );
		result.modelId = ranked[ 0 ] || null;
		result.vramHintGb = 4; // best-effort placeholder; WebGPU doesn't expose VRAM
	} catch ( _ ) {
		// Swallow detection errors — the user can still pick manually.
	}
	return result;
}

// ---------------------------------------------------------------------------
// React state hook around the SharedWorker client.
// ---------------------------------------------------------------------------

/**
 * Open the SharedWorker on mount, kick off handshake, and track state.
 *
 * @return {{state: Object, client: Object|null}}
 */
function useSharedWorker() {
	const clientRef = useRef( null );
	const [ state, setState ] = useState( { state: 'connecting' } );

	useEffect( () => {
		const client = createSharedWorkerClient();
		clientRef.current = client;

		const unsub = client.subscribe( ( msg ) => {
			setState( ( prev ) => ( { ...prev, ...msg } ) );
		} );

		client
			.handshake()
			.then( ( reply ) => {
				if ( reply && reply.state ) {
					setState( ( prev ) => ( { ...prev, ...reply.state } ) );
				}
				if ( REST_NONCE ) {
					return client.setNonce( REST_NONCE );
				}
				return undefined;
			} )
			.catch( ( err ) => {
				setState( {
					type: 'state',
					state: 'error',
					error: String( err && err.message ? err.message : err ),
				} );
			} );

		return () => {
			unsub();
			client.close();
			clientRef.current = null;
		};
	}, [] );

	return { state, client: clientRef.current };
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

/**
 * Human-readable label for each SharedWorker state.
 *
 * @param {string} s
 * @return {string}
 */
function stateLabel( s ) {
	switch ( s ) {
		case 'connecting':
			return __( 'Connecting', 'ultimate-ai-connector-webllm' );
		case 'idle':
			return __( 'WebLLM: idle', 'ultimate-ai-connector-webllm' );
		case 'loading':
			return __( 'WebLLM: loading', 'ultimate-ai-connector-webllm' );
		case 'ready':
			return __( 'WebLLM: ready', 'ultimate-ai-connector-webllm' );
		case 'busy':
			return __( 'WebLLM: busy', 'ultimate-ai-connector-webllm' );
		case 'error':
			return __( 'WebLLM: error', 'ultimate-ai-connector-webllm' );
		default:
			return `WebLLM: ${ s }`;
	}
}

/**
 * Imperatively drive the pre-rendered admin-bar status node.
 *
 * WordPress renders `#wp-admin-bar-webllm-status` on the server (see
 * inc/widget-injector.php → register_admin_bar_node). We attach click
 * handlers to the submenu items and update the dot's `data-state`
 * attribute + the label on every state change. Using imperative DOM
 * updates (instead of a React portal) keeps us out of WordPress's
 * admin-bar markup.
 *
 * @param {Object} options
 * @param {Object} options.state        Current SharedWorker state snapshot.
 * @param {string} options.progressText Optional progress summary for loading state.
 * @param {Function} options.onStart
 * @param {Function} options.onStop
 * @param {Function} options.onRoot     Click handler for the top-level node.
 */
function updateAdminBar( { state, progressText, onStart, onStop, onRoot } ) {
	const root = document.getElementById( 'wp-admin-bar-webllm-status' );
	if ( ! root ) {
		return;
	}

	const dot = root.querySelector( '.webllm-admin-bar-dot' );
	const label = root.querySelector( '.webllm-admin-bar-label' );
	const s = ( state && state.state ) || 'connecting';

	if ( dot ) {
		dot.setAttribute( 'data-state', s );
	}
	if ( label ) {
		let text = stateLabel( s );
		if ( s === 'loading' && progressText ) {
			text = progressText.slice( 0, 40 );
		} else if ( s === 'ready' && state?.currentModelId ) {
			text = __( 'WebLLM ▸ ', 'ultimate-ai-connector-webllm' ) +
				state.currentModelId.replace( /-MLC.*$/, '' ).slice( 0, 32 );
		}
		label.textContent = text;
	}

	// Bind click handlers once (idempotent via data-bound flag).
	const topLink = root.querySelector( '.ab-item' );
	if ( topLink && ! topLink.dataset.webllmBound ) {
		topLink.dataset.webllmBound = '1';
		topLink.addEventListener( 'click', ( e ) => {
			e.preventDefault();
			onRoot();
		} );
	}

	const startLink = document.querySelector(
		'#wp-admin-bar-webllm-status-start .ab-item'
	);
	if ( startLink && ! startLink.dataset.webllmBound ) {
		startLink.dataset.webllmBound = '1';
		startLink.addEventListener( 'click', ( e ) => {
			e.preventDefault();
			onStart();
		} );
	}

	const stopLink = document.querySelector(
		'#wp-admin-bar-webllm-status-stop .ab-item'
	);
	if ( stopLink && ! stopLink.dataset.webllmBound ) {
		stopLink.dataset.webllmBound = '1';
		stopLink.addEventListener( 'click', ( e ) => {
			e.preventDefault();
			onStop();
		} );
	}
}

/**
 * Modal shown when promptAndLoad() is invoked or the user clicks the icon.
 *
 * Keyboard rules:
 *   - Esc closes (cancels)
 *   - Tab cycles inside the modal
 *   - Enter triggers Start when the primary button has focus
 *
 * @param {Object} props
 */
function StartModal( {
	state,
	hardware,
	progress,
	error,
	onStart,
	onCancel,
	canStart,
} ) {
	const startBtnRef = useRef( null );
	const backdropRef = useRef( null );

	useEffect( () => {
		if ( startBtnRef.current ) {
			startBtnRef.current.focus();
		}
	}, [] );

	const onKeyDown = useCallback(
		( e ) => {
			if ( e.key === 'Escape' ) {
				e.preventDefault();
				onCancel();
				return;
			}
			if ( e.key !== 'Tab' ) return;
			// Minimal focus trap: keep focus inside the modal.
			const root = backdropRef.current;
			if ( ! root ) return;
			const focusable = root.querySelectorAll(
				'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
			);
			if ( ! focusable.length ) return;
			const first = focusable[ 0 ];
			const last = focusable[ focusable.length - 1 ];
			if ( e.shiftKey && document.activeElement === first ) {
				e.preventDefault();
				last.focus();
			} else if ( ! e.shiftKey && document.activeElement === last ) {
				e.preventDefault();
				first.focus();
			}
		},
		[ onCancel ]
	);

	const stateLabel = state?.state || 'idle';
	const progressPct =
		progress && typeof progress.progress === 'number'
			? Math.round( progress.progress * 100 )
			: 0;
	const progressText =
		progress && progress.text ? progress.text : '';

	return h(
		'div',
		{
			ref: backdropRef,
			className: 'webllm-widget-modal-backdrop',
			onClick: ( e ) => {
				if ( e.target === backdropRef.current ) onCancel();
			},
			onKeyDown,
		},
		h(
			'div',
			{
				className: 'webllm-widget-modal',
				role: 'dialog',
				'aria-modal': 'true',
				'aria-labelledby': 'webllm-widget-modal-title',
			},
			h(
				'h2',
				{ id: 'webllm-widget-modal-title' },
				__( 'Start the in-browser AI', 'ultimate-ai-connector-webllm' )
			),
			h(
				'div',
				{ className: 'webllm-widget-modal-meta' },
				__( 'GPU: ', 'ultimate-ai-connector-webllm' ),
				h( 'strong', null, hardware.gpuName )
			),
			h(
				'div',
				{ className: 'webllm-widget-modal-meta' },
				__( 'Recommended model: ', 'ultimate-ai-connector-webllm' ),
				h(
					'strong',
					null,
					hardware.modelId ||
						__(
							'auto-pick on start',
							'ultimate-ai-connector-webllm'
						)
				)
			),
			h(
				'div',
				{ className: 'webllm-widget-modal-meta', 'aria-live': 'polite' },
				__( 'State: ', 'ultimate-ai-connector-webllm' ),
				h( 'strong', null, stateLabel )
			),
			( stateLabel === 'loading' || progressPct > 0 ) &&
				h(
					Fragment,
					null,
					h(
						'div',
						{
							className: 'webllm-widget-progress',
							role: 'progressbar',
							'aria-valuemin': 0,
							'aria-valuemax': 100,
							'aria-valuenow': progressPct,
						},
						h( 'div', {
							className: 'webllm-widget-progress-bar',
							style: { width: `${ progressPct }%` },
						} )
					),
					progressText &&
						h(
							'div',
							{ className: 'webllm-widget-progress-text' },
							progressText
						)
				),
			error &&
				h(
					'div',
					{ className: 'webllm-widget-error', role: 'alert' },
					error
				),
			h(
				'div',
				{ className: 'webllm-widget-modal-actions' },
				h(
					'button',
					{
						type: 'button',
						className:
							'webllm-widget-button webllm-widget-button-secondary',
						onClick: onCancel,
					},
					__( 'Cancel', 'ultimate-ai-connector-webllm' )
				),
				h(
					'button',
					{
						type: 'button',
						ref: startBtnRef,
						className:
							'webllm-widget-button webllm-widget-button-primary',
						onClick: onStart,
						disabled: ! canStart,
					},
					stateLabel === 'ready'
						? __( 'OK', 'ultimate-ai-connector-webllm' )
						: __( 'Start', 'ultimate-ai-connector-webllm' )
				)
			)
		)
	);
}

/**
 * Top-level widget. Owns the SharedWorker connection and the public window
 * API. Drives the admin-bar node imperatively and renders the modal via
 * React. Resolves/rejects the pending promptAndLoad() promise based on
 * state transitions, and auto-starts in response to `needs-load` broadcasts
 * when `webllmConnector.autoStart` is enabled.
 */
function WidgetRoot() {
	const { state, client } = useSharedWorker();
	const [ modalOpen, setModalOpen ] = useState( false );
	const [ hardware, setHardware ] = useState( {
		modelId: null,
		gpuName: 'Detecting…',
		vramHintGb: 0,
	} );
	const pendingPromiseRef = useRef( null );
	const autoStartAttemptedRef = useRef( false );

	// Detect hardware once on mount.
	useEffect( () => {
		let cancelled = false;
		detectHardware().then( ( hw ) => {
			if ( ! cancelled ) setHardware( hw );
		} );
		return () => {
			cancelled = true;
		};
	}, [] );

	// Resolve / reject any in-flight promptAndLoad() promise based on state.
	useEffect( () => {
		const p = pendingPromiseRef.current;
		if ( ! p ) return;
		if ( state?.state === 'ready' ) {
			p.resolve();
			pendingPromiseRef.current = null;
			setModalOpen( false );
		} else if ( state?.state === 'error' ) {
			p.reject(
				new Error( state.error || 'Model load failed' )
			);
			pendingPromiseRef.current = null;
		}
	}, [ state?.state, state?.error ] );

	// Wire up window.webllmWidget. Re-bind whenever the client or current
	// state changes — closures over `state` need to see the latest value.
	useEffect( () => {
		if ( ! client ) return;

		window.webllmWidget = {
			getStatus: () => client.getStatus(),
			promptAndLoad: () => {
				if ( state?.state === 'ready' ) return Promise.resolve();
				return new Promise( ( resolve, reject ) => {
					// If a previous promise is still pending, reject it so we
					// never end up with multiple resolvers racing on state.
					if ( pendingPromiseRef.current ) {
						pendingPromiseRef.current.reject(
							new Error( 'Superseded by new promptAndLoad call' )
						);
					}
					pendingPromiseRef.current = { resolve, reject };
					setModalOpen( true );
				} );
			},
			loadModel: ( id ) => client.loadModel( id ),
			unloadModel: () => client.unloadModel(),
			subscribe: ( fn ) => client.subscribe( fn ),
		};

		return () => {
			if ( window.webllmWidget ) {
				delete window.webllmWidget;
			}
		};
	}, [ client, state?.state ] );

	// Handle `needs-load` broadcasts from the SharedWorker idle-peek loop.
	// The shared-worker sends these as a separate message type (not a
	// state snapshot) so the React state machine above stays simple. We
	// auto-start the engine when config opts in, or pop the modal otherwise.
	useEffect( () => {
		if ( ! client ) return;
		const unsub = client.subscribe( ( msg ) => {
			if ( msg?.type !== 'needs-load' ) return;
			// Debounce: only act once per idle cycle to avoid double-modal.
			if ( autoStartAttemptedRef.current ) return;
			if ( state?.state === 'ready' || state?.state === 'loading' ) return;
			autoStartAttemptedRef.current = true;
			if ( CFG.autoStart ) {
				// Silent path — kick off the load directly. The modal stays
				// closed; users see progress via the admin-bar dot + label.
				client.loadModel( null ).catch( () => undefined );
			} else {
				// Prompt path — same as promptAndLoad() but without an
				// awaited Promise (the triggering request is already
				// waiting server-side).
				setModalOpen( true );
			}
		} );
		return unsub;
	}, [ client, state?.state ] );

	// Reset the auto-start latch whenever the engine transitions out of a
	// loaded state, so the next idle-cycle prompt will fire again.
	useEffect( () => {
		if ( state?.state === 'idle' || state?.state === 'error' ) {
			autoStartAttemptedRef.current = false;
		}
	}, [ state?.state ] );

	const handleStart = useCallback( async () => {
		if ( ! client ) return;
		if ( state?.state === 'ready' ) {
			if ( pendingPromiseRef.current ) {
				pendingPromiseRef.current.resolve();
				pendingPromiseRef.current = null;
			}
			setModalOpen( false );
			return;
		}
		try {
			await client.loadModel( hardware.modelId || null );
		} catch ( _ ) {
			// State broadcast already updated UI.
		}
	}, [ client, state?.state, hardware.modelId ] );

	const handleCancel = useCallback( () => {
		if ( pendingPromiseRef.current ) {
			pendingPromiseRef.current.reject(
				new Error( 'User cancelled' )
			);
			pendingPromiseRef.current = null;
		}
		setModalOpen( false );
	}, [] );

	const handleStop = useCallback( () => {
		if ( client ) {
			client.unloadModel().catch( () => undefined );
		}
	}, [ client ] );

	const handleRootClick = useCallback( () => {
		// Clicking the admin-bar root toggles the modal so the user can
		// see progress, errors, and manually Start/Stop.
		setModalOpen( ( open ) => ! open );
	}, [] );

	const handleAdminBarStart = useCallback( () => {
		setModalOpen( true );
		handleStart();
	}, [ handleStart ] );

	// Keep the admin-bar DOM in sync with state on every render.
	useEffect( () => {
		updateAdminBar( {
			state,
			progressText: state?.progress?.text || '',
			onStart: handleAdminBarStart,
			onStop: handleStop,
			onRoot: handleRootClick,
		} );
	} );

	const canStart =
		!! client &&
		state?.state !== 'connecting' &&
		state?.state !== 'loading';

	return modalOpen
		? h( StartModal, {
				state,
				hardware,
				progress: state?.progress,
				error: state?.error,
				onStart: handleStart,
				onCancel: handleCancel,
				canStart,
		  } )
		: null;
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

function injectStyles() {
	if ( document.getElementById( 'webllm-widget-styles' ) ) return;
	const style = document.createElement( 'style' );
	style.id = 'webllm-widget-styles';
	style.textContent = FLOATING_WIDGET_CSS;
	( document.head || document.documentElement ).appendChild( style );
}

( function mount() {
	if ( document.getElementById( 'webllm-widget-root' ) ) {
		// Already mounted (e.g. dev hot reload). Bail to avoid duplicates.
		return;
	}
	const root = document.createElement( 'div' );
	root.id = 'webllm-widget-root';
	const attach = () => {
		injectStyles();
		document.body.appendChild( root );
		render( h( WidgetRoot ), root );
	};
	if ( document.body ) {
		attach();
	} else {
		document.addEventListener( 'DOMContentLoaded', attach, { once: true } );
	}
} )();
