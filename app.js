import { Command, Option } from 'commander';
import server from './cli/server.js';

const program = new Command();

program
.command('server')
.addOption(new Option('--d, --directory <string>', 'Bare directory').default('/'))
.addOption(new Option('--h, --host <string>', 'Listening host').default('localhost'))
.addOption(new Option('--p, --port <number>', 'Listening port').default(80).env('PORT'))
.addOption(new Option('--e, --errors', 'Error logging').default(false))
.action(server)
;

program.parse(process.argv);