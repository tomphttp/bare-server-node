import BareServer, { ServerConfig } from './BareServer';
import registerV1 from './V1';
import registerV2 from './V2';

export default function createServer(
	directory: string,
	init: Partial<ServerConfig> = {}
) {
	const server = new BareServer(directory, init);
	registerV1(server);
	registerV2(server);
	return server;
}
