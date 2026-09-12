import { AIMessage, HumanMessage } from "@langchain/core/messages";
import { describe, expect, it } from "vitest";
import { PostgresChatMessageHistory } from "../src/chat_message_history.js";
import { FakePool } from "./helpers/fake-pool.js";

const SESSION_ID = "b1a0a2ac-4b8a-4c1e-9f0a-9a2e6b6c9b39";

describe("PostgresChatMessageHistory", () => {
  it("rejects a non-UUID session id", () => {
    const pool = new FakePool();
    expect(
      () => new PostgresChatMessageHistory({ tableName: "chat", sessionId: "not-a-uuid", pool }),
    ).toThrow(/must be a valid UUID/);
  });

  it("rejects an unsafe table name", () => {
    const pool = new FakePool();
    expect(
      () =>
        new PostgresChatMessageHistory({
          tableName: "chat; DROP TABLE users;",
          sessionId: SESSION_ID,
          pool,
        }),
    ).toThrow(/alphanumeric characters and underscores/);
  });

  it("createTables issues CREATE TABLE and CREATE INDEX statements", async () => {
    const pool = new FakePool();
    await PostgresChatMessageHistory.createTables(pool, "chat_history");
    expect(pool.calls[0].text).toContain("CREATE TABLE IF NOT EXISTS");
    expect(pool.calls[0].text).toContain('"chat_history"');
    expect(pool.calls[1].text).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("addMessages inserts one row per message scoped to the session", async () => {
    const pool = new FakePool();
    const history = new PostgresChatMessageHistory({
      tableName: "chat_history",
      sessionId: SESSION_ID,
      pool,
    });

    await history.addMessages([new HumanMessage("hi"), new AIMessage("hello")]);

    const insertCall = pool.calls.find((c) => c.text.startsWith("INSERT INTO"))!;
    expect(insertCall.text).toContain("VALUES ($1, $2), ($3, $4)");
    expect(insertCall.values?.[0]).toBe(SESSION_ID);
    expect(JSON.parse(insertCall.values?.[1] as string).data.content).toBe("hi");
    expect(insertCall.values?.[2]).toBe(SESSION_ID);
    expect(JSON.parse(insertCall.values?.[3] as string).data.content).toBe("hello");
  });

  it("getMessages deserializes stored rows back into BaseMessage instances", async () => {
    const pool = new FakePool((text) => {
      if (text.startsWith("SELECT")) {
        return {
          rows: [
            { message: { type: "human", data: { content: "hi", additional_kwargs: {} } } },
            { message: { type: "ai", data: { content: "hello", additional_kwargs: {} } } },
          ],
        };
      }
      return { rows: [] };
    });
    const history = new PostgresChatMessageHistory({
      tableName: "chat_history",
      sessionId: SESSION_ID,
      pool,
    });

    const messages = await history.getMessages();

    expect(messages).toHaveLength(2);
    expect(messages[0]).toBeInstanceOf(HumanMessage);
    expect(messages[0].content).toBe("hi");
    expect(messages[1]).toBeInstanceOf(AIMessage);
  });

  it("clear deletes rows scoped to the session id", async () => {
    const pool = new FakePool();
    const history = new PostgresChatMessageHistory({
      tableName: "chat_history",
      sessionId: SESSION_ID,
      pool,
    });

    await history.clear();

    expect(pool.calls[0].text).toContain("DELETE FROM");
    expect(pool.calls[0].values).toEqual([SESSION_ID]);
  });
});
