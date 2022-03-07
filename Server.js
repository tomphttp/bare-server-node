import register from './V1.js';
import Response from './Response.js';

export default class Server {
	prefix = '/';
	fof = this.json(404, { message: 'Not found.' });
	maintainer = undefined;
	project = {
		name: 'TOMPHTTP NodeJS Bare Server',
		repository: 'https://github.com/tomphttp/bare-server-node',
	};
	log_errors = false;
	local_address = undefined;
	routes = new Map();
	socket_routes = new Map();
	constructor(directory, log_errors, local_address, maintainer){
		if(log_errors === true){
			this.log_errors = true;
		}

		if(typeof local_address === 'string'){
			this.local_address = local_address;
		}

		if(typeof maintainer === 'object' && maintainer === null){
			this.maintainer = maintainer;
		}

		if(typeof directory !== 'string'){
			throw new Error('Directory must be specified.')
		}

		if(!directory.startsWith('/') || !directory.endsWith('/')){
			throw new RangeError('Directory must start and end with /');
		}

		this.directory = directory;
		
		this.routes.set('/', () => {
			return this.json(200, this.instance_info);
		});
		
		register(this);
	}
	error(...args){
		if(this.log_errors){
			console.error(...args);
		}
	}
	json(status, json){
		const send = Buffer.from(JSON.stringify(json, null, '\t'));

		return new Response(send, status, {
			'content-type': 'application/json',
			'content-length': send.byteLength,
		});
	}
	route_request(request, response){
		if(request.url.startsWith(this.directory)){
			this.request(request, response);
			return true;
		}else{
			return false;
		}
	}
	route_upgrade(request, socket, head){
		if(request.url.startsWith(this.directory)){
			this.upgrade(request, socket, head);
			return true;
		}else{
			return false;
		}
	}
	get instance_info(){
		return {
			versions: [ 'v1' ],
			language: 'NodeJS',
			memoryUsage: Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100,
			maintainer: this.maintainer,
			developer: this.project,
		};
	}
	async upgrade(request, socket, head){
		const service = request.url.slice(this.directory.length - 1);
		
		if(this.routes.has(service)){
			const call = this.socket_routes.get(service);

			try{
				await call(this, request, socket, head);
			}catch(error){
				this.error(error);
				socket.end();
			}
		}else{
			socket.end();
		}
	}
	async request(server_request, server_response){
		const service = server_request.url.slice(this.directory.length - 1);
		let response;

		if(this.routes.has(service)){
			const call = this.routes.get(service);

			try{
				response = await call(this, server_request);
			}catch(error){
				this.error(error);
				
				if(error instanceof Error){
					response = this.json(500, {
						code: 'UNKNOWN',
						id: `error.${error.name}`,
						message: error.message,
						stack: error.stack,
					});
				}else{
					response = this.json(500, {
						code: 'UNKNOWN',
						id: 'error.Exception',
						message: error,
						stack: new Error(error).stack,
					});
				}
			}
		}else{
			response = this.fof;
		}

		if(!(response instanceof Response)){
			this.error('Data', server_request.url, 'was not a response.');
			response = this.fof;
		}
		
		response.headers['x-robots-tag'] = 'noindex';
		response.headers['access-control-allow-headers'] = '*';
		response.headers['access-control-allow-origin'] = '*';
		response.headers['access-control-expose-headers'] = '*';

		response.send(server_response);
	}
};