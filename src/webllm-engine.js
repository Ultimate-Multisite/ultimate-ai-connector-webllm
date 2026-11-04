/**
 * WebLLM engine adapter — wraps @mlc-ai/web-llm's MLCEngine.
 *
 * @package UltimateAiConnectorWebLlm
 */

import { RUNTIME_WEBLLM } from './engine-adapter';

let _webllm = null;

async function ensureWebLlm() {
	if ( ! _webllm ) {
		_webllm = await import( /* webpackChunkName: "mlc-ai-web-llm" */ '@mlc-ai/web-llm' );
	}
	return _webllm;
}

export function createWebLlmEngine() {
	let engine = null;
	let modelList = null;
	let currentModelId = null;

	return {
		runtime: RUNTIME_WEBLLM,

		async getModelList() {
			if ( modelList ) return modelList;
			const mod = await ensureWebLlm();
			const raw = ( mod.prebuiltAppConfig && Array.isArray( mod.prebuiltAppConfig.model_list ) )
				? mod.prebuiltAppConfig.model_list : [];
			modelList = raw.map( ( m ) => ( {
				id: m.model_id || m.id,
				name: m.model_id || m.id,
				vram_required_MB: m.vram_required_MB,
				runtime: RUNTIME_WEBLLM,
				_raw: m,
			} ) );
			return modelList;
		},

		async load( modelId, { onProgress, contextWindow } = {} ) {
			if ( engine ) {
				try { await engine.unload(); } catch ( _ ) {}
				engine = null;
				currentModelId = null;
			}
			const mod = await ensureWebLlm();
			const appConfig = JSON.parse( JSON.stringify( mod.prebuiltAppConfig ) );
			const entry = appConfig.model_list.find( ( m ) => ( m.model_id || m.id ) === modelId );
			if ( entry && contextWindow ) {
				const isEmbedding = entry.model_type === 1 || /embed/i.test( entry.model_id || entry.id || '' );
				if ( ! isEmbedding ) {
					entry.overrides = { ...( entry.overrides || {} ), context_window_size: contextWindow };
				}
			}
			appConfig.useIndexedDBCache = true;
			engine = await mod.CreateMLCEngine( modelId, {
				appConfig,
				initProgressCallback: ( p ) => {
					if ( typeof onProgress === 'function' ) {
						onProgress( { progress: typeof p.progress === 'number' ? p.progress : null, text: p.text || '' } );
					}
				},
			} );
			currentModelId = modelId;
		},

		async chat( request ) {
			if ( ! engine ) throw new Error( 'WebLLM engine not loaded' );
			return engine.chat.completions.create( request );
		},

		async unload() {
			if ( engine ) {
				try { await engine.unload(); } catch ( _ ) {}
				engine = null;
			}
			currentModelId = null;
		},

		getCurrentModelId() { return currentModelId; },
	};
}
