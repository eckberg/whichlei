// Postings: which entities hold which index terms. Terms are interned as they arrive, the
// (term, entity) pairs sit in two typed arrays, and `finish` groups them by term in sorted
// order with a counting sort. A reference index has about 30 million pairs and 4 million
// terms, too many for one JavaScript object per term.

export interface Postings {
  /** Every term, sorted by UTF-16 code unit. Terms are [a-z0-9], so that is byte order. */
  words: string[];
  /** The postings of words[i] are entities[start[i] .. start[i + 1]). */
  start: Int32Array;
  /** Entity numbers, grouped by word, ascending within each word. */
  entities: Int32Array;
}

export class PostingsBuilder {
  readonly #ids = new Map<string, number>();
  readonly #terms: string[] = [];
  #pairTerm = new Int32Array(1 << 20);
  #pairEntity = new Int32Array(1 << 20);
  #length = 0;

  /** Number of (term, entity) pairs so far. */
  get size(): number {
    return this.#length;
  }

  /**
   * Add the terms of one entity. Entities must arrive in ascending order, and a term must
   * not repeat within one call.
   */
  add(entity: number, terms: Iterable<string>): void {
    for (const term of terms) {
      let id = this.#ids.get(term);
      if (id === undefined) {
        id = this.#terms.length;
        this.#ids.set(term, id);
        this.#terms.push(term);
      }
      if (this.#length === this.#pairTerm.length) this.#grow();
      this.#pairTerm[this.#length] = id;
      this.#pairEntity[this.#length] = entity;
      this.#length++;
    }
  }

  #grow(): void {
    const size = this.#pairTerm.length * 2;
    const term = new Int32Array(size);
    const entity = new Int32Array(size);
    term.set(this.#pairTerm);
    entity.set(this.#pairEntity);
    this.#pairTerm = term;
    this.#pairEntity = entity;
  }

  /** Group the pairs by term. The builder is empty afterwards. */
  finish(): Postings {
    const words = [...this.#terms].sort();
    const rank = new Int32Array(words.length);
    words.forEach((word, i) => {
      rank[this.#ids.get(word) as number] = i;
    });
    this.#ids.clear();
    this.#terms.length = 0;

    const n = this.#length;
    const start = new Int32Array(words.length + 1);
    for (let i = 0; i < n; i++) {
      const slot = (rank[this.#pairTerm[i] as number] as number) + 1;
      start[slot] = (start[slot] as number) + 1;
    }
    for (let i = 0; i < words.length; i++) {
      start[i + 1] = (start[i + 1] as number) + (start[i] as number);
    }

    const next = start.slice(0, words.length);
    const entities = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rank[this.#pairTerm[i] as number] as number;
      entities[next[r] as number] = this.#pairEntity[i] as number;
      next[r] = (next[r] as number) + 1;
    }
    this.#pairTerm = new Int32Array(0);
    this.#pairEntity = new Int32Array(0);
    this.#length = 0;
    return { words, start, entities };
  }
}
