import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { HashingEmbeddingProvider, cosineSimilarity } from "@mobiusx/semantic-index";
import type { KnowledgeIndexStats, KnowledgeSearchHit, KnowledgeSource } from "@mobiusx/protocol";

/**
 * Enterprise Knowledge / Global Intelligence local substitute (roadmap
 * Phase 17, source requirement §29/§30) -- see KnowledgeSource's doc
 * comment in @mobiusx/protocol for why this is deliberately global (spans
 * projects) rather than living under one project's own .mobiusx/. MobiusX
 * Cloud's real EK/GI backends don't exist to integrate against yet (the
 * roadmap's own "genuinely blocked" note) -- this indexes the user's OWN
 * real doc folders (an internal wiki export, ADRs, coding standards,
 * whatever markdown/text they point it at) using the same lexical
 * embedding math @mobiusx/semantic-index already uses for code
 * (HashingEmbeddingProvider -- a real feature-hashing bag-of-tokens
 * vectorizer, not a placeholder), so search results are genuinely
 * relevance-ranked, not just a substring grep.
 *
 * Unlike semantic-index's per-project code index, chunk TEXT is stored
 * directly in this store rather than re-read from disk at query time or
 * path-obfuscated -- there is no "never leaves this machine even if
 * synced" privacy design to preserve here (nothing here is ever synced
 * anywhere; @mobiusx/mcp-client and this module both only ever run
 * locally), and a knowledge doc is exactly the kind of content the user
 * explicitly chose to make searchable, unlike a project's proprietary
 * source code.
 */

const SETTINGS_DIR = process.env.MOBIUSX_SETTINGS_DIR ?? join(homedir(), ".mobiusx");
const SOURCES_FILE = join(SETTINGS_DIR, "knowledge-sources.json");
const KNOWLEDGE_DIR = join(SETTINGS_DIR, "knowledge");

const INDEXABLE_EXTENSIONS = new Set([".md", ".mdx", ".txt"]);
const IGNORED_DIR_NAMES = new Set(["node_modules", ".git", "dist", "build", ".mobiusx", ".mobiusx-index", ".next", ".venv", "__pycache__"]);
const MAX_FILE_BYTES = 1_000_000;
const MAX_FILES_PER_SOURCE = 3000;
const MAX_CHUNK_CHARS = 1200;

interface KnowledgeRecord {
  relPath: string;
  heading: string | null;
  text: string;
  vector: number[];
}

interface KnowledgeStoreFile {
  provider: string;
  builtAt: string;
  records: KnowledgeRecord[];
}

// ---- Sources (global, ~/.mobiusx/knowledge-sources.json) ----

export async function listKnowledgeSources(): Promise<KnowledgeSource[]> {
  try {
    const raw = await readFile(SOURCES_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as KnowledgeSource[]) : [];
  } catch {
    return [];
  }
}

async function writeSources(sources: KnowledgeSource[]): Promise<void> {
  await mkdir(SETTINGS_DIR, { recursive: true });
  await writeFile(SOURCES_FILE, JSON.stringify(sources, null, 2), "utf8");
}

export async function addKnowledgeSource(label: string, path: string): Promise<KnowledgeSource> {
  const st = await stat(path).catch(() => null);
  if (!st || !st.isDirectory()) {
    throw new Error(`"${path}" is not a directory on this machine`);
  }
  const sources = await listKnowledgeSources();
  const source: KnowledgeSource = { id: randomUUID(), label: label || path, path, addedAt: new Date().toISOString() };
  sources.push(source);
  await writeSources(sources);
  return source;
}

export async function removeKnowledgeSource(id: string): Promise<void> {
  const sources = await listKnowledgeSources();
  const next = sources.filter((s) => s.id !== id);
  await writeSources(next);
  await rm(join(KNOWLEDGE_DIR, id), { recursive: true, force: true });
}

// ---- Chunking ----

/**
 * Heading-scoped chunker: a real chunk boundary at every markdown heading
 * (so a search hit can say WHICH section it came from), further split by
 * a character cap so one giant section doesn't become one giant
 * unsearchable chunk. Deliberately simple — no claim of understanding
 * document structure beyond literal `#`-prefixed heading lines, matching
 * this codebase's existing "never pretend to understand more than was
 * actually parsed" stance (see projectContext.ts, dbOps.ts).
 */
function chunkMarkdown(text: string): { heading: string | null; text: string }[] {
  const lines = text.split(/\r?\n/);
  const chunks: { heading: string | null; text: string }[] = [];
  let currentHeading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    const joined = buffer.join("\n").trim();
    if (joined.length > 0) chunks.push({ heading: currentHeading, text: joined });
    buffer = [];
  };

  for (const line of lines) {
    const headingMatch = line.match(/^#{1,6}\s+(.*)/);
    if (headingMatch) {
      flush();
      currentHeading = headingMatch[1].trim();
    }
    buffer.push(line);
    if (buffer.join("\n").length > MAX_CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

async function walkFiles(root: string, dir: string, out: string[]): Promise<void> {
  if (out.length >= MAX_FILES_PER_SOURCE) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES_PER_SOURCE) return;
    if (entry.name.startsWith(".") && entry.name !== ".") continue;
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(entry.name)) continue;
      await walkFiles(root, abs, out);
    } else if (entry.isFile() && INDEXABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      out.push(abs);
    }
  }
}

// ---- Index build ----

/** Builds (from scratch — no incremental diffing, unlike semantic-index's Merkle-based reuse; a knowledge source is expected to be rebuilt occasionally by the user, not on every file save) the index for one source, or every source when `sourceId` is omitted. */
export async function buildKnowledgeIndex(sourceId?: string): Promise<KnowledgeIndexStats[]> {
  const sources = await listKnowledgeSources();
  const targets = sourceId ? sources.filter((s) => s.id === sourceId) : sources;
  const provider = new HashingEmbeddingProvider();
  const results: KnowledgeIndexStats[] = [];

  for (const source of targets) {
    const start = Date.now();
    const files: string[] = [];
    await walkFiles(source.path, source.path, files);

    const records: KnowledgeRecord[] = [];
    let filesIndexed = 0;
    for (const abs of files) {
      const st = await stat(abs).catch(() => null);
      if (!st || st.size > MAX_FILE_BYTES) continue;
      let content: string;
      try {
        content = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const chunks = chunkMarkdown(content);
      if (chunks.length === 0) continue;
      const vectors = await provider.embed(chunks.map((c) => c.text));
      const relPath = relative(source.path, abs);
      for (let i = 0; i < chunks.length; i++) {
        records.push({ relPath, heading: chunks[i]!.heading, text: chunks[i]!.text, vector: Array.from(vectors[i]!) });
      }
      filesIndexed++;
    }

    const storeDir = join(KNOWLEDGE_DIR, source.id);
    await mkdir(storeDir, { recursive: true });
    const store: KnowledgeStoreFile = { provider: provider.name, builtAt: new Date().toISOString(), records };
    await writeFile(join(storeDir, "vectors.json"), JSON.stringify(store), "utf8");

    results.push({
      sourceId: source.id,
      filesConsidered: files.length,
      filesIndexed,
      chunksIndexed: records.length,
      totalChunksInStore: records.length,
      durationMs: Date.now() - start,
    });
  }
  return results;
}

// ---- Search ----

export async function searchKnowledge(query: string, k: number): Promise<{ hits: KnowledgeSearchHit[]; durationMs: number }> {
  const start = Date.now();
  const sources = await listKnowledgeSources();
  if (sources.length === 0 || !query.trim()) return { hits: [], durationMs: Date.now() - start };

  const provider = new HashingEmbeddingProvider();
  const [queryVector] = await provider.embed([query]);

  const scored: { source: KnowledgeSource; record: KnowledgeRecord; score: number }[] = [];
  for (const source of sources) {
    let store: KnowledgeStoreFile;
    try {
      const raw = await readFile(join(KNOWLEDGE_DIR, source.id, "vectors.json"), "utf8");
      store = JSON.parse(raw);
    } catch {
      continue; // not indexed yet — silently skipped, not an error (GET /knowledge/sources tells the user which ones need building)
    }
    for (const record of store.records) {
      const score = cosineSimilarity(queryVector!, Float32Array.from(record.vector));
      scored.push({ source, record, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const hits: KnowledgeSearchHit[] = scored.slice(0, k).map(({ source, record, score }) => ({
    sourceId: source.id,
    sourceLabel: source.label,
    relPath: record.relPath,
    heading: record.heading,
    snippet: record.text.length > 500 ? `${record.text.slice(0, 500)}…` : record.text,
    score,
  }));

  return { hits, durationMs: Date.now() - start };
}
