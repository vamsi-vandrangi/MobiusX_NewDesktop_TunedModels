export { chunkSource } from "./chunker.js";
export type { Chunk, ChunkKind } from "./chunker.js";
export { languageForFile, supportedExtensions } from "./languages.js";
export type { LanguageConfig } from "./languages.js";
export {
  generateWorkspaceKey,
  obfuscatePath,
  deobfuscatePath,
  type WorkspaceKey,
} from "./obfuscate.js";
export { loadOrCreateWorkspaceKey } from "./workspace-key.js";
export type { EmbeddingProvider } from "./embeddings/provider.js";
export { cosineSimilarity } from "./embeddings/provider.js";
export { HashingEmbeddingProvider } from "./embeddings/hashing.js";
export { OllamaEmbeddingProvider } from "./embeddings/ollama.js";
export { VectorStore, type VectorRecord, type SearchHit } from "./vector-store.js";
export { buildIndex, queryIndex } from "./query.js";
export type { BuildOptions, BuildStats, QueryOptions, QueryHit, QueryResult } from "./query.js";
