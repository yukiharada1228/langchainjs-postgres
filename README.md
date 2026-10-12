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

`npm install @yukiharada1228/langchain-postgres @langchain/core pg langsmith@0.10.9`

`pnpm add @yukiharada1228/langchain-postgres @langchain/core pg langsmith@0.10.9`

`yarn add @yukiharada1228/langchain-postgres @langchain/core pg langsmith@0.10.9`

Both ESM (`import`) and CommonJS (`require`) are supported, including their respective
TypeScript declarations with `Node16` and `NodeNext` module resolution.

LangSmith 0.10.10 and 0.10.11 ship incomplete `NullableHeaders` declarations. The package's
peer dependency excludes these releases; the commands above select 0.10.9 so strict
TypeScript consumers using `NodeNext` do not need `skipLibCheck`. When upgrading an existing project,
update its LangSmith dependency and lockfile as well. Revisit this constraint once an
upstream fix passes the package compatibility checks.

For `Node16` resolution, upstream LangChain/js-tiktoken and LangSmith declarations still
produce TS1479 when checking dependencies. Use `NodeNext` for full dependency checking,
or set `skipLibCheck: true` with `Node16`; consumer imports are checked in both modes.

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

### Database-side embeddings

Embedding providers can implement `embedQueryInlineTemplate(placeholder)` to compute
embeddings inside Postgres. It returns a trusted SQL expression using the supplied `$n`
placeholder; document and query text are passed separately as native `pg` parameters.
The query embedding expression is evaluated at most once per similarity search and reused
for ranking and scoring.
The SQL embedding function must already be available in your database. For example:

```typescript
import type { PGVectorStoreEmbeddings } from "@yukiharada1228/langchain-postgres";

const dbEmbeddings: PGVectorStoreEmbeddings = {
  embedDocuments: (texts) => embeddings.embedDocuments(texts),
  embedQuery: (text) => embeddings.embedQuery(text),
  embedQueryInlineTemplate: (placeholder) =>
    `embedding('model_id', ${placeholder})::vector`,
};

const store = await PGVectorStore.initialize(engine, dbEmbeddings, "documents");
```

`addDocuments`, `addTexts`, and text similarity searches use the inline hook instead of
calling the provider's client embedding methods. Explicit, non-empty vectors are used as
provided. Maximal marginal relevance search still uses `embedQuery` for its client-side
reranking step, matching upstream.

The legacy `embedQueryInline(text)` hook is no longer called because interpolating raw text
into SQL can allow SQL injection. Initialization (including `fromTexts` and `fromDocuments`)
rejects providers that expose this hook without a callable `embedQueryInlineTemplate`.
Upgrade your embedding provider or implement the template hook as shown above, using the
supplied placeholder rather than quoting or interpolating document/query text. Providers
with both hooks use only the template hook; ordinary `embedDocuments`/`embedQuery` providers
continue to work. These camelCase hook names correspond to upstream's
`embed_query_inline_template` and `embed_query_inline` methods.

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
npm run test:package # fresh npm pack install, ESM/CJS loading and strict TS 5.9/6 checks
```

### Integration tests

`tests/integration/` runs the same code paths against a real Postgres + pgvector instance
(no mocking). It requires `DATABASE_URL` and is not part of `npm test`:

```bash
docker run --rm -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres pgvector/pgvector:pg17
DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:integration
```

CI runs this automatically against a `pgvector/pgvector:pg17` service container.

With `DATABASE_URL` set, `npm run test:package` also checks the installed tarball's vector
CRUD, search, filters, indexes, legacy UUID generation, and chat persistence. CI runs
these checks on Node.js 20.0.0 and the latest Node.js 20, 22, 24, and 26 releases. Build
tools run on Node.js 24; `PACKAGE_NODE_VERSION=20.0.0 npm run test:package` selects a
different runtime for the installed package. This command requires network access to
resolve fresh consumer dependencies and the requested Node.js runtime.

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
