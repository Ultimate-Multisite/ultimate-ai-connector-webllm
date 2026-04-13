/**
 * apiFetch middleware — holds AI generation requests until the WebLLM
 * SharedWorker is ready, prompting the user via the floating widget.
 *
 * Strategy: Hybrid-narrow (locked in spike-shared-worker-apifetch.md).
 * The middleware classifies each request cheaply and lets everything
 * non-AI pass through untouched. For requests that are likely to route
 * to our provider, it consults `window.webllmWidget` (from t007), shows
 * the start modal if the model isn't loaded, and releases the request
 * once the user clicks Start. Cancel surfaces as a clean WP_Error-shaped
 * rejection instead of a server-side 503.
 *
 * IMPORTANT: must NEVER intercept our own `/wp-json/webllm/v1/*` broker
 * routes — doing so would create an infinite loop (widget → broker →
 * middleware → widget). The classifier is safe by construction because
 * it only matches `/wp-ai/v1/generate` and `/wp-abilities/v1/abilities/ai~1*!/run`.
 *
 * @package UltimateAiConnectorWebLlm
 */

// Use the global `wp.apiFetch` rather than importing `@wordpress/api-fetch`
// so this bundle stays tiny and doesn't duplicate the core module already
// loaded by WordPress on every admin page.
const apiFetch = window.wp && window.wp.apiFetch;

const config = window.webllmConnector || {};
const knownModelIds = new Set( config.knownModelIds || [] );
const abilityPrefixes = config.webllmAbilityPrefixes || [ 'ai/' ];
const providerId = config.providerId || 'ultimate-ai-connector-webllm';

/**
 * Classifies a `/wp-ai/v1/generate` call as ours if the request body
 * explicitly names our provider, names a known model id, or lists our
 * provider in its modelPreferences array.
 *
 * @param {string} path
 * @param {Object|null} data
 * @return {boolean}
 */
function isWebLlmGenerateRequest( path, data ) {
	if ( typeof path !== 'string' ) {
		return false;
	}
	if ( ! path.startsWith( '/wp-ai/v1/generate' ) ) {
		return false;
	}
	if ( ! data || typeof data !== 'object' ) {
		return false;
	}
	if ( data.providerId === providerId ) {
		return true;
	}
	if ( data.modelId && knownModelIds.has( data.modelId ) ) {
		return true;
	}
	if ( Array.isArray( data.modelPreferences ) ) {
		for ( const pref of data.modelPreferences ) {
			if ( Array.isArray( pref ) && pref[ 0 ] === providerId ) {
				return true;
			}
		}
	}
	return false;
}

/**
 * Classifies a `/wp-abilities/v1/abilities/{name}/run` call as ours
 * when we are the preferred text-generation provider and the ability
 * name starts with one of our registered prefixes (default `ai/`).
 *
 * This has a small false-positive window — any `ai/*` ability that
 * actually routes to a non-WebLLM provider will also trigger the
 * start modal. The user can cancel and the request proceeds normally.
 *
 * @param {string} path
 * @return {boolean}
 */
function isWebLlmAbilityRequest( path ) {
	if ( typeof path !== 'string' ) {
		return false;
	}
	const match = path.match(
		/^\/wp-abilities\/v1\/abilities\/(.+?)\/run(\?|$)/
	);
	if ( ! match ) {
		return false;
	}
	if ( ! config.isPreferredForTextGeneration ) {
		return false;
	}
	const abilityName = decodeURIComponent( match[ 1 ] );
	return abilityPrefixes.some( ( prefix ) =>
		abilityName.startsWith( prefix )
	);
}

if ( ! apiFetch || typeof apiFetch.use !== 'function' ) {
	// eslint-disable-next-line no-console
	console.warn( '[WebLLM] wp.apiFetch unavailable; middleware not registered.' );
} else {
	apiFetch.use( async ( options, next ) => {
		const path = options.path || '';
		const data = options.data || null;

		const isOurs =
			isWebLlmGenerateRequest( path, data ) || isWebLlmAbilityRequest( path );

		if ( ! isOurs ) {
			return next( options );
		}

		// Widget not mounted yet (early page load, before footer bootstrap
		// finishes). Fall through — the server-side 503 path is still a safety
		// net if the broker has no worker attached.
		const widget = window.webllmWidget;
		if ( ! widget ) {
			return next( options );
		}

		let status;
		try {
			status = await widget.getStatus();
		} catch ( e ) {
			return next( options );
		}

		if ( status && status.state === 'ready' ) {
			return next( options );
		}

		try {
			await widget.promptAndLoad();
			return next( options );
		} catch ( err ) {
			const errorMessage =
				( err && err.message ) || 'WebLLM model is not loaded.';
			// WP_Error-shaped rejection so the editor renders a clean notice
			// instead of `[object Object]`.
			return Promise.reject( {
				code: 'webllm_not_ready',
				message: errorMessage,
				data: { status: 503 },
			} );
		}
	} );
}
