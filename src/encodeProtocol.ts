const validChars =
	"!#$%&'*+-.0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ^_`abcdefghijklmnopqrstuvwxyz|~";
const reserveChar = '%';

export function validProtocol(protocol: string): boolean {
	for (let i = 0; i < protocol.length; i++) {
		const char = protocol[i];

		if (!validChars.includes(char)) {
			return false;
		}
	}

	return true;
}

export function encodeProtocol(protocol: string): string {
	let result = '';

	for (let i = 0; i < protocol.length; i++) {
		const char = protocol[i];

		if (validChars.includes(char) && char !== reserveChar) {
			result += char;
		} else {
			const code = char.charCodeAt(0);
			result += reserveChar + code.toString(16).padStart(2, '0');
		}
	}

	return result;
}

export function decodeProtocol(protocol: string): string {
	let result = '';

	for (let i = 0; i < protocol.length; i++) {
		const char = protocol[i];

		if (char === reserveChar) {
			const code = parseInt(protocol.slice(i + 1, i + 3), 16);
			const decoded = String.fromCharCode(code);

			result += decoded;
			i += 2;
		} else {
			result += char;
		}
	}

	return result;
}
