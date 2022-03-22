/** @constant
    @type {number}
    @default
*/
const MAX_HEADER_VALUE = 3072;
// ,header,id
const split_header = /^(x-bare-\w+)-(\d+)$/;

/**
 * 
 * @typedef {object} ErrorResult
 * @property {{message:string,code:string,id:string}} error
*/

/**
 * @description Splits headers over the length MAX_HEADER_VALUE
 * @param {Object.<string>} headers 
 * @returns {ErrorResult|{}}
 */
export function split_headers(headers){
	const state = {...headers};

	for(let header in state){
		if(!header.startsWith('x-bare-')){
			continue;
		}

		const value = state[header];

		if(value.length < MAX_HEADER_VALUE){
			continue;
		}

		let split = 0;

		for(let i = 0; i < value.length; i += MAX_HEADER_VALUE){
			const part = value.slice(i, i + MAX_HEADER_VALUE);
		
			const id = split++;
			let name = header;

			if(id !== 0){
				name += `-${id}`
			}

			headers[name] = part;
		}
	}

	return {};
}

/**
 * @description Joins headers in object, according to spec
 * @param {Object.<string>} headers 
 * @returns {ErrorResult|{}}
 */
export function join_headers(headers){
	const join_headers = {};
	const state = {...headers};

	for(let header in state){
		if(!header.startsWith('x-bare-')){
			continue;
		}

		const value = state[header];

		if(value.length > MAX_HEADER_VALUE){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.${header}`,
					message: `Length for bare header exceeds the limit. (${value.length} > ${MAX_HEADER_VALUE})`,
				},
			};
		}

		const match = header.match(split_header);

		if(!match){
			continue;
		}
	
		let [,target,id] = match;

		id = parseInt(id);

		if(isNaN(id) || id === 0){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.${header}`,
					message: `Split ID was not a number or 0.`,
				},
			};
		}

		if(!(target in headers)){
			return {
				error: {
					code: 'INVALID_BARE_HEADER',
					id: `request.headers.${header}`,
					message: `Target header doesn't have an initial value.`,
				},
			};
		}

		if(!(target in join_headers)){
			join_headers[target] = [ headers[target] ];
		}

		join_headers[target][id] = value;

		delete headers[header];

		for(let header in join_headers){
			headers[header] = join_headers[header].join('');
		}
	}

	return {};
}