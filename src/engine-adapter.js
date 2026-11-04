/**
 * Engine adapter — abstract interface for LLM inference runtimes.
 *
 * @mlc-ai/web-llm implements this contract so the SharedWorker, dedicated-tab
 * worker, and floating widget share request-normalisation code.
 *
 * @package UltimateAiConnectorWebLlm
 */

export const RUNTIME_WEBLLM = 'webllm';

/**
 * Flatten an OpenAI content-parts array to a plain string.
 *
 * @param {string|Array|Object} c
 * @return {string}
 */
export function flattenContent( c ) {
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
}

/**
 * Normalise an SDK chat-completion request into the subset WebLLM accepts.
 *
 * @param {Object} raw       Raw request from the broker job or direct chat RPC.
 * @param {string} modelId   Currently-loaded model id.
 * @return {Object}           Normalised payload.
 */
export function normaliseRequest( raw, modelId ) {
	const messages = Array.isArray( raw?.messages )
		? raw.messages.map( ( m ) => ( {
				role: m.role || 'user',
				content: flattenContent( m.content ),
		  } ) )
		: [];
	const out = { messages, model: modelId || raw?.model, stream: false };
	if ( typeof raw?.temperature === 'number' ) out.temperature = raw.temperature;
	if ( typeof raw?.top_p === 'number' ) out.top_p = raw.top_p;
	if ( typeof raw?.max_tokens === 'number' ) out.max_tokens = raw.max_tokens;
	if ( typeof raw?.frequency_penalty === 'number' ) out.frequency_penalty = raw.frequency_penalty;
	if ( typeof raw?.presence_penalty === 'number' ) out.presence_penalty = raw.presence_penalty;
	if ( Array.isArray( raw?.stop ) ) out.stop = raw.stop;
	return out;
}
