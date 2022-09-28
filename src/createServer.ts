import BareServer from './BareServer.js';
import type { ServerConfig } from './BareServer.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';

export = function createBareServer(
	directory: string,
	init: Partial<ServerConfig> = {}
) {
	const server = new BareServer(directory, init);
	registerV1(server);
	registerV2(server);
	return server;
};
