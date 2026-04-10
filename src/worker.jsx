/**
 * WebLLM Worker — runs in a persistent admin tab.
 *
 * Loads MLCEngine from @mlc-ai/web-llm, registers itself with the WP REST
 * broker, then long-polls /jobs/next, runs each chat completion locally on
 * WebGPU, and posts the result back. Other devices on the same WP install
 * make requests against the broker, which routes them through this tab.
 *
 * `@mlc-ai/web-llm` is loaded via dynamic import so the ~5 MB MLCEngine
 * bundle is split into its own chunk and only fetched when the user opens
 * this page — the page-shell `worker.js` becomes a few KB instead of
 * blocking the entire wp-admin until the LLM library finishes downloading.
 *
 * Built with @wordpress/scripts → build/worker.js, enqueued by inc/admin.php.
 *
 * @package UltimateAiConnectorWebLlm
 */

import { diagnoseWebGpu, diagnoseWebLlmError, hasIssues } from './webgpu-troubleshooter';

// Lazy module handle, populated by ensureWebLlmLoaded() on first use.
let webllm = null;
async function ensureWebLlmLoaded() {
	if ( ! webllm ) {
		webllm = await import( /* webpackChunkName: "mlc-ai-web-llm" */ '@mlc-ai/web-llm' );
	}
	return webllm;
}

const { createElement: h, useState, useEffect, useRef, useCallback, render } = wp.element;
const { Button, SelectControl, Spinner, Notice, Card, CardBody, __experimentalVStack: VStack, __experimentalHStack: HStack, ProgressBar } = wp.components;
const { __ } = wp.i18n;

const CFG = window.WEBLLM_WORKER || { restRoot: '/wp-json/webllm/v1', nonce: '', requestTimeout: 180, defaultModel: '', contextWindow: 8192 };
const LS_LAST_MODEL = 'webllm_last_model';

function api( path, opts = {} ) {
	const url = CFG.restRoot.replace( /\/$/, '' ) + path;
	return fetch( url, {
		credentials: 'same-origin',
		headers: {
			'Content-Type': 'application/json',
			'X-WP-Nonce': CFG.nonce,
			...( opts.headers || {} ),
		},
		...opts,
	} );
}

/**
 * Resolve the default model id using a three-tier priority:
 *
 *   1. WP site setting (`webllm_default_model`)  — admin's explicit choice.
 *   2. localStorage last successful model         — user's previous session.
 *   3. Heuristic auto-pick based on VRAM budget   — first-run fallback.
 *
 * The heuristic probes the WebGPU adapter to estimate a budget and picks the
 * largest *instruct-tuned* chat model that fits, preferring newer families.
 */
async function resolveDefaultModel( list ) {
	if ( ! Array.isArray( list ) || list.length === 0 ) {
		return '';
	}

	const exists = ( id ) => !! list.find( ( m ) => ( m.model_id || m.id ) === id );

	// 1. WP site setting.
	if ( CFG.defaultModel && exists( CFG.defaultModel ) ) {
		return CFG.defaultModel;
	}

	// 2. localStorage last successful.
	try {
		const last = window.localStorage.getItem( LS_LAST_MODEL );
		if ( last && exists( last ) ) {
			return last;
		}
	} catch ( e ) {}

	// 3. Heuristic.
	return autoPickModel( list );
}

async function autoPickModel( list ) {
	// Estimate a VRAM budget from the WebGPU adapter. WebGPU doesn't expose
	// total VRAM; `adapter.limits.maxBufferSize` is a conservative proxy. On
	// integrated GPUs it's ~2 GB, on discrete 4–24 GB. Reserve 30% headroom
	// for KV cache and activations. Also probe `shader-f16` so we never
	// auto-pick a model the adapter cannot compile.
	let budgetMB = 1400;
	let hasShaderF16 = false;
	try {
		const adapter = await navigator.gpu?.requestAdapter();
		if ( adapter?.limits?.maxBufferSize ) {
			budgetMB = Math.floor( ( adapter.limits.maxBufferSize / 1024 / 1024 ) * 0.7 );
		}
		if ( adapter?.features && typeof adapter.features.has === 'function' ) {
			hasShaderF16 = adapter.features.has( 'shader-f16' );
		}
	} catch ( e ) {}

	const unsupported = ( id ) => ! hasShaderF16 && /f16|BF16/i.test( id || '' );

	const familyRank = ( id ) => {
		if ( /^Qwen3-/i.test( id ) )                  return 10;
		if ( /DeepSeek-R1/i.test( id ) )               return 9;
		if ( /Ministral.*(?:Instruct|Reasoning)/i.test( id ) ) return 8;
		if ( /Hermes-3/i.test( id ) )                  return 7;
		if ( /Llama-3\.2.*Instruct/i.test( id ) )      return 6;
		if ( /Llama-3\.1.*Instruct/i.test( id ) )      return 5;
		if ( /Qwen2\.5-(?!Coder|Math).*Instruct/i.test( id ) ) return 4;
		if ( /gemma-2-.*-it/i.test( id ) )             return 3;
		if ( /Phi-3.*instruct/i.test( id ) )           return 2;
		if ( /SmolLM2.*Instruct/i.test( id ) )         return 1;
		return 0;
	};

	// Chat-capable models use various naming conventions: "Instruct",
	// "Chat", "-it" (Gemma), "R1-Distill" (DeepSeek), "Hermes", "Qwen3"
	// (no suffix), "Ministral-*-Instruct", "Reasoning", "zephyr". Match
	// broadly and rely on the embed/reranker/base exclusion to filter
	// non-chat models.
	const isChatCapable = ( id ) =>
		/instruct|chat|-it-|R1-Distill|Hermes|^Qwen3-|Ministral.*(?:Instruct|Reasoning)|zephyr/i.test( id );

	const candidates = list
		.map( ( m ) => ( {
			id: m.model_id || m.id,
			vram: typeof m.vram_required_MB === 'number' ? m.vram_required_MB : 99999,
		} ) )
		.filter(
			( m ) =>
				m.id &&
				! /embed|reranker|Base-\d/i.test( m.id ) &&
				isChatCapable( m.id ) &&
				! unsupported( m.id ) &&
				m.vram <= budgetMB
		);

	if ( candidates.length === 0 ) {
		// Nothing fits the budget — fall back to absolute smallest
		// supported chat model.
		const anyChat = list
			.map( ( m ) => ( {
				id: m.model_id || m.id,
				vram: typeof m.vram_required_MB === 'number' ? m.vram_required_MB : 99999,
			} ) )
			.filter(
				( m ) =>
					m.id &&
					! /embed|reranker|Base-\d/i.test( m.id ) &&
					isChatCapable( m.id ) &&
					! unsupported( m.id )
			)
			.sort( ( a, b ) => a.vram - b.vram );
		return anyChat[ 0 ]?.id || '';
	}

	// Prefer newer family, then larger model within the family (bigger = smarter).
	candidates.sort( ( a, b ) => {
		const r = familyRank( b.id ) - familyRank( a.id );
		if ( r !== 0 ) return r;
		return b.vram - a.vram;
	} );

	return candidates[ 0 ].id;
}

function App() {
	const [ modelList, setModelList ] = useState( [] );
	const [ libLoading, setLibLoading ] = useState( true );
	const [ libError, setLibError ] = useState( null );
	const [ modelId, setModelId ] = useState( '' );
	const [ engine, setEngine ] = useState( null );

	// Kick off the dynamic import on mount. Until it resolves the user sees
	// "Loading WebLLM library…" instead of an empty screen.
	useEffect( () => {
		let cancelled = false;
		ensureWebLlmLoaded()
			.then( ( mod ) => {
				if ( cancelled ) return;
				const list = ( mod.prebuiltAppConfig && Array.isArray( mod.prebuiltAppConfig.model_list ) )
					? mod.prebuiltAppConfig.model_list
					: [];
				setModelList( list );
				setLibLoading( false );
			} )
			.catch( ( e ) => {
				if ( cancelled ) return;
				setLibError( ( e && e.message ) || String( e ) );
				setLibLoading( false );
			} );
		return () => { cancelled = true; };
	}, [] );
	const [ log, setLog ] = useState( [] );
	const pushLog = useCallback( ( line ) => {
		const ts = new Date().toLocaleTimeString();
		setLog( ( l ) => [ `[${ ts }] ${ line }`, ...l ].slice( 0, 40 ) );
		// eslint-disable-next-line no-console
		console.log( '[webllm-worker]', line );
	}, [] );

	// Resolve the default model once the catalog is available.
	useEffect( () => {
		if ( modelList.length === 0 ) return;
		let cancelled = false;
		resolveDefaultModel( modelList ).then( ( id ) => {
			if ( ! cancelled && id ) setModelId( id );
		} );
		return () => { cancelled = true; };
	}, [ modelList ] );
	const [ loadProgress, setLoadProgress ] = useState( null );
	const [ loadText, setLoadText ] = useState( '' );
	const [ status, setStatus ] = useState( 'idle' );
	const [ jobsServed, setJobsServed ] = useState( 0 );
	const [ adapterInfo, setAdapterInfo ] = useState( null );
	const [ hasShaderF16, setHasShaderF16 ] = useState( false );
	const [ error, setError ] = useState( null );
	const [ gpuDiag, setGpuDiag ] = useState( null );
	const stopRef = useRef( false );

	// Probe WebGPU adapter info + shader-f16 support on mount. f16 models
	// are hidden from the dropdown when the extension is missing — see
	// t011 notes: the load would otherwise fail with
	// "This model requires WebGPU extension shader-f16".
	// Also runs the full diagnostics to surface troubleshooting guidance
	// when problems are detected.
	useEffect( () => {
		( async () => {
			try {
				const diag = await diagnoseWebGpu();
				setGpuDiag( diag );
				setHasShaderF16( diag.hasShaderF16 );

				if ( ! diag.webgpuApiPresent ) {
					setError( __( 'This browser does not expose WebGPU.', 'ultimate-ai-connector-webllm' ) );
					return;
				}
				if ( ! diag.adapterAvailable ) {
					setError( __( 'WebGPU is available but no GPU adapter was found. Your GPU may be blocklisted — see the troubleshooting steps below.', 'ultimate-ai-connector-webllm' ) );
					return;
				}
				if ( diag.isSoftwareAdapter ) {
					setError( __( 'WebGPU is using software rendering instead of your GPU. Inference will be extremely slow — see the troubleshooting steps below.', 'ultimate-ai-connector-webllm' ) );
				}

				// Read adapter info for display.
				if ( navigator.gpu ) {
					const adapter = await navigator.gpu.requestAdapter();
					if ( adapter && adapter.info ) {
						setAdapterInfo( adapter.info );
					}
				}
			} catch ( e ) {
				// non-fatal
			}
		} )();
	}, [] );

	// Register model list with the broker once the catalog is available.
	useEffect( () => {
		if ( modelList.length === 0 ) return;
		api( '/register-worker', {
			method: 'POST',
			body: JSON.stringify( {
				active_model: '',
				models: modelList.map( ( m ) => ( {
					id: m.model_id || m.id,
					name: m.model_id || m.id,
					vram_required_MB: m.vram_required_MB,
				} ) ),
			} ),
		} ).catch( () => {} );
	}, [ modelList ] );

	// Unconditional 20s heartbeat. Sends the currently-loaded model id so the
	// broker's active_model transient always reflects real state — even while
	// /jobs/next is mid-long-poll or if a polling hiccup swallows a beat.
	useEffect( () => {
		const beat = () => {
			api( '/register-worker', {
				method: 'POST',
				body: JSON.stringify( {
					active_model: engine ? modelId : '',
				} ),
			} ).catch( () => {} );
		};
		beat();
		const t = setInterval( beat, 20000 );
		return () => clearInterval( t );
	}, [ engine, modelId ] );

	const loadModel = useCallback( async () => {
		setError( null );
		setStatus( 'loading' );
		setLoadProgress( 0 );
		setLoadText( __( 'Initializing…', 'ultimate-ai-connector-webllm' ) );
		try {
			const mod = await ensureWebLlmLoaded();

			// Override the model's baked-in context_window_size. MLC's
			// prebuilt configs cap most chat models at 4096 tokens to keep
			// KV cache memory low; we expose a setting so users with bigger
			// GPUs can fit longer system prompts (e.g. AI agent tool defs).
			// Each doubling of context roughly doubles VRAM for the KV cache.
			const appConfig = JSON.parse( JSON.stringify( mod.prebuiltAppConfig ) );
			const entry     = appConfig.model_list.find( ( m ) => ( m.model_id || m.id ) === modelId );
			// model_type: 0 = LLM (default), 1 = embedding, 2 = VLM.
			// Embedding models reject `context_window_size !== prefill_chunk_size`
			// ("Embedding currently does not support chunking"), so we must not
			// apply the LLM-oriented context override to them. We also heuristically
			// skip any model whose id contains 'embed' in case `model_type` is
			// missing from the prebuilt entry.
			const isEmbedding = entry && (
				entry.model_type === 1 ||
				/embed/i.test( entry.model_id || entry.id || '' )
			);
			if ( entry && ! isEmbedding ) {
				entry.overrides = {
					...( entry.overrides || {} ),
					context_window_size: CFG.contextWindow,
				};
				pushLog( `context_window_size override → ${ CFG.contextWindow }` );
			} else if ( isEmbedding ) {
				pushLog( `skipping context_window override (embedding model)` );
			}
			// Force IndexedDB cache: HuggingFace now redirects shards to the
			// xet CDN, and `Cache.add()` rejects redirected cross-origin
			// responses. IndexedDB-backed caching uses plain fetch() and
			// works with the redirect.
			appConfig.useIndexedDBCache = true;

			const eng = await mod.CreateMLCEngine( modelId, {
				appConfig,
				initProgressCallback: ( p ) => {
					setLoadProgress( typeof p.progress === 'number' ? Math.round( p.progress * 100 ) : null );
					setLoadText( p.text || '' );
				},
			} );
			setEngine( eng );
			setStatus( 'ready' );
			// Persist this model as the user's "last successful" choice so
			// next time we skip the heuristic entirely.
			try {
				window.localStorage.setItem( LS_LAST_MODEL, modelId );
			} catch ( e ) {}
		} catch ( e ) {
			setStatus( 'idle' );
			setError( ( e && e.message ) || String( e ) );
			// Check if the web-llm error has specific troubleshooting guidance.
			const errorDiag = diagnoseWebLlmError( e );
			if ( errorDiag ) {
				setGpuDiag( ( prev ) => ( {
					...( prev || {} ),
					issues: [ errorDiag, ...( prev?.issues || [] ).filter( ( i ) => i.id !== errorDiag.id ) ],
				} ) );
			}
		}
	}, [ modelId ] );

	const unloadModel = useCallback( async () => {
		stopRef.current = true;
		try {
			if ( engine && typeof engine.unload === 'function' ) {
				await engine.unload();
			}
		} catch ( e ) {}
		setEngine( null );
		setStatus( 'idle' );
		stopRef.current = false;
		// Immediately clear the broker's active-model so callers stop trying
		// to dispatch here. The 20s heartbeat would catch up anyway.
		api( '/register-worker', {
			method: 'POST',
			body: JSON.stringify( { active_model: '' } ),
		} ).catch( () => {} );
	}, [ engine ] );

	// Polling loop: only runs while engine is ready.
	useEffect( () => {
		if ( ! engine ) return;
		let cancelled = false;

		const loop = async () => {
			pushLog( 'polling loop started' );
			while ( ! cancelled && ! stopRef.current ) {
				try {
					const res = await api( '/jobs/next', { method: 'GET' } );
					if ( res.status === 204 ) {
						continue;
					}
					if ( ! res.ok ) {
						pushLog( `jobs/next returned HTTP ${ res.status }` );
						await new Promise( ( r ) => setTimeout( r, 1000 ) );
						continue;
					}
					const job = await res.json();
					if ( ! job || ! job.id ) {
						continue;
					}
					if ( job.type !== 'chat' ) {
						pushLog( `unknown job type: ${ job.type }` );
						await api( `/jobs/${ job.id }/result`, {
							method: 'POST',
							body: JSON.stringify( { error: 'unknown_job_type' } ),
						} );
						continue;
					}

					// Normalize the SDK payload to what WebLLM actually supports.
					// The AI SDK forwards OpenAI-compatible fields that WebLLM
					// doesn't all accept — strip the unsupported ones and force
					// the active model id. `stream: false` is required for the
					// non-streaming `completions.create` path.
					//
					// Critical: WebLLM non-VLM models reject content-parts
					// arrays (`[{type:"text", text:"..."}]`) — they only take
					// plain strings. The WP AI SDK always sends parts arrays,
					// so we flatten any text parts down to a single string and
					// drop everything else (images, etc.).
					const flattenContent = ( c ) => {
						if ( typeof c === 'string' ) return c;
						if ( Array.isArray( c ) ) {
							return c
								.map( ( p ) => {
									if ( typeof p === 'string' ) return p;
									if ( p && typeof p.text === 'string' ) return p.text;
									return '';
								} )
								.filter( Boolean )
								.join( '' );
						}
						if ( c && typeof c.text === 'string' ) return c.text;
						return '';
					};

					const raw     = job.payload || {};
					const payload = {
						model: modelId,
						messages: Array.isArray( raw.messages )
							? raw.messages.map( ( m ) => ( {
								role: m.role || 'user',
								content: flattenContent( m.content ),
							} ) )
							: [],
						stream: false,
					};
					if ( typeof raw.temperature === 'number' ) payload.temperature = raw.temperature;
					if ( typeof raw.top_p === 'number' )       payload.top_p = raw.top_p;
					if ( typeof raw.max_tokens === 'number' )  payload.max_tokens = raw.max_tokens;
					if ( typeof raw.frequency_penalty === 'number' ) payload.frequency_penalty = raw.frequency_penalty;
					if ( typeof raw.presence_penalty === 'number' )  payload.presence_penalty = raw.presence_penalty;
					if ( Array.isArray( raw.stop ) ) payload.stop = raw.stop;

					pushLog( `claimed job ${ job.id.slice( 0, 8 ) } (${ payload.messages.length } msgs)` );

					let result;
					const t0 = Date.now();
					try {
						const completion = await engine.chat.completions.create( payload );
						result = completion;
						pushLog( `inference ok in ${ Math.round( ( Date.now() - t0 ) / 1000 ) }s` );
					} catch ( e ) {
						const msg = ( e && ( e.message || e.toString() ) ) || 'unknown inference error';
						pushLog( `inference ERROR: ${ msg.slice( 0, 160 ) }` );
						result = { error: msg };
					}

					try {
						const postRes = await api( `/jobs/${ job.id }/result`, {
							method: 'POST',
							body: JSON.stringify( result ),
						} );
						if ( ! postRes.ok ) {
							pushLog( `result POST failed: HTTP ${ postRes.status }` );
						}
					} catch ( e ) {
						pushLog( `result POST threw: ${ ( e && e.message ) || e }` );
					}
					setJobsServed( ( n ) => n + 1 );
				} catch ( e ) {
					pushLog( `loop error: ${ ( e && e.message ) || e }` );
					await new Promise( ( r ) => setTimeout( r, 1000 ) );
				}
			}
			pushLog( 'polling loop stopped' );
		};
		loop();

		return () => {
			cancelled = true;
		};
	}, [ engine, modelId ] );

	// Hide f16/BF16 models when the WebGPU adapter does not expose the
	// shader-f16 extension — those loads would otherwise fail with
	// "This model requires WebGPU extension shader-f16".
	const visibleModels = modelList.filter( ( m ) => {
		const id = m.model_id || m.id || '';
		if ( hasShaderF16 ) return true;
		return ! /f16|BF16/i.test( id );
	} );

	const modelOptions = visibleModels.map( ( m ) => ( {
		label: ( m.model_id || m.id ) + ( m.vram_required_MB ? ` (~${ Math.round( m.vram_required_MB ) } MB)` : '' ),
		value: m.model_id || m.id,
	} ) );

	// Render a collapsible troubleshooting panel when issues are detected.
	const troubleshootingPanel = hasIssues( gpuDiag ) && h( 'details', {
		style: {
			marginTop: 4,
			padding: '10px 14px',
			background: '#fff8e1',
			borderLeft: '4px solid #f0b849',
			borderRadius: 2,
			fontSize: 13,
		},
		open: ! gpuDiag.adapterAvailable || ! gpuDiag.webgpuApiPresent,
	},
		h( 'summary', { style: { cursor: 'pointer', fontWeight: 600 } },
			__( 'Troubleshooting: WebGPU setup', 'ultimate-ai-connector-webllm' )
		),
		gpuDiag.issues.map( ( issue, idx ) =>
			h( 'div', { key: idx, style: { marginTop: 10 } },
				h( 'strong', { style: { color: issue.severity === 'error' ? '#cc1818' : '#996800' } }, issue.title ),
				h( 'p', { style: { margin: '4px 0' } }, issue.description ),
				issue.steps && h( 'ol', { style: { margin: '6px 0 0 0', paddingLeft: 20 } },
					issue.steps.map( ( step, si ) =>
						h( 'li', {
							key: si,
							style: {
								marginBottom: 4,
								...(
									step.type === 'chrome-flag'
										? { fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 12 }
										: {}
								),
							},
						}, step.text )
					)
				)
			)
		)
	);

	if ( libLoading ) {
		return h( Card, null,
			h( CardBody, null,
				h( HStack, { spacing: 3 },
					h( Spinner, null ),
					h( 'span', null, __( 'Loading WebLLM library… (≈5 MB, downloaded once)', 'ultimate-ai-connector-webllm' ) )
				)
			)
		);
	}

	if ( libError ) {
		return h( Card, null,
			h( CardBody, null,
				h( Notice, { status: 'error', isDismissible: false },
					__( 'Failed to load WebLLM library:', 'ultimate-ai-connector-webllm' ) + ' ' + libError
				)
			)
		);
	}

	return h( Card, null,
		h( CardBody, null,
			h( VStack, { spacing: 4 },
				adapterInfo && h( 'div', { style: { fontSize: 12, color: '#555' } },
					h( 'strong', null, __( 'WebGPU adapter:', 'ultimate-ai-connector-webllm' ) ),
					' ',
					[ adapterInfo.vendor, adapterInfo.architecture, adapterInfo.device, adapterInfo.description ].filter( Boolean ).join( ' · ' ) || __( '(unknown)', 'ultimate-ai-connector-webllm' )
				),

				h( SelectControl, {
					label: __( 'Model', 'ultimate-ai-connector-webllm' ),
					value: modelId,
					options: modelOptions,
					onChange: setModelId,
					disabled: status === 'loading' || status === 'ready',
					help: __( 'Pulled live from the installed @mlc-ai/web-llm prebuilt list. VRAM hints come from the package metadata.', 'ultimate-ai-connector-webllm' ),
					__nextHasNoMarginBottom: true,
					__next40pxDefaultSize: true,
				} ),

				status === 'loading' && h( 'div', null,
					h( 'p', null, loadText || __( 'Downloading model weights…', 'ultimate-ai-connector-webllm' ) ),
					typeof loadProgress === 'number' && ProgressBar
						? h( ProgressBar, { value: loadProgress } )
						: h( Spinner, null )
				),

			error && h( Notice, { status: 'error', isDismissible: false }, error ),

			troubleshootingPanel,

			h( HStack, { justify: 'flex-start', spacing: 3 },
					status !== 'ready' && h( Button, {
						variant: 'primary',
						onClick: loadModel,
						disabled: status === 'loading' || ! modelId,
						isBusy: status === 'loading',
						__next40pxDefaultSize: true,
					}, __( 'Load model & start serving', 'ultimate-ai-connector-webllm' ) ),
					status === 'ready' && h( Button, {
						variant: 'secondary',
						isDestructive: true,
						onClick: unloadModel,
						__next40pxDefaultSize: true,
					}, __( 'Stop & unload', 'ultimate-ai-connector-webllm' ) )
				),

				status === 'ready' && h( 'div', { style: { fontSize: 13 } },
					h( 'strong', { style: { color: '#0a7c2f' } }, __( '● Online', 'ultimate-ai-connector-webllm' ) ),
					' — ',
					( __( 'Jobs served: %d', 'ultimate-ai-connector-webllm' ) ).replace( '%d', String( jobsServed ) )
				),

				log.length > 0 && h( 'div', {
					style: {
						marginTop: 8,
						padding: 8,
						background: '#1e1e1e',
						color: '#d4d4d4',
						fontFamily: 'ui-monospace, Menlo, monospace',
						fontSize: 11,
						lineHeight: 1.5,
						maxHeight: 260,
						overflowY: 'auto',
						borderRadius: 4,
					},
				}, log.map( ( line, i ) => h( 'div', { key: i }, line ) ) )
			)
		)
	);
}

const mount = document.getElementById( 'webllm-worker-root' );
if ( mount ) {
	render( h( App ), mount );
}
