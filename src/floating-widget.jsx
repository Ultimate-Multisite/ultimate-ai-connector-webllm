/**
 * SPDX-License-Identifier: MIT
 * SPDX-FileCopyrightText: 2025-2026 Marcus Quinn
 *
 * Floating widget — phase 3 of p001.
 *
 * Mounts a small floating icon + start modal in every wp-admin page that
 * loads this script. Connects to the SharedWorker built in t006 and exposes
 * a public JS API on `window.webllmWidget` for the apiFetch middleware
 * (t010) and other consumers to call.
 *
 * Public API surface (consumed by t010):
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
 * Corner badge that summarises the SharedWorker state.
 *
 * Click → toggle the modal. A separate Stop button appears when busy/ready.
 *
 * @param {Object}   props
 * @param {Object}   props.state
 * @param {Function} props.onClick
 * @param {Function} props.onStop
 */
function FloatingIcon( { state, onClick, onStop } ) {
	const s = ( state && state.state ) || 'connecting';
	const showStop = s === 'ready' || s === 'busy' || s === 'loading';
	const label = ( () => {
		switch ( s ) {
			case 'connecting':
				return __( 'Init', 'ultimate-ai-connector-webllm' );
			case 'idle':
				return __( 'Idle', 'ultimate-ai-connector-webllm' );
			case 'loading':
				return __( 'Load', 'ultimate-ai-connector-webllm' );
			case 'ready':
				return __( 'Ready', 'ultimate-ai-connector-webllm' );
			case 'busy':
				return __( 'Busy', 'ultimate-ai-connector-webllm' );
			case 'error':
				return __( 'Err', 'ultimate-ai-connector-webllm' );
			default:
				return s;
		}
	} )();

	return h(
		Fragment,
		null,
		showStop &&
			h(
				'button',
				{
					type: 'button',
					className: 'webllm-widget-icon-stop',
					onClick: ( e ) => {
						e.stopPropagation();
						onStop();
					},
					'aria-label': __(
						'Unload AI model',
						'ultimate-ai-connector-webllm'
					),
				},
				__( 'Stop', 'ultimate-ai-connector-webllm' )
			),
		h(
			'div',
			{
				className: 'webllm-widget-icon',
				'data-state': s,
				role: 'button',
				tabIndex: 0,
				'aria-label': __(
					'WebLLM widget',
					'ultimate-ai-connector-webllm'
				),
				onClick,
				onKeyDown: ( e ) => {
					if ( e.key === 'Enter' || e.key === ' ' ) {
						e.preventDefault();
						onClick();
					}
				},
			},
			h(
				'span',
				{ className: 'webllm-widget-icon-label', 'aria-live': 'polite' },
				label
			)
		)
	);
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
 * API. Resolves/rejects the pending promptAndLoad() promise based on state
 * transitions.
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

	const handleStart = useCallback( async () => {
		if ( ! client ) return;
		// If we're already ready, the modal's primary button is "OK" — just
		// resolve and close.
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
			// State broadcast handles transition to 'ready' which resolves
			// the pending promise via the effect above.
		} catch ( _ ) {
			// State broadcast already updated UI; nothing else to do here.
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

	const handleIconClick = useCallback( () => {
		setModalOpen( ( open ) => ! open );
	}, [] );

	const canStart =
		!! client &&
		state?.state !== 'connecting' &&
		state?.state !== 'loading';

	return h(
		Fragment,
		null,
		h( FloatingIcon, {
			state,
			onClick: handleIconClick,
			onStop: handleStop,
		} ),
		modalOpen &&
			h( StartModal, {
				state,
				hardware,
				progress: state?.progress,
				error: state?.error,
				onStart: handleStart,
				onCancel: handleCancel,
				canStart,
			} )
	);
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
