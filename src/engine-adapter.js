/**
 * Engine adapter — abstract interface for LLM inference runtimes.
 *
 * Both @mlc-ai/web-llm (MLC format) and @huggingface/transformers (ONNX
 * format) implement this contract so the SharedWorker, dedicated-tab
 * worker, and floating widget can swap runtimes without changing their
 * own code.
 *
 * @package UltimateAiConnectorWebLlm
 */

export const RUNTIME_WEBLLM = 'webllm';
export const RUNTIME_TRANSFORMERS = 'transformers';

/**
 * Detect which runtime a model ID belongs to.
 *
 * HuggingFace model IDs contain a `/` (e.g. `onnx-community/gemma-4-4b-it-ONNX`).
 * Everything else is a WebLLM MLC-compiled model.
 *
 * @param {string} modelId
 * @return {string} RUNTIME_WEBLLM or RUNTIME_TRANSFORMERS
 */
export function detectRuntime( modelId ) {
	if ( typeof modelId === 'string' && modelId.includes( '/' ) ) {
		return RUNTIME_TRANSFORMERS;
	}
	return RUNTIME_WEBLLM;
}

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
 * Normalise an SDK chat-completion request into the subset both engines accept.
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
