// web-tree-sitter's CJS build only populates the static `Parser.Language`
// property inside Parser.init()'s async callback — importing `Language` as
// a named export at module-load time (the "obvious" API guess) silently
// resolves to undefined. Confirmed by reading node_modules directly rather
// than assumed from the .d.ts, which describes a slightly different shape.
import ParserCtor from "web-tree-sitter";
import type { LanguageConfig } from "./languages.js";

let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, InstanceType<typeof ParserCtor.Language>>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = ParserCtor.init();
  await initPromise;
}

async function loadLanguage(config: LanguageConfig) {
  await ensureInit();
  let lang = languageCache.get(config.wasmPath);
  if (!lang) {
    lang = await ParserCtor.Language.load(config.wasmPath);
    languageCache.set(config.wasmPath, lang);
  }
  return lang;
}

export async function createParser(config: LanguageConfig) {
  const language = await loadLanguage(config);
  const parser = new ParserCtor();
  parser.setLanguage(language);
  return parser;
}
