import type { EmbeddingsInterface } from "@langchain/core/embeddings";

/** Deterministic fake embeddings: each text maps to a fixed-size vector derived from its length. */
export class FakeEmbeddings implements EmbeddingsInterface {
  constructor(private readonly size = 4) {}

  async embedDocuments(documents: string[]): Promise<number[][]> {
    return documents.map((doc) => this.vectorFor(doc));
  }

  async embedQuery(document: string): Promise<number[]> {
    return this.vectorFor(document);
  }

  private vectorFor(text: string): number[] {
    return Array.from({ length: this.size }, (_, i) => (text.length + i) / 10);
  }
}
