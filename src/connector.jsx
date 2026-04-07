/**
 * WebLLM Connector card on Settings → Connectors.
 *
 * @package UltimateAiConnectorWebLlm
 */

import {
	__experimentalRegisterConnector as registerConnector,
	__experimentalConnectorItem as ConnectorItem,
} from '@wordpress/connectors';

const { createElement, useState, useEffect, useCallback } = wp.element;
const {
	Button,
	SelectControl,
	ToggleControl,
	Spinner,
	__experimentalNumberControl: NumberControl,
	__experimentalHStack: HStack,
	__experimentalVStack: VStack,
} = wp.components;
const { __ } = wp.i18n;
const apiFetch = wp.apiFetch;

function Logo() {
	return (
		<svg width={ 40 } height={ 40 } viewBox="0 0 24 24" fill="none">
			<rect x={ 3 } y={ 4 } width={ 18 } height={ 12 } rx={ 2 } stroke="currentColor" strokeWidth={ 2 } />
			<line x1={ 8 } y1={ 20 } x2={ 16 } y2={ 20 } stroke="currentColor" strokeWidth={ 2 } strokeLinecap="round" />
			<line x1={ 12 } y1={ 16 } x2={ 12 } y2={ 20 } stroke="currentColor" strokeWidth={ 2 } strokeLinecap="round" />
			<circle cx={ 12 } cy={ 10 } r={ 2 } fill="currentColor" />
		</svg>
	);
}

function Badge( { online } ) {
	const style = online
		? { color: '#345b37', backgroundColor: '#eff8f0' }
		: { color: '#7a3a1a', backgroundColor: '#fdf3ec' };
	return (
		<span style={ { ...style, padding: '4px 12px', borderRadius: 2, fontSize: 13, fontWeight: 500 } }>
			{ online ? __( 'Worker online' ) : __( 'Worker offline' ) }
		</span>
	);
}

function WebLlmConnectorCard( { label, description } ) {
	const [ isExpanded, setIsExpanded ] = useState( false );
	const [ isLoading, setIsLoading ] = useState( true );
	const [ isSaving, setIsSaving ] = useState( false );
	const [ defaultModel, setDefaultModel ] = useState( '' );
	const [ timeout, setTimeoutVal ] = useState( 180 );
	const [ allowRemote, setAllowRemote ] = useState( false );
	const [ contextWindow, setContextWindow ] = useState( 8192 );
	const [ models, setModels ] = useState( [] );
	const [ workerOnline, setWorkerOnline ] = useState( false );
	const [ saveError, setSaveError ] = useState( null );

	const refreshStatus = useCallback( async () => {
		try {
			const s = await apiFetch( { path: '/webllm/v1/status' } );
			setWorkerOnline( !! s.worker_online );
		} catch {}
	}, [] );

	const loadAll = useCallback( async () => {
		try {
			const settings = await apiFetch( {
				path: '/wp/v2/settings?_fields=webllm_default_model,webllm_request_timeout,webllm_allow_remote_clients,webllm_context_window',
			} );
			setDefaultModel( settings.webllm_default_model || '' );
			setTimeoutVal( settings.webllm_request_timeout ?? 180 );
			setAllowRemote( !! settings.webllm_allow_remote_clients );
			setContextWindow( settings.webllm_context_window ?? 8192 );
		} catch {}
		try {
			const m = await apiFetch( { path: '/webllm/v1/models' } );
			if ( m && Array.isArray( m.data ) ) {
				setModels( m.data );
			}
		} catch {}
		await refreshStatus();
		setIsLoading( false );
	}, [ refreshStatus ] );

	useEffect( () => {
		loadAll();
		const t = setInterval( refreshStatus, 5000 );
		return () => clearInterval( t );
	}, [ loadAll, refreshStatus ] );

	const handleSave = async () => {
		setSaveError( null );
		setIsSaving( true );
		try {
			await apiFetch( {
				method: 'POST',
				path: '/wp/v2/settings',
				data: {
					webllm_default_model: defaultModel,
					webllm_request_timeout: parseInt( timeout, 10 ) || 180,
					webllm_allow_remote_clients: allowRemote,
					webllm_context_window: parseInt( contextWindow, 10 ) || 8192,
				},
			} );
			setIsExpanded( false );
		} catch ( e ) {
			setSaveError( e instanceof Error ? e.message : __( 'Failed to save.' ) );
		} finally {
			setIsSaving( false );
		}
	};

	const openWorker = () => {
		window.open(
			( window.ajaxurl || '/wp-admin/admin-ajax.php' ).replace( '/admin-ajax.php', '/tools.php' ) + '?page=webllm-worker',
			'webllm-worker',
			'width=560,height=720'
		);
	};

	const modelOptions = [
		{ label: __( 'Auto-select (SDK chooses)' ), value: '' },
		...models.map( ( m ) => ( { label: m.name || m.id, value: m.id } ) ),
	];

	const actionArea = (
		<HStack spacing={ 3 } expanded={ false }>
			<Badge online={ workerOnline } />
			<Button
				variant="secondary"
				size="compact"
				onClick={ () => setIsExpanded( ! isExpanded ) }
				disabled={ isLoading }
			>
				{ isExpanded ? __( 'Cancel' ) : __( 'Configure' ) }
			</Button>
		</HStack>
	);

	const form = isExpanded ? (
		<VStack spacing={ 4 }>
			<div style={ { background: '#fff8e1', borderLeft: '4px solid #f0b849', padding: '10px 14px', fontSize: 13 } }>
				{ __(
					'WebLLM runs entirely in the user\'s browser via WebGPU. You must keep the WebLLM Worker tab open in a desktop browser with a dedicated GPU. Other devices on this site can route requests to that tab when "Allow remote clients" is enabled.',
					'ultimate-ai-connector-webllm'
				) }
			</div>

			<HStack>
				<Button variant="primary" onClick={ openWorker } __next40pxDefaultSize>
					{ __( 'Open worker tab', 'ultimate-ai-connector-webllm' ) }
				</Button>
			</HStack>

			{ models.length === 0 ? (
				<p style={ { fontSize: 13, color: '#666' } }>
					{ __( 'No models reported yet. Open the worker tab once to populate the model list.', 'ultimate-ai-connector-webllm' ) }
				</p>
			) : (
				<SelectControl
					label={ __( 'Default Model' ) }
					value={ defaultModel }
					options={ modelOptions }
					onChange={ setDefaultModel }
					disabled={ isSaving }
					__nextHasNoMarginBottom
					__next40pxDefaultSize
				/>
			) }

			<NumberControl
				label={ __( 'Request Timeout (seconds)', 'ultimate-ai-connector-webllm' ) }
				value={ timeout }
				onChange={ ( v ) => setTimeoutVal( parseInt( v, 10 ) || 180 ) }
				min={ 10 }
				max={ 600 }
				step={ 10 }
				disabled={ isSaving }
				__next40pxDefaultSize
			/>

			<NumberControl
				label={ __( 'Context Window (tokens)', 'ultimate-ai-connector-webllm' ) }
				value={ contextWindow }
				onChange={ ( v ) => setContextWindow( parseInt( v, 10 ) || 8192 ) }
				min={ 1024 }
				max={ 131072 }
				step={ 1024 }
				disabled={ isSaving }
				help={ __(
					'Override WebLLM\'s baked-in 4K cap so longer system prompts (e.g. AI agent tool definitions) fit. Each doubling roughly doubles VRAM for the KV cache. Reload the worker tab after changing.',
					'ultimate-ai-connector-webllm'
				) }
				__next40pxDefaultSize
			/>

			<ToggleControl
				label={ __( 'Allow remote clients (phones, tablets, other users)', 'ultimate-ai-connector-webllm' ) }
				help={ __(
					'When enabled, any logged-in user on this site can submit inference jobs that will be served by your worker tab. Disable to restrict to admins only.',
					'ultimate-ai-connector-webllm'
				) }
				checked={ allowRemote }
				onChange={ setAllowRemote }
				__nextHasNoMarginBottom
			/>

			{ saveError && <p style={ { color: '#cc1818' } }>{ saveError }</p> }

			<HStack justify="flex-start">
				<Button variant="primary" isBusy={ isSaving } onClick={ handleSave } __next40pxDefaultSize>
					{ __( 'Save' ) }
				</Button>
			</HStack>
		</VStack>
	) : null;

	return (
		<ConnectorItem
			className="connector-item--ultimate-ai-connector-webllm"
			icon={ <Logo /> }
			name={ label }
			description={ description }
			actionArea={ actionArea }
		>
			{ form }
		</ConnectorItem>
	);
}

const SLUG = 'ultimate-ai-connector-webllm';
const CONFIG = {
	label: __( 'WebLLM (Browser GPU)' ),
	description: __(
		'Run LLM inference entirely in the user\'s browser via WebGPU + WebLLM. A persistent worker tab provides the GPU; the WordPress site brokers requests so any logged-in device can use it.'
	),
	render: WebLlmConnectorCard,
};

// WP core's `routes/connectors-home/content.js` runs
// `registerDefaultConnectors()` which iterates every AI provider in the PHP
// registry and re-registers each one with the generic ApiKeyConnector
// render function. Whichever script runs *last* wins because the store
// reducer spreads new config over the existing entry. Plugin script modules
// can fire either before or after content.js depending on import-graph
// resolution order, so we re-assert our registration on multiple ticks to
// always end up last. The selectors that would let us read the store are
// private, so we just call registerConnector() unconditionally — it's a
// simple state replace and idempotent for our render reference.
function registerOurs() {
	registerConnector( SLUG, CONFIG );
}

registerOurs();
// Microtask: covers the common case where the WP default-register runs
// synchronously right after our script.
Promise.resolve().then( registerOurs );
// Macrotask: covers the case where it runs in a later script-module tick.
setTimeout( registerOurs, 0 );
// Last-resort retries for whatever absurd race we haven't thought of.
setTimeout( registerOurs, 50 );
setTimeout( registerOurs, 250 );
setTimeout( registerOurs, 1000 );
