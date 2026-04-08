const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );
const path = require( 'path' );

// Three entries:
//   connector.js      — ES module loaded by WP 7.0 Connectors page (Script Modules API).
//   worker.js         — classic script loaded on the Tools → WebLLM Worker admin page,
//                       bundles @mlc-ai/web-llm so it ships as one self-contained file.
//   shared-worker.js  — SharedWorker entry point (p001 Phase 2). Hosts a single
//                       MLCEngine instance inside SharedWorkerGlobalScope, reachable
//                       from any same-origin tab. Loaded with { type: 'module' }.
//                       URL must be stable (no content hash) — SharedWorkers are keyed
//                       by (script URL, name); a hash change spawns a second worker.
//
// We can't easily ship two output formats from one webpack config, so the
// connector entry uses module output via the externals trick from the
// reference plugin and the worker entry rides the same module output (modern
// browsers handle <script type="module"> just fine; wp_enqueue_script will
// emit a regular <script> tag but @mlc-ai/web-llm itself works in both).

module.exports = {
	...defaultConfig,
	entry: {
		connector: path.resolve( __dirname, 'src', 'connector.jsx' ),
		worker: path.resolve( __dirname, 'src', 'worker.jsx' ),
		'shared-worker': path.resolve( __dirname, 'src', 'shared-worker.js' ),
		'floating-widget': path.resolve( __dirname, 'src', 'floating-widget.jsx' ),
		'widget-bootstrap': path.resolve( __dirname, 'src', 'widget-bootstrap.js' ),
	},
	output: {
		path: path.resolve( __dirname, 'build' ),
		filename: '[name].js',
		module: true,
		chunkFormat: 'module',
	},
	experiments: {
		...( defaultConfig.experiments || {} ),
		outputModule: true,
	},
	externalsType: 'module',
	externals: {
		'@wordpress/connectors': '@wordpress/connectors',
	},
	plugins: defaultConfig.plugins.filter(
		( plugin ) =>
			plugin.constructor.name !== 'DependencyExtractionWebpackPlugin'
	),
	module: {
		...defaultConfig.module,
		rules: [
			{
				test: /\.jsx?$/,
				exclude: /node_modules\/(?!@mlc-ai)/,
				use: {
					loader: require.resolve( 'babel-loader' ),
					options: {
						presets: [ require.resolve( '@babel/preset-env' ) ],
						plugins: [
							[
								require.resolve( '@babel/plugin-transform-react-jsx' ),
								{
									runtime: 'classic',
									pragma: 'createElement',
								},
							],
						],
					},
				},
			},
		],
	},
};
