import { SendSocket, SendBare } from './Send.mjs';

export class Server {
	prefix = '';
	constructor(config = {}){
		if(typeof config.prefix != 'string'){
			throw new Error('Prefix must be specified.')
		}

		this.prefix = config.prefix;
	}
	send_json(response, status, json){
		const send = Buffer.from(JSON.stringify(json));
		response.writeHead(status, { 
			'content-type': 'application/json',
			'content-length': send.byteLength,
		});
		
		// console.trace(json);

		response.end(send);
	}
	route_request(request, response){
		if(request.url.startsWith(this.prefix)){
			this.request(request, response);
			return true;
		}else{
			return false;
		}
	}
	route_upgrade(request, socket, head){
		if(request.url.startsWith(this.prefix)){
			this.upgrade(request, socket, head);
			return true;
		}else{
			return false;
		}
	}
	upgrade(request, socket, head){
		SendSocket(this, request, socket, head);
	}
	async request(request, response){
		let finished = false;

		response.on('finish', () => finished = true);
		
		response.on('error', error => {
			console.error(error);
		});

		try{
			return void await SendBare(this, request, response);
		}catch(err){
			setTimeout(async () => {
				console.error(err);
				if(!finished)return void await this.send_json(response, 400, {
					message: `TOMPServer encountered an exception while handling your request. Contact this server's administrator.`,
				});
			});
		}
	}
};