const defaultConfig = require( '@wordpress/scripts/config/webpack.config' );
const path = require( 'path' );

// Two entries:
//   connector.js — ES module loaded by WP 7.0 Connectors page (Script Modules API).
//   worker.js    — classic script loaded on the Tools → WebLLM Worker admin page,
//                  bundles @mlc-ai/web-llm so it ships as one self-contained file.
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
