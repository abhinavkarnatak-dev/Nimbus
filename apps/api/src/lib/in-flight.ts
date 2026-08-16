export class InFlight {
  #current: Promise<void> | null = null;

  #closed = false;

  get busy(): boolean {
    return this.#current !== null;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async run<T>(work: () => Promise<T>): Promise<T | null> {
    if (this.#closed || this.#current !== null) {
      return null;
    }

    const running = work();

    const clear = (): void => {
      this.#current = null;
    };

    this.#current = running.then(clear, clear);
    return running;
  }

  async settle(): Promise<void> {
    this.#closed = true;

    while (this.#current !== null) {
      await this.#current;
    }
  }
}
