export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();
  async run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.#tails.set(key, gate);
    await previous;
    try { return await operation(); }
    finally {
      release();
      if (this.#tails.get(key) === gate) this.#tails.delete(key);
    }
  }
}
