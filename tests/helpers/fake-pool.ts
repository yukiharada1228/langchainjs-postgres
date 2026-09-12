export interface RecordedQuery {
  text: string;
  values?: unknown[];
}

export type QueryHandler = (
  text: string,
  values?: unknown[],
) => { rows: any[] };

/** A handler that only cares about some queries, falling through for the rest. */
export type PartialQueryHandler = (
  text: string,
  values?: unknown[],
) => { rows: any[] } | undefined;

/** Minimal `pg.Pool`-compatible fake that records every query it receives. */
export class FakePool {
  calls: RecordedQuery[] = [];

  private handler: QueryHandler;

  constructor(handler: QueryHandler = () => ({ rows: [] })) {
    this.handler = handler;
  }

  setHandler(handler: QueryHandler): void {
    this.handler = handler;
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: any[] }> {
    this.calls.push({ text, values });
    return this.handler(text, values);
  }

  async connect() {
    return {
      query: (text: string, values?: unknown[]) => this.query(text, values),
      release: () => {},
    };
  }

  async end(): Promise<void> {}
}
