import BareServer from './BareServer.js';
import type { ServerConfig } from './BareServer.js';
import type { Database } from './Database.js';
import { MemoryDatabase } from './Database.js';
import registerV1 from './V1.js';
import registerV2 from './V2.js';

export = function createBareServer(
	directory: string,
	init: Partial<ServerConfig> = {},
	database: Database = new MemoryDatabase()
) {
	init.logErrors ??= false;
	const server = new BareServer(directory, init as ServerConfig);
	registerV1(server, database);
	registerV2(server, database);
	return server;
};
