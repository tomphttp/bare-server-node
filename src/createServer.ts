import BareServer from './BareServer.js';
import type { Options, BareMaintainer } from './BareServer.js';
import type { Database } from './Meta.js';
import { JSONDatabaseAdapter } from './Meta.js';
import { cleanupDatabase } from './Meta.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';
import type { BareRemote } from './requestUtil.js';
import { isValid, parse } from 'ipaddr.js';
import { lookup } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	filterRemote?: Options['filterRemote'];
	lookup?: Options['lookup'];
	/**
	 * IP address family to use when resolving `host` or `hostname`. Valid values are `4` or `6`. When unspecified, both IP v4 and v6 will be used.
	 */
	family?: number;
	maintainer?: BareMaintainer;
	httpAgent?: HttpAgent;
	httpsAgent?: HttpsAgent;
	database?: Database;
}

const validIPFamily: number[] = [0, 4, 6];

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

	if (typeof init.family === 'number' && !validIPFamily.includes(init.family))
		throw new RangeError('init.family must be one of: 0, 4, 6');

	init.filterRemote ??= (remote: BareRemote) => {
		if (isValid(remote.host) && parse(remote.host).range() !== 'unicast')
			throw new RangeError('Forbidden IP');
	};

	init.lookup ??= (hostname, options, callback) =>
		lookup(hostname, options, (err, address, family) => {
			if (address && parse(address).range() !== 'unicast')
				callback(new RangeError('Forbidden IP'), '', -1);
			else callback(err, address, family);
		});

	if (!init.httpAgent) {
		const httpAgent = new HttpAgent({
			keepAlive: true,
		});
		init.httpAgent = httpAgent;
		cleanup.push(() => httpAgent.destroy());
	}

	if (!init.httpsAgent) {
		const httpsAgent = new HttpsAgent({
			keepAlive: true,
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

	const server = new BareServer(directory, {
		...(init as Required<BareServerInit>),
		database: new JSONDatabaseAdapter(init.database),
	});
	registerV1(server);
	registerV2(server);

	server.once('close', () => {
		for (const cb of cleanup) cb();
	});

	return server;
};
