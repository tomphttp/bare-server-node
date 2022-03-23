/**
 * 
 * @typedef {object} ErrorResult
 * @property {{message:string,code:string,id:string}} error
*/

/** @constant
    @type {number}
    @default
*/
const MAX_HEADER_VALUE = 3072;
// ,header,id
const split_header = /^(x-bare-\w+)-(\d+)$/;

/**
 * 
 * @param {Headers} headers 
 */
export function split_headers(headers){
	if(headers.has('x-bare-headers')){
		const bare_headers = headers.get('x-bare-headers');

		if(bare_headers.length > MAX_HEADER_VALUE){
			headers.delete('x-bare-headers');

			let split = 0;

			for(let i = 0; i < value.length; i += MAX_HEADER_VALUE){
				const part = value.slice(i, i + MAX_HEADER_VALUE);
			
				const id = split++;
				headers.set(`x-bare-headers-${id}`, part);
			}
		}
	}
}

/**
 * @description Joins headers in object, according to spec
 * @param {Headers} headers 
 * @returns {ErrorResult|{}}
 */
export function join_headers(headers){
	const prefix = 'x-bare-headers';

	if(headers.has(`${prefix}-0`)){
		const join = [];

		for(let [ header, value ] of headers){
			if(!header.startsWith(prefix)){
				continue;
			}

			if(!value.startsWith(';')){
				return {
					error: {
						code: 'INVALID_BARE_HEADER',
						id: `request.headers.${header}`,
						message: `Value didn't begin with semi-colon.`,
					}
				};
			}

			value = value.slice(1);

			const id = parseInt(header.slice(prefix.length + 1));

			join[id] = value;

			headers.delete(header);
		}

		headers.set(prefix, join.join(''))
	}

	return {};
}