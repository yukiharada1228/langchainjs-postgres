import {
  PGEngine,
  PGVectorStore,
  PostgresChatMessageHistory,
} from "@yukiharada1228/langchain-postgres";
import type { EmbeddingsInterface } from "@langchain/core/embeddings";

const engine = PGEngine.fromConnectionString("postgres://localhost/example");
const embeddings: EmbeddingsInterface = {
  embedDocuments: async (documents) => documents.map(() => [1, 0, 0]),
  embedQuery: async () => [1, 0, 0],
};
const store: Promise<PGVectorStore> = PGVectorStore.initialize(
  engine,
  embeddings,
  "documents",
);

export { engine, store, PostgresChatMessageHistory };
