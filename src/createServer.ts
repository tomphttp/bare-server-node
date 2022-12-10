import BareServer from './BareServer.js';
import type { BareMaintainer } from './BareServer.js';
import type { Database } from './Meta.js';
import { JSONDatabaseAdapter } from './Meta.js';
import { cleanupDatabase } from './Meta.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	maintainer?: BareMaintainer;
	httpAgent?: HttpAgent;
	httpsAgent?: HttpsAgent;
	database?: Database;
}

/**
 * Create a Bare server.
 * This will handle all lifecycles for unspecified options (httpAgent, httpsAgent, metaMap).
 */
export = function createBareServer(
	directory: string,
	init: BareServerInit = {}
) {
	if (typeof directory !== 'string')
		throw new Error('Directory must be specified.');
	if (!directory.startsWith('/') || !directory.endsWith('/'))
		throw new RangeError('Directory must start and end with /');
	init.logErrors ??= false;

	const cleanup: (() => void)[] = [];

	if (!init.httpAgent) {
		const httpAgent = new HttpAgent({
			keepAlive: true,
			timeout: 12e3,
		});
		init.httpAgent = httpAgent;
		cleanup.push(() => httpAgent.destroy());
	}

	if (!init.httpsAgent) {
		const httpsAgent = new HttpsAgent({
			keepAlive: true,
			timeout: 12e3,
		});
		init.httpsAgent = httpsAgent;
		cleanup.push(() => httpsAgent.destroy());
	}

	if (!init.database) {
		const database = new Map<string, string>();
		const interval = setInterval(() => cleanupDatabase(database), 1000);
		init.database = database;
		cleanup.push(() => clearInterval(interval));
	}

	const server = new BareServer(directory, <
		Required<BareServerInit> & { database: JSONDatabaseAdapter }
	>{
		...init,
		database: new JSONDatabaseAdapter(init.database),
	});
	registerV1(server);
	registerV2(server);

	server.once('close', () => {
		for (const cb of cleanup) cb();
	});

	return server;
};
