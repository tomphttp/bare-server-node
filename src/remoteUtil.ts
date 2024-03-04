/*
 * Utilities for converting remotes to URLs
 */

export interface BareRemote {
	host: string;
	port: number | string;
	path: string;
	protocol: string;
}

export function remoteToURL(remote: BareRemote) {
	return new URL(
		`${remote.protocol}${remote.host}:${remote.port}${remote.path}`,
	);
}

export function resolvePort(url: URL) {
	if (url.port) return Number(url.port);

	switch (url.protocol) {
		case 'ws:':
		case 'http:':
			return 80;
		case 'wss:':
		case 'https:':
			return 443;
		default:
			// maybe blob
			return 0;
	}
}

export function urlToRemote(url: URL) {
	return {
		protocol: url.protocol,
		host: url.hostname,
		port: resolvePort(url),
		path: url.pathname + url.search,
	} as BareRemote;
}
