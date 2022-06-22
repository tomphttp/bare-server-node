import { dirname, join, relative } from 'path';
import { argv, cwd } from 'process';
import { fileURLToPath } from 'url';

const scriptArgs = argv.slice(2);

console.warn(
	'App.js is no longer the entry point to bare-server-node. Instead, use the following:'
);

console.log(
	['npm', 'start', scriptArgs.length ? '--' : '', ...scriptArgs].join(' ')
);

console.log(
	[
		'node',
		relative(
			cwd(),
			join(dirname(fileURLToPath(import.meta.url)), 'scripts/start.js')
		),
		...scriptArgs,
	].join(' ')
);

import('./scripts/start.js');
