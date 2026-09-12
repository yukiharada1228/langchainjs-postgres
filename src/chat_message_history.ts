/**
 * Chat message history backed by a Postgres table.
 *
 * Ported from `langchain_postgres.chat_message_histories.PostgresChatMessageHistory`
 * (Python). The Python client accepts either a sync or async `psycopg`
 * connection and exposes matching `a`-prefixed async methods; since
 * JavaScript only has async I/O, this port exposes a single async API that
 * accepts anything with a `pg`-compatible `query()` method (a `Pool`, a
 * checked-out `PoolClient`, or a plain `Client`).
 */
import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import {
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from "@langchain/core/messages";

/** Minimal `pg`-compatible connection surface (satisfied by `Pool`, `PoolClient`, and `Client`). */
export interface PostgresConnection {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createTableAndIndexSql(tableName: string): string[] {
  const indexName = `idx_${tableName}_session_id`;
  return [
    `CREATE TABLE IF NOT EXISTS "${tableName}" (
      id SERIAL PRIMARY KEY,
      session_id UUID NOT NULL,
      message JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );`,
    `CREATE INDEX IF NOT EXISTS "${indexName}" ON "${tableName}" (session_id);`,
  ];
}

function assertSafeTableName(tableName: string): void {
  if (!/^\w+$/.test(tableName)) {
    throw new Error(
      "Invalid table name. Table name must contain only alphanumeric characters and underscores.",
    );
  }
}

export interface PostgresChatMessageHistoryInput {
  /** Name of the database table to use. */
  tableName: string;
  /** Session ID to scope messages to. Must be a valid UUID. */
  sessionId: string;
  /** An existing `pg` `Pool`, `PoolClient`, or `Client`. */
  pool: PostgresConnection;
}

/**
 * Client for persisting chat message history in a Postgres database.
 *
 * The schema has the following columns:
 * - `id`: A serial primary key.
 * - `session_id`: The session ID for the chat message history.
 * - `message`: The JSONB message content.
 * - `created_at`: The timestamp of when the message was created (not
 *   returned by this interface, but available in the database).
 *
 * Use {@link PostgresChatMessageHistory.createTables} to set up the table
 * schema before first use.
 */
export class PostgresChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ["langchain", "stores", "message", "postgres"];

  private pool: PostgresConnection;

  private tableName: string;

  private sessionId: string;

  constructor(fields: PostgresChatMessageHistoryInput) {
    super();
    if (!UUID_RE.test(fields.sessionId)) {
      throw new Error(
        `Invalid session id. Session id must be a valid UUID. Got ${fields.sessionId}`,
      );
    }
    assertSafeTableName(fields.tableName);

    this.pool = fields.pool;
    this.tableName = fields.tableName;
    this.sessionId = fields.sessionId;
  }

  /** Create the table schema in the database and create relevant indexes. */
  static async createTables(
    connection: PostgresConnection,
    tableName: string,
  ): Promise<void> {
    assertSafeTableName(tableName);
    for (const query of createTableAndIndexSql(tableName)) {
      await connection.query(query);
    }
  }

  /**
   * Delete the table schema in the database.
   *
   * WARNING: This will delete the given table from the database including
   * all the data in the table and the schema of the table.
   */
  static async dropTable(
    connection: PostgresConnection,
    tableName: string,
  ): Promise<void> {
    assertSafeTableName(tableName);
    await connection.query(`DROP TABLE IF EXISTS "${tableName}";`);
  }

  async getMessages(): Promise<BaseMessage[]> {
    const result = await this.pool.query(
      `SELECT message FROM "${this.tableName}" WHERE session_id = $1 ORDER BY id;`,
      [this.sessionId],
    );
    return mapStoredMessagesToChatMessages(
      result.rows.map((row) => row.message),
    );
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.addMessages([message]);
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    if (messages.length === 0) return;

    const stored = mapChatMessagesToStoredMessages(messages);
    const params: unknown[] = [];
    const valuesSql = stored.map((message) => {
      params.push(this.sessionId, JSON.stringify(message));
      return `($${params.length - 1}, $${params.length})`;
    });

    await this.pool.query(
      `INSERT INTO "${this.tableName}" (session_id, message) VALUES ${valuesSql.join(", ")}`,
      params,
    );
  }

  async clear(): Promise<void> {
    await this.pool.query(
      `DELETE FROM "${this.tableName}" WHERE session_id = $1;`,
      [this.sessionId],
    );
  }
}
