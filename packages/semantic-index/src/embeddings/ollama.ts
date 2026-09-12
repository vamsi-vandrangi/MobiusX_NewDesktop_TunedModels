// Real implementation of TDD §4.3's default embedding path — Ollama,
// on-device, code never leaving the machine for this step. NOT exercised
// against a live Ollama server in this session: this bridge's device_bash
// runs in a separate Linux VM from the Mac Ollama is installed on, and
// localhost:11434 from inside that VM connects to nothing (confirmed —
// connection refused, not a timeout). The HTTP request/response handling
// below is still unit-tested against a mocked fetch (test/ollama.test.ts),
// so what's unverified is specifically "can this reach a real Ollama", not
// "is this code correct" — worth keeping those two claims separate.
import type { EmbeddingProvider } from "./provider.js";

export interface OllamaOptions {
  baseUrl?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OllamaOptions = {}, knownDimensions = 768) {
    this.baseUrl = options.baseUrl ?? "http://localhost:11434";
    this.model = options.model ?? "nomic-embed-text";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.name = `ollama:${this.model}`;
    // Ollama doesn't advertise output dimensionality up front without an
    // extra /api/show round trip; callers that need it before the first
    // embed() call can pass it in (nomic-embed-text is 768-dim).
    this.dimensions = knownDimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const results: Float32Array[] = [];
    for (const text of texts) {
      results.push(await this.embedOne(text));
    }
    return results;
  }

  private async embedOne(text: string): Promise<Float32Array> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, prompt: text }),
    });

    if (!res.ok) {
      throw new Error(`Ollama embeddings request failed: ${res.status} ${res.statusText}`);
    }

    const body = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(body.embedding)) {
      throw new Error("Ollama embeddings response missing 'embedding' array");
    }

    return new Float32Array(body.embedding);
  }
}
