/**
 * WebGPU troubleshooting diagnostics.
 *
 * Shared module that detects WebGPU problems and maps them to actionable
 * remediation steps. Only surfaces guidance when a problem is detected --
 * no noise for users where everything works.
 *
 * Consumed by: worker.jsx, floating-widget.jsx, widget-bootstrap.js,
 * connector.jsx.
 *
 * @package UltimateAiConnectorWebLlm
 */

// ---------------------------------------------------------------------------
// Detection: run a series of checks and return a diagnostic report.
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WebGpuDiagnostic
 * @property {boolean} webgpuApiPresent     - navigator.gpu exists
 * @property {boolean} adapterAvailable     - requestAdapter() returned non-null
 * @property {boolean} isSoftwareAdapter    - adapter reports software/CPU rendering
 * @property {boolean} hasShaderF16         - shader-f16 extension available
 * @property {boolean} isInsecureContext    - page served over HTTP (not localhost)
 * @property {string|null} adapterDescription - human-readable adapter info
 * @property {string|null} vendor           - GPU vendor string
 * @property {Array<Object>} issues         - detected problems with remediation
 */

/**
 * Probe WebGPU capabilities and return a diagnostic report.
 *
 * Safe to call in any context (main thread, SharedWorker). Returns issues
 * only when problems are detected.
 *
 * @return {Promise<WebGpuDiagnostic>}
 */
export async function diagnoseWebGpu() {
	const result = {
		webgpuApiPresent: false,
		adapterAvailable: false,
		isSoftwareAdapter: false,
		hasShaderF16: false,
		isInsecureContext: false,
		adapterDescription: null,
		vendor: null,
		issues: [],
	};

	// Check secure context (relevant for main thread only).
	const nav = typeof navigator !== 'undefined' ? navigator : ( typeof self !== 'undefined' ? self.navigator : null );
	if ( typeof window !== 'undefined' ) {
		const isSecure = window.isSecureContext;
		const isLocalhost = window.location?.hostname === 'localhost' ||
			window.location?.hostname === '127.0.0.1' ||
			window.location?.hostname === '::1';
		if ( ! isSecure && ! isLocalhost ) {
			result.isInsecureContext = true;
		}
	}

	// Check navigator.gpu.
	const gpu = nav?.gpu;
	if ( ! gpu ) {
		result.webgpuApiPresent = false;
		result.issues.push( {
			id: 'no-webgpu-api',
			severity: 'error',
			title: 'WebGPU API not available',
			description: 'This browser does not expose the WebGPU API, which is required for in-browser AI inference.',
			steps: buildNoWebGpuSteps( result.isInsecureContext ),
		} );
		return result;
	}

	result.webgpuApiPresent = true;

	// Request adapter.
	let adapter = null;
	try {
		adapter = await gpu.requestAdapter();
	} catch ( e ) {
		// requestAdapter threw -- treat as unavailable.
	}

	if ( ! adapter ) {
		result.adapterAvailable = false;
		result.issues.push( {
			id: 'no-adapter',
			severity: 'error',
			title: 'No WebGPU adapter found',
			description: 'The browser supports WebGPU but could not find a compatible GPU. This usually means the GPU is blocklisted or the Vulkan driver is not enabled.',
			steps: buildNoAdapterSteps(),
		} );
		return result;
	}

	result.adapterAvailable = true;

	// Read adapter info.
	let info = {};
	try {
		if ( typeof adapter.requestAdapterInfo === 'function' ) {
			info = await adapter.requestAdapterInfo();
		} else if ( adapter.info ) {
			info = adapter.info;
		}
	} catch ( e ) {}

	result.vendor = info.vendor || null;
	result.adapterDescription = [ info.vendor, info.architecture, info.device, info.description ]
		.filter( Boolean ).join( ' / ' ) || null;

	// Check for software rendering.
	const descLower = ( result.adapterDescription || '' ).toLowerCase();
	const isSoftware = descLower.includes( 'swiftshader' ) ||
		descLower.includes( 'llvmpipe' ) ||
		descLower.includes( 'software' ) ||
		descLower.includes( 'cpu' ) ||
		( info.adapterType === 'cpu' );
	if ( isSoftware ) {
		result.isSoftwareAdapter = true;
		result.issues.push( {
			id: 'software-rendering',
			severity: 'warning',
			title: 'Software rendering detected',
			description: 'WebGPU is using a software renderer (' + ( result.adapterDescription || 'CPU' ) + ') instead of your GPU. Inference will be extremely slow. Your GPU may be blocklisted.',
			steps: buildSoftwareRenderingSteps(),
		} );
	}

	// Check shader-f16.
	try {
		if ( adapter.features && typeof adapter.features.has === 'function' ) {
			result.hasShaderF16 = adapter.features.has( 'shader-f16' );
		}
	} catch ( e ) {}

	// Insecure context warning (separate from the no-API case above,
	// because WebGPU may still work on some browsers over HTTP but with
	// degraded capabilities).
	if ( result.isInsecureContext ) {
		result.issues.push( {
			id: 'insecure-context',
			severity: 'warning',
			title: 'Site served over HTTP',
			description: 'This WordPress site is not using HTTPS. Some browsers restrict WebGPU features on insecure origins. If you experience issues, either enable HTTPS or add this origin to Chrome\'s insecure-origins allowlist.',
			steps: buildInsecureContextSteps(),
		} );
	}

	return result;
}

// ---------------------------------------------------------------------------
// Map web-llm error names to troubleshooting guidance.
// ---------------------------------------------------------------------------

/**
 * Given an error from @mlc-ai/web-llm, return troubleshooting guidance
 * or null if the error is not one we have specific advice for.
 *
 * @param {Error|string} error
 * @return {Object|null} { id, severity, title, description, steps }
 */
export function diagnoseWebLlmError( error ) {
	const name = error?.name || '';
	const message = typeof error === 'string' ? error : ( error?.message || '' );

	if ( name === 'WebGPUNotAvailableError' || name === 'WebGPUNotFoundError' ||
		message.includes( 'WebGPU is not supported' ) || message.includes( 'Cannot find WebGPU' ) ) {
		return {
			id: 'webllm-no-webgpu',
			severity: 'error',
			title: 'WebGPU not available',
			description: 'The AI engine requires WebGPU but it is not available in this browser.',
			steps: buildNoWebGpuSteps( false ),
		};
	}

	if ( name === 'ShaderF16SupportError' || message.includes( 'shader-f16' ) ) {
		return {
			id: 'webllm-no-f16',
			severity: 'error',
			title: 'shader-f16 extension not supported',
			description: 'This model requires the shader-f16 WebGPU extension, which your GPU or browser does not support. Choose a model without "f16" or "BF16" in its name, or try enabling unsafe WebGPU APIs.',
			steps: [
				{
					text: 'Choose a different model -- look for q4f32 variants instead of f16/BF16.',
					type: 'action',
				},
				{
					text: 'In Chrome/Edge, navigate to chrome://flags/#enable-unsafe-webgpu and set it to Enabled.',
					type: 'chrome-flag',
					flag: '#enable-unsafe-webgpu',
				},
			],
		};
	}

	if ( name === 'DeviceLostError' || message.includes( 'device was lost' ) || message.includes( 'Device lost' ) ) {
		return {
			id: 'webllm-device-lost',
			severity: 'error',
			title: 'GPU device lost (out of memory)',
			description: 'The GPU ran out of memory while loading the model. Try a smaller model or reduce the context window size in the connector settings.',
			steps: [
				{
					text: 'Choose a smaller model (fewer parameters or lower quantization, e.g. 1B instead of 7B).',
					type: 'action',
				},
				{
					text: 'Reduce the "Context Window" setting in Settings > Connectors > WebLLM.',
					type: 'action',
				},
				{
					text: 'Close other GPU-intensive tabs or applications to free VRAM.',
					type: 'action',
				},
			],
		};
	}

	return null;
}

// ---------------------------------------------------------------------------
// Step builders -- each returns an array of remediation steps.
// ---------------------------------------------------------------------------

/**
 * @param {boolean} isInsecureContext
 * @return {Array<Object>}
 */
function buildNoWebGpuSteps( isInsecureContext ) {
	const steps = [
		{
			text: 'Use a supported browser: Chrome 113+ or Edge 113+ on desktop. Safari and Firefox have limited or no WebGPU support.',
			type: 'action',
		},
	];

	if ( isInsecureContext ) {
		steps.push( {
			text: 'Your site is served over HTTP. WebGPU requires a secure context. Either set up HTTPS, or in Chrome/Edge go to chrome://flags/#unsafely-treat-insecure-origin-as-secure and add your site\'s URL (e.g. http://mysite.local).',
			type: 'chrome-flag',
			flag: '#unsafely-treat-insecure-origin-as-secure',
		} );
	}

	steps.push(
		{
			text: 'In Chrome/Edge, navigate to chrome://flags/#enable-unsafe-webgpu and set it to Enabled, then relaunch.',
			type: 'chrome-flag',
			flag: '#enable-unsafe-webgpu',
		},
		{
			text: 'Check chrome://gpu -- look for "WebGPU: Hardware accelerated". If it says "Disabled" or "Software only", continue with the steps below.',
			type: 'diagnostic',
		},
		{
			text: 'Enable chrome://flags/#ignore-gpu-blocklist to override GPU blocklist restrictions.',
			type: 'chrome-flag',
			flag: '#ignore-gpu-blocklist',
		},
		{
			text: 'On Linux with NVIDIA or AMD GPUs, enable chrome://flags/#enable-vulkan to use the Vulkan backend. This is often required for WebGPU to detect your GPU.',
			type: 'chrome-flag',
			flag: '#enable-vulkan',
		},
		{
			text: 'After changing flags, relaunch the browser completely (close all windows, not just the tab).',
			type: 'action',
		}
	);

	return steps;
}

/**
 * @return {Array<Object>}
 */
function buildNoAdapterSteps() {
	return [
		{
			text: 'Check chrome://gpu -- look for "WebGPU: Hardware accelerated". If it says "Disabled" or "Unavailable", your GPU may be blocklisted.',
			type: 'diagnostic',
		},
		{
			text: 'Enable chrome://flags/#ignore-gpu-blocklist to override browser GPU restrictions.',
			type: 'chrome-flag',
			flag: '#ignore-gpu-blocklist',
		},
		{
			text: 'On Linux, enable chrome://flags/#enable-vulkan -- many GPUs (especially NVIDIA Pascal and older) need this for WebGPU.',
			type: 'chrome-flag',
			flag: '#enable-vulkan',
		},
		{
			text: 'Enable chrome://flags/#enable-unsafe-webgpu for broader hardware support.',
			type: 'chrome-flag',
			flag: '#enable-unsafe-webgpu',
		},
		{
			text: 'Ensure your GPU drivers are up to date. On Linux, check nvidia-smi or glxinfo.',
			type: 'action',
		},
		{
			text: 'After changing any flags, fully relaunch the browser.',
			type: 'action',
		},
	];
}

/**
 * @return {Array<Object>}
 */
function buildSoftwareRenderingSteps() {
	return [
		{
			text: 'Check chrome://gpu for details on why your GPU is not being used.',
			type: 'diagnostic',
		},
		{
			text: 'Enable chrome://flags/#ignore-gpu-blocklist to force Chrome to use your GPU.',
			type: 'chrome-flag',
			flag: '#ignore-gpu-blocklist',
		},
		{
			text: 'On Linux, enable chrome://flags/#enable-vulkan -- this is required for many GPUs.',
			type: 'chrome-flag',
			flag: '#enable-vulkan',
		},
		{
			text: 'Ensure your GPU drivers are installed and up to date.',
			type: 'action',
		},
		{
			text: 'After changing flags, fully relaunch the browser.',
			type: 'action',
		},
	];
}

/**
 * @return {Array<Object>}
 */
function buildInsecureContextSteps() {
	return [
		{
			text: 'Recommended: Set up HTTPS for your WordPress site (e.g. via a reverse proxy or local certificate).',
			type: 'action',
		},
		{
			text: 'Quick workaround: In Chrome/Edge, go to chrome://flags/#unsafely-treat-insecure-origin-as-secure and add your site URL (e.g. http://192.168.1.100).',
			type: 'chrome-flag',
			flag: '#unsafely-treat-insecure-origin-as-secure',
		},
		{
			text: 'After changing the flag, relaunch the browser.',
			type: 'action',
		},
	];
}

// ---------------------------------------------------------------------------
// UI helper: format issues into a human-readable summary.
// ---------------------------------------------------------------------------

/**
 * Return true if the diagnostic has any issues worth showing.
 *
 * @param {WebGpuDiagnostic} diag
 * @return {boolean}
 */
export function hasIssues( diag ) {
	return diag && Array.isArray( diag.issues ) && diag.issues.length > 0;
}

/**
 * Return a plain-text summary of all issues, suitable for console output
 * or a simple text area. Used by widget-bootstrap.js where React is not
 * available.
 *
 * @param {WebGpuDiagnostic} diag
 * @return {string}
 */
export function formatIssuesPlainText( diag ) {
	if ( ! hasIssues( diag ) ) {
		return '';
	}
	return diag.issues.map( ( issue ) => {
		let text = issue.title + ': ' + issue.description + '\n';
		if ( issue.steps ) {
			text += issue.steps.map( ( s, i ) => '  ' + ( i + 1 ) + '. ' + s.text ).join( '\n' );
		}
		return text;
	} ).join( '\n\n' );
}
