import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { extname } from "node:path";

// tree-sitter-wasms ships prebuilt grammar binaries — no native compile, no
// emscripten toolchain needed locally, unlike the native `tree-sitter`
// bindings. Deliberate choice given Phase 0's native-module build pain.
const WASM_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "node_modules",
  "tree-sitter-wasms",
  "out",
);

export interface LanguageConfig {
  name: string;
  wasmPath: string;
}

const EXT_TO_LANGUAGE: Record<string, LanguageConfig> = {
  ".ts": { name: "typescript", wasmPath: join(WASM_DIR, "tree-sitter-typescript.wasm") },
  ".tsx": { name: "tsx", wasmPath: join(WASM_DIR, "tree-sitter-tsx.wasm") },
  ".js": { name: "javascript", wasmPath: join(WASM_DIR, "tree-sitter-javascript.wasm") },
  ".jsx": { name: "javascript", wasmPath: join(WASM_DIR, "tree-sitter-javascript.wasm") },
  ".mjs": { name: "javascript", wasmPath: join(WASM_DIR, "tree-sitter-javascript.wasm") },
  ".py": { name: "python", wasmPath: join(WASM_DIR, "tree-sitter-python.wasm") },
};

export function languageForFile(relPath: string): LanguageConfig | undefined {
  return EXT_TO_LANGUAGE[extname(relPath).toLowerCase()];
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_TO_LANGUAGE);
}
