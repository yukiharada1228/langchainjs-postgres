# langchainjs-postgres

[![npm version](https://img.shields.io/npm/v/%40yukiharada1228%2Flangchain-postgres.svg)](https://www.npmjs.com/package/@yukiharada1228/langchain-postgres)
[![CI](https://github.com/yukiharada1228/langchainjs-postgres/actions/workflows/ci.yml/badge.svg)](https://github.com/yukiharada1228/langchainjs-postgres/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

An **unofficial** [LangChain.js](https://github.com/langchain-ai/langchainjs) port of
[`langchain-postgres`](https://github.com/langchain-ai/langchain-postgres) — implementations
of core LangChain abstractions using Postgres / [pgvector](https://github.com/pgvector/pgvector),
hand-translated from Python to TypeScript.

> [!NOTE]
> Not affiliated with or endorsed by LangChain. If you want the official, first-party Postgres
> integration for LangChain.js, see
> [`@langchain/community`](https://www.npmjs.com/package/@langchain/community).

The package is released under the MIT license. Feel free to use the abstractions as provided,
or modify / extend them as appropriate for your own application.

## Requirements

- Node.js >= 20
- Postgres with the [`pgvector`](https://github.com/pgvector/pgvector) extension available
  (`CREATE EXTENSION IF NOT EXISTS vector` is run automatically by `initVectorstoreTable`)
- [`pg`](https://www.npmjs.com/package/pg) (`node-postgres`) as the driver

## Installation

You can use npm, pnpm, or yarn to install `langchainjs-postgres`:

`npm install @yukiharada1228/langchain-postgres @langchain/core pg`

`pnpm add @yukiharada1228/langchain-postgres @langchain/core pg`

`yarn add @yukiharada1228/langchain-postgres @langchain/core pg`

## Vectorstore

> [!WARNING]
> `PGVector` is a straight port of upstream's deprecated collection/embedding-table schema.
> Prefer `PGVectorStore` below for new projects — it's faster and easier to manage. See
> [Legacy `PGVector`](#legacy-pgvector) for migrating an existing schema.

### Documentation

- [Example](#example) — minimal quickstart below
- [Integration tests](tests/integration) — runnable examples against a real Postgres +
  pgvector instance

> [!TIP]
> For developing, debugging, and deploying AI agents and LLM applications, see
> [LangSmith](https://docs.langchain.com/langsmith/home).

### Example

```typescript
import { PGEngine, PGVectorStore } from "@yukiharada1228/langchain-postgres";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";

const engine = PGEngine.fromConnectionString(process.env.DATABASE_URL!);

await engine.initVectorstoreTable("documents", 1536, {
  metadataColumns: [{ name: "category", dataType: "TEXT" }],
});

const vectorStore = await PGVectorStore.initialize(
  engine,
  new OpenAIEmbeddings(),
  "documents",
  {
    metadataColumns: ["category"],
  },
);

await vectorStore.addDocuments([
  new Document({
    pageContent: "pgvector stores embeddings in Postgres.",
    metadata: { category: "docs" },
  }),
]);

const results = await vectorStore.similaritySearch(
  "How are embeddings stored?",
  4,
  {
    category: "docs",
  },
);

await engine.close();
```

> [!TIP]
> Since JavaScript has no sync/async split, the Python package's separate `PGVectorStore` /
> `AsyncPGVectorStore` classes are collapsed into a single, always-async `PGVectorStore` —
> every method here works the way any other LangChain.js vector store does
> (`similaritySearch`, `addDocuments`, `delete`, ...), no `a`-prefixed method names.

### Metadata filters

`similaritySearch`, `similaritySearchWithScore`, `delete`, and `get` all accept a Mongo-style
filter object:

```typescript
await vectorStore.similaritySearch("query", 4, {
  $and: [{ category: "docs" }, { "author.age": { $gt: 30 } }],
});
```

Supported operators: `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`, `$in`, `$nin`, `$between`,
`$exists`, `$like`, `$ilike`, `$and`, `$or`, `$not`.

### Hybrid Search with `PGVectorStore`

With `PGVectorStore` you can use hybrid (dense + sparse/full-text) search for more
comprehensive and relevant search results.

```typescript
import {
  HybridSearchConfig,
  reciprocalRankFusion,
} from "@yukiharada1228/langchain-postgres";

const vectorStore = await PGVectorStore.initialize(
  engine,
  embeddings,
  "documents",
  {
    hybridSearchConfig: new HybridSearchConfig({
      fusionFunction: reciprocalRankFusion,
    }),
  },
);

await vectorStore.applyHybridSearchIndex();
const hybridDocs = await vectorStore.similaritySearch("products", 5);
```

### Vector indexes

```typescript
import { HNSWIndex } from "@yukiharada1228/langchain-postgres";

await vectorStore.applyVectorIndex(
  new HNSWIndex({ m: 16, efConstruction: 64 }),
);
```

### Legacy `PGVector`

For parity with the original `langchain_pg_collection` / `langchain_pg_embedding` schema:

```typescript
import { PGVector } from "@yukiharada1228/langchain-postgres";

const store = await PGVector.initialize(engine, embeddings, {
  collectionName: "my-collection",
});
```

Use `migratePgvectorCollection(engine, "my-collection", newStore)` to move data from a legacy
collection into a `PGVectorStore` table.

## ChatMessageHistory

The chat message history abstraction helps persist chat message history in a Postgres table.

`PostgresChatMessageHistory` is parameterized using a `tableName` and a `sessionId`.

The `tableName` is the name of the table in the database where the chat messages will be
stored.

The `sessionId` is a unique identifier for the chat session. It can be assigned by the caller
using `crypto.randomUUID()`.

```typescript
import { Pool } from "pg";
import { PostgresChatMessageHistory } from "@yukiharada1228/langchain-postgres";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Create the table schema (only needs to be done once)
await PostgresChatMessageHistory.createTables(pool, "chat_history");

const history = new PostgresChatMessageHistory({
  tableName: "chat_history",
  sessionId: crypto.randomUUID(),
  pool,
});

await history.addUserMessage("Hello!");
console.log(await history.getMessages());
```

## What's included

| Export                                                             | Ported from (Python)                                                   | Purpose                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `PGEngine`                                                         | `langchain_postgres.v2.engine.PGEngine`                                | Connection pool + table setup (`initVectorstoreTable`)                    |
| `PGVectorStore`                                                    | `langchain_postgres.v2.async_vectorstore.AsyncPGVectorStore`           | Modern, per-table vector store (metadata filters, hybrid search, indexes) |
| `PostgresChatMessageHistory`                                       | `langchain_postgres.chat_message_histories.PostgresChatMessageHistory` | Chat history backed by a simple `(session_id, message)` table             |
| `PGVector`                                                         | `langchain_postgres.vectorstores.PGVector`                             | Legacy collection/embedding-table vector store                            |
| `PGVectorTranslator`                                               | `langchain_postgres.translator.PGVectorTranslator`                     | Self-query retriever filter translator                                    |
| `HNSWIndex`, `IVFFlatIndex`, `ExactNearestNeighbor`, ...           | `langchain_postgres.v2.indexes`                                        | Vector index management                                                   |
| `HybridSearchConfig`, `weightedSumRanking`, `reciprocalRankFusion` | `langchain_postgres.v2.hybrid_search_config`                           | Dense + sparse (full-text) hybrid search                                  |
| `migratePgvectorCollection`, `listPgvectorCollectionNames`         | `langchain_postgres.utils.pgvector_migrator`                           | Migrate data from the legacy `PGVector` schema to `PGVectorStore`         |

### Known gaps vs. upstream

- No support for embedding providers with an `embed_query_inline` DB-side embedding hook
  (an AlloyDB-specific optimization in the Python package).
- The self-query translator only supports the comparators `@langchain/core`'s structured-query
  IR defines (`eq`/`ne`/`lt`/`gt`/`lte`/`gte`); Python's IR additionally has `in`/`nin`/`contain`/`like`.
- `migratePgvectorCollection` inserts batch-by-batch sequentially instead of with bounded
  concurrency.

These (and any newly-introduced upstream behavior) are tracked via the upstream-sync workflow
described below.

## Development

```bash
npm install
npm run build       # tsup -> dist/
npm test            # vitest (unit tests against a mocked pg.Pool, no DB required)
npm run typecheck
npm run lint
```

### Integration tests

`tests/integration/` runs the same code paths against a real Postgres + pgvector instance
(no mocking). It requires `DATABASE_URL` and is not part of `npm test`:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration
```

CI runs this automatically against a `pgvector/pgvector:pg17` service container.

## Staying in sync with upstream

This package tracks [`langchain-ai/langchain-postgres`](https://github.com/langchain-ai/langchain-postgres)
(Python) as a git submodule at [`upstream/langchain-postgres`](upstream/langchain-postgres),
pinned to the commit this port was last synced against. Since porting Python to TypeScript
can't be automated, a daily [GitHub Actions workflow](.github/workflows/upstream-sync.yml)
compares the pinned commit against upstream's latest commit and, when
`langchain_postgres/` has changed, opens (or refreshes) a tracking issue labeled `upstream`
summarizing what moved. You can also run the check manually:

```bash
git submodule update --init --recursive
npm run diff:upstream
```
