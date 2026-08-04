/**
 * A `Map` that forgets its least recently used entry once it is full.
 *
 * LRU rather than insert-order because the entries that matter are the ones
 * being re-read; `Map` already iterates in insertion order, so re-setting on a
 * hit is enough to maintain recency.
 */
export class BoundedMap<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #limit: number;

  constructor(limit: number) {
    if (limit < 1) {
      throw new Error("A bounded cache needs room for at least one entry.");
    }

    this.#limit = limit;
  }

  get size(): number {
    return this.#entries.size;
  }

  get(key: K): V | undefined {
    const value = this.#entries.get(key);

    if (value === undefined) {
      return;
    }

    this.#entries.delete(key);
    this.#entries.set(key, value);

    return value;
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    this.#entries.delete(key);
    this.#entries.set(key, value);

    if (this.#entries.size <= this.#limit) {
      return;
    }

    const oldest = this.#entries.keys().next();

    if (!oldest.done) {
      this.#entries.delete(oldest.value);
    }
  }

  delete(key: K): void {
    this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }
}
