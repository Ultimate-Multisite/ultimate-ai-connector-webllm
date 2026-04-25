/**
 * Transformers.js engine adapter — wraps @huggingface/transformers.
 *
 * @package UltimateAiConnectorWebLlm
 */

import { RUNTIME_TRANSFORMERS } from './engine-adapter';

let _transformers = null;

async function ensureTransformers() {
	if ( ! _transformers ) {
		_transformers = await import( /* webpackChunkName: "hf-transformers" */ '@huggingface/transformers' );
	}
	return _transformers;
}

const CURATED_MODELS = [
	// Gemma 4 — best local inference + tool-use model as of 2026-04.
	{ id: 'onnx-community/gemma-4-E4B-it-ONNX', name: 'Gemma 4 E4B Instruct (ONNX)', vram_required_MB: 3500, dtype: 'q4f16', family: 'gemma4' },
	{ id: 'onnx-community/gemma-4-E2B-it-ONNX', name: 'Gemma 4 E2B Instruct (ONNX)', vram_required_MB: 1800, dtype: 'q4f16', family: 'gemma4' },
	// Gemma 3
	{ id: 'onnx-community/gemma-3-4b-it-ONNX', name: 'Gemma 3 4B Instruct (ONNX)', vram_required_MB: 3200, dtype: 'q4f16', family: 'gemma3' },
	{ id: 'onnx-community/gemma-3-1b-it-ONNX', name: 'Gemma 3 1B Instruct (ONNX)', vram_required_MB: 1200, dtype: 'q4f16', family: 'gemma3' },
	// Qwen 3
	{ id: 'onnx-community/Qwen3-0.6B-ONNX', name: 'Qwen3 0.6B (ONNX)', vram_required_MB: 800, dtype: 'q4', family: 'qwen' },
];

function generateId() {
	return 'chatcmpl-tj-' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 8 );
}

export function createTransformersEngine() {
	let pipeline = null;
	let currentModelId = null;
	let modelDtype = null;

	return {
		runtime: RUNTIME_TRANSFORMERS,

		async getModelList() {
			return CURATED_MODELS.map( ( m ) => ( { ...m, runtime: RUNTIME_TRANSFORMERS } ) );
		},

		async load( modelId, { onProgress } = {} ) {
			const transformers = await ensureTransformers();
			const entry = CURATED_MODELS.find( ( m ) => m.id === modelId );
			modelDtype = entry?.dtype || 'q4f16';
			if ( typeof onProgress === 'function' ) {
				onProgress( { progress: 0, text: 'Loading Transformers.js model…' } );
			}
			pipeline = await transformers.pipeline( 'text-generation', modelId, {
				device: 'webgpu',
				dtype: modelDtype,
				progress_callback: ( p ) => {
					if ( typeof onProgress === 'function' ) {
						const pct = typeof p.progress === 'number' ? p.progress / 100 : null;
						const text = p.file ? `Downloading ${ p.file }…` : ( p.status || 'Loading…' );
						onProgress( { progress: pct, text } );
					}
				},
			} );
			currentModelId = modelId;
		},

		async chat( request ) {
			if ( ! pipeline ) throw new Error( 'Transformers.js engine not loaded' );
			const messages = request.messages || [];
			const maxTokens = request.max_tokens || 1024;
			const temperature = typeof request.temperature === 'number' ? request.temperature : 0.7;
			const t0 = Date.now();
			const output = await pipeline( messages, {
				max_new_tokens: maxTokens, temperature, do_sample: temperature > 0, return_full_text: false,
			} );
			let generatedText = '';
			if ( Array.isArray( output ) && output.length > 0 ) {
				const first = output[ 0 ];
				if ( typeof first.generated_text === 'string' ) {
					generatedText = first.generated_text;
				} else if ( Array.isArray( first.generated_text ) ) {
					const lastMsg = first.generated_text[ first.generated_text.length - 1 ];
					generatedText = lastMsg?.content || '';
				}
			}
			const estTokens = Math.ceil( generatedText.length / 4 );
			return {
				id: generateId(), object: 'chat.completion', created: Math.floor( Date.now() / 1000 ),
				model: currentModelId,
				choices: [ { index: 0, message: { role: 'assistant', content: generatedText }, finish_reason: 'stop' } ],
				usage: { prompt_tokens: 0, completion_tokens: estTokens, total_tokens: estTokens },
				_elapsed_ms: Date.now() - t0,
			};
		},

		async unload() {
			if ( pipeline ) {
				try { await pipeline.dispose(); } catch ( _ ) {}
				pipeline = null;
			}
			currentModelId = null; modelDtype = null;
		},

		getCurrentModelId() { return currentModelId; },
	};
}
