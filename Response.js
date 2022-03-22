import { OutgoingMessage } from 'node:http';
import Stream from 'node:stream';
import { Headers } from 'fetch-headers';
export { Headers } from 'fetch-headers';

export default class Response {
	constructor(body, status, headers){
		this.body = body;
		
		if(typeof status === 'number'){
			this.status = status;
		}else{
			this.status = 200;
		}
		
		if(headers instanceof Headers){
			this.headers = new Headers(headers);
		}else{
			this.headers = new Headers();
		}
	}
	send(response){
		if(!(response instanceof OutgoingMessage))throw new TypeError('Request must be an OutgoingMessage');


		for(let [ header, value ] of this.headers){
			response.setHeader(header, value);
		}

		response.writeHead(this.status);
		
		if(this.body instanceof Stream){
			this.body.pipe(response);
		}else if(this.body instanceof Buffer){
			response.write(this.body);
			response.end();
		}else{
			response.end();
		}

		return true;
	}
};