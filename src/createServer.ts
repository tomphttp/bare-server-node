import BareServer, { ServerConfig } from './Server.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';

export default function createBareServer(
	directory: string,
	init: Partial<ServerConfig> = {}
) {
	const server = new BareServer(directory, init);
	registerV1(server);
	registerV2(server);
	return server;
}
