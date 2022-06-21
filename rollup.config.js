import babel from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import nodeResolve from '@rollup/plugin-node-resolve';
import typescript from 'rollup-plugin-typescript2';

export default [
	['esm', 'src/index.ts', 'named'], // import
	['umd', 'src/createServer.ts', 'default'], // require
].map(([format, input, exports]) => ({
	input,
	output: {
		file: `dist/BareServer.${format}.js`,
		format,
		name: 'BareServer',
		exports,
	},
	external: [...Object.keys(process.binding('natives')), 'http-errors'],
	plugins: [
		nodeResolve({ modulesOnly: true }),
		commonjs(),
		typescript(),
		babel({ babelHelpers: 'bundled', extensions: ['.ts'] }),
	],
}));
