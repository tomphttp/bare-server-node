/**
 * Relational string database
 */
export interface Database {
	get(key: string): Promise<string | void> | string | void;
	set(key: string, value: string): Promise<void> | void;
	delete(key: string): Promise<boolean> | boolean;
	has(key: string): Promise<boolean> | boolean;
	keys(): Promise<string[]> | string[];
}

export class MemoryDatabase implements Database {
	#data = new Map();
	get(key: string) {
		return this.#data.get(key);
	}
	has(key: string) {
		return this.#data.has(key);
	}
	set(key: string, value: string) {
		this.#data.set(key, value);
	}
	delete(key: string) {
		return this.#data.delete(key);
	}
	keys() {
		return [...this.#data.keys()];
	}
}
