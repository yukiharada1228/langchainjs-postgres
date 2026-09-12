import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresChatMessageHistory } from "../../src/chat_message_history.js";
import { randomTableName, requireDatabaseUrl } from "./helpers.js";

describe("PostgresChatMessageHistory (integration, real Postgres)", () => {
  const tableName = randomTableName("it_chat");
  const pool = new Pool({ connectionString: requireDatabaseUrl() });

  beforeAll(async () => {
    await PostgresChatMessageHistory.createTables(pool, tableName);
  });

  afterAll(async () => {
    await PostgresChatMessageHistory.dropTable(pool, tableName);
    await pool.end();
  });

  it("persists and retrieves messages for a session", async () => {
    const sessionId = randomUUID();
    const history = new PostgresChatMessageHistory({
      tableName,
      sessionId,
      pool,
    });

    await history.addUserMessage("Hello");
    await history.addAIMessage("Hi there");

    const messages = await history.getMessages();
    expect(messages.map((m) => m.content)).toEqual(["Hello", "Hi there"]);

    await history.clear();
    expect(await history.getMessages()).toHaveLength(0);
  });

  it("scopes messages per session id", async () => {
    const sessionA = randomUUID();
    const sessionB = randomUUID();
    const historyA = new PostgresChatMessageHistory({
      tableName,
      sessionId: sessionA,
      pool,
    });
    const historyB = new PostgresChatMessageHistory({
      tableName,
      sessionId: sessionB,
      pool,
    });

    await historyA.addUserMessage("A message");
    await historyB.addUserMessage("B message");

    expect((await historyA.getMessages()).map((m) => m.content)).toEqual([
      "A message",
    ]);
    expect((await historyB.getMessages()).map((m) => m.content)).toEqual([
      "B message",
    ]);
  });
});
