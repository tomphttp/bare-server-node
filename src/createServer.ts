import { lookup } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { isValid, parse } from 'ipaddr.js';
import { WebSocketServer } from 'ws';
import BareServer from './BareServer.js';
import type { BareMaintainer, Options } from './BareServer.js';
import type { Database } from './Meta.js';
import { cleanupDatabase, JSONDatabaseAdapter } from './Meta.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';
import registerV3 from './V3.js';

export const validIPFamily: number[] = [0, 4, 6];

export type IPFamily = 0 | 4 | 6;

export interface BareServerInit {
	logErrors?: boolean;
	localAddress?: string;
	/**
	 * When set, the default logic for blocking local IP addresses is disabled.
	 */
	filterRemote?: Options['filterRemote'];
	/**
	 * When set, the default logic for blocking local IP addresses is disabled.
	 */
	lookup?: Options['lookup'];
	/**
	 * If local IP addresses/DNS records should be blocked.
	 * @default true
	 */
	blockLocal?: boolean;
	/**
	 * IP address family to use when resolving `host` or `hostname`. Valid values are `0`, `4`, and `6`. When unspecified/0, both IP v4 and v6 will be used.
	 */
	family?: IPFamily | number;
	maintainer?: BareMaintainer;
	httpAgent?: HttpAgent;
	httpsAgent?: HttpsAgent;
	/**
	 * If legacy clients should be supported (v1 & v2). If this is set to false, the database can be safely ignored.
	 * @default true
	 */
	legacySupport?: boolean;
	database?: Database;
}

export interface Address {
	address: string;
	family: number;
}

/**
 * Converts the address and family of a DNS lookup callback into an array if it wasn't already
 */
export function toAddressArray(address: string | Address[], family?: number) {
	if (typeof address === 'string')
		return [
			{
				address,
				family,
			},
		] as Address[];
	else return address;
}

/**
 * Create a Bare server.
 * This will handle all lifecycles for unspecified options (httpAgent, httpsAgent, metaMap).
 */
export function createBareServer(directory: string, init: BareServerInit = {}) {
	if (typeof directory !== 'string')
		throw new Error('Directory must be specified.');
	if (!directory.startsWith('/') || !directory.endsWith('/'))
		throw new RangeError('Directory must start and end with /');
	init.logErrors ??= false;

	const cleanup: (() => void)[] = [];

	if (typeof init.family === 'number' && !validIPFamily.includes(init.family))
		throw new RangeError('init.family must be one of: 0, 4, 6');

	if (init.blockLocal ?? true) {
		init.filterRemote ??= (url) => {
			// if the remote is an IP then it didn't go through the init.lookup hook
			// isValid determines if this is so
			if (isValid(url.hostname) && parse(url.hostname).range() !== 'unicast')
				throw new RangeError('Forbidden IP');
		};

		init.lookup ??= (hostname, options, callback) =>
			lookup(hostname, options, (err, address, family) => {
				if (
					address &&
					toAddressArray(address, family).some(
						({ address }) => parse(address).range() !== 'unicast',
					)
				)
					callback(new RangeError('Forbidden IP'), '', -1);
				else callback(err, address, family);
			});
	}

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
		wss: new WebSocketServer({ noServer: true }),
	});

	init.legacySupport ??= true;

	if (init.legacySupport) {
		registerV1(server);
		registerV2(server);
	}

	registerV3(server);

	server.once('close', () => {
		for (const cb of cleanup) cb();
	});

	return server;
}
