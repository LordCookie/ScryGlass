/**
 * Zeilenweiser NDJSON-Puffer (PLAN.md E2, § 4). Pur & testbar: nimmt Text-Chunks
 * (wie sie ein `ReadableStream` liefert) und gibt komplette geparste Zeilen zurück.
 * Eine Zeile darf über Chunk-Grenzen hinweg gehen — dafür der interne Puffer.
 */
export class NdjsonBuffer<T = unknown> {
  private buf = '';

  /** Chunk anhängen; gibt alle jetzt vollständigen Zeilen geparst zurück. */
  push(chunk: string): T[] {
    this.buf += chunk;
    const out: T[] = [];
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (line) out.push(JSON.parse(line) as T);
    }
    return out;
  }

  /** Rest am Ende (Datei ohne abschließendes \n). */
  flush(): T[] {
    const line = this.buf.trim();
    this.buf = '';
    return line ? [JSON.parse(line) as T] : [];
  }
}
