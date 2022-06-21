import babel from '@rollup/plugin-babel';
import typescript from 'rollup-plugin-typescript2';

export default [
	['esm', 'src/BareServer.ts', 'named'], // import
	['umd', 'src/index.ts', 'default'], // require
].map(([format, input, exports]) => ({
	input,
	output: {
		file: `dist/BareServer.${format}.js`,
		format,
		name: 'BareServer',
		exports,
	},
	plugins: [
		typescript(),
		babel({ babelHelpers: 'bundled', extensions: ['.ts'] }),
	],
}));
