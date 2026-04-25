/**
 * Transformers.js engine adapter — wraps @huggingface/transformers.
 *
 * Gemma 4 uses the `Gemma4ForConditionalGeneration` + `AutoProcessor` API
 * directly (not `pipeline()`), because it is a multimodal Any-to-Any model
 * and `pipeline('text-generation')` does not support the gemma4 architecture.
 * Reference: https://huggingface.co/onnx-community/gemma-4-E2B-it-ONNX
 *
 * All other curated ONNX models (Gemma 3, Qwen 3) use the standard
 * `pipeline('text-generation')` API.
 *
 * @package UltimateAiConnectorWebLlm
 */

import { RUNTIME_TRANSFORMERS } from './engine-adapter';

// Lazy module handle — populated on first use.
let _transformers = null;

async function ensureTransformers() {
	if ( ! _transformers ) {
		_transformers = await import( /* webpackChunkName: "hf-transformers" */ '@huggingface/transformers' );
	}
	return _transformers;
}

/**
 * Returns true if the model ID is a Gemma 4 variant.
 * Gemma 4 requires Gemma4ForConditionalGeneration — the pipeline API doesn't
 * support its architecture type ("gemma4").
 *
 * @param {string} modelId
 * @return {boolean}
 */
function isGemma4( modelId ) {
	return /gemma-4/i.test( modelId );
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

/**
 * Build a progress_callback for Transformers.js that maps to our onProgress contract.
 *
 * @param {Function|undefined} onProgress
 * @return {Function|undefined}
 */
function makeProgressCallback( onProgress ) {
	if ( typeof onProgress !== 'function' ) {
		return undefined;
	}
	return ( p ) => {
		const pct = typeof p.progress === 'number' ? p.progress / 100 : null;
		const text = p.file ? `Downloading ${ p.file }…` : ( p.status || 'Loading…' );
		onProgress( { progress: pct, text } );
	};
}

function generateId() {
	return 'chatcmpl-tj-' + Date.now().toString( 36 ) + Math.random().toString( 36 ).slice( 2, 8 );
}

function wrapCompletion( modelId, generatedText, t0 ) {
	const estTokens = Math.ceil( generatedText.length / 4 );
	return {
		id: generateId(),
		object: 'chat.completion',
		created: Math.floor( Date.now() / 1000 ),
		model: modelId,
		choices: [ {
			index: 0,
			message: { role: 'assistant', content: generatedText },
			finish_reason: 'stop',
		} ],
		usage: { prompt_tokens: 0, completion_tokens: estTokens, total_tokens: estTokens },
		_elapsed_ms: Date.now() - t0,
	};
}

export function createTransformersEngine() {
	// State for Gemma 4 path (direct API).
	let g4Processor = null;
	let g4Model = null;
	// State for pipeline path (Gemma 3, Qwen 3, etc.).
	let pipelineInst = null;
	let currentModelId = null;
	let modelDtype = null;

	return {
		runtime: RUNTIME_TRANSFORMERS,

		async getModelList() {
			return CURATED_MODELS.map( ( m ) => ( { ...m, runtime: RUNTIME_TRANSFORMERS } ) );
		},

		/**
		 * Load a model.
		 *
		 * Gemma 4: loads AutoProcessor + Gemma4ForConditionalGeneration.
		 * Other ONNX models: loads via pipeline('text-generation').
		 */
		async load( modelId, { onProgress } = {} ) {
			const transformers = await ensureTransformers();
			const entry = CURATED_MODELS.find( ( m ) => m.id === modelId );
			modelDtype = entry?.dtype || 'q4f16';

			if ( typeof onProgress === 'function' ) {
				onProgress( { progress: 0, text: 'Loading model…' } );
			}

			const progressCallback = makeProgressCallback( onProgress );

			if ( isGemma4( modelId ) ) {
				// Gemma 4 requires direct class instantiation — pipeline() does
				// not support the "gemma4" architecture type in Transformers.js.
				const { AutoProcessor, Gemma4ForConditionalGeneration } = transformers;

				g4Processor = await AutoProcessor.from_pretrained( modelId, {
					progress_callback: progressCallback,
				} );
				g4Model = await Gemma4ForConditionalGeneration.from_pretrained( modelId, {
					dtype: modelDtype,
					device: 'webgpu',
					progress_callback: progressCallback,
				} );
			} else {
				pipelineInst = await transformers.pipeline( 'text-generation', modelId, {
					device: 'webgpu',
					dtype: modelDtype,
					progress_callback: progressCallback,
				} );
			}

			currentModelId = modelId;
		},

		/**
		 * Run a chat completion. Dispatches to the correct path based on
		 * which model is loaded.
		 */
		async chat( request ) {
			if ( ! currentModelId ) {
				throw new Error( 'Transformers.js engine not loaded' );
			}

			const messages = request.messages || [];
			const maxTokens = request.max_tokens || 1024;
			// Gemma 4 recommended defaults: temp=1.0, top_p=0.95.
			const temperature = typeof request.temperature === 'number' ? request.temperature : 1.0;
			const topP = typeof request.top_p === 'number' ? request.top_p : 0.95;
			const t0 = Date.now();

			if ( isGemma4( currentModelId ) ) {
				if ( ! g4Processor || ! g4Model ) {
					throw new Error( 'Gemma 4 processor/model not loaded' );
				}

				// Apply chat template: produces a single string prompt with
				// BOS/role tokens baked in.
				const prompt = g4Processor.apply_chat_template( messages, {
					add_generation_prompt: true,
					enable_thinking: false,
				} );

				// Text-only: pass null for image and audio arguments.
				const inputs = await g4Processor( prompt, null, null, {
					add_special_tokens: false,
				} );

				const outputs = await g4Model.generate( {
					...inputs,
					max_new_tokens: maxTokens,
					do_sample: temperature > 0,
					...( temperature > 0 && { temperature } ),
					...( temperature > 0 && { top_p: topP } ),
				} );

				// Slice away the input tokens; keep only newly generated ones.
				const inputLen = inputs.input_ids.dims.at( -1 );
				const decoded = g4Processor.batch_decode(
					outputs.slice( null, [ inputLen, null ] ),
					{ skip_special_tokens: true }
				);
				return wrapCompletion( currentModelId, decoded[ 0 ] || '', t0 );
			}

			// Pipeline path (Gemma 3, Qwen 3, etc.)
			if ( ! pipelineInst ) {
				throw new Error( 'Pipeline not loaded' );
			}
			const output = await pipelineInst( messages, {
				max_new_tokens: maxTokens,
				temperature,
				do_sample: temperature > 0,
				return_full_text: false,
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
			return wrapCompletion( currentModelId, generatedText, t0 );
		},

		async unload() {
			if ( g4Model ) {
				try { await g4Model.dispose(); } catch ( _ ) {}
				g4Model = null;
				g4Processor = null;
			}
			if ( pipelineInst ) {
				try { await pipelineInst.dispose(); } catch ( _ ) {}
				pipelineInst = null;
			}
			currentModelId = null;
			modelDtype = null;
		},

		getCurrentModelId() { return currentModelId; },
	};
}
