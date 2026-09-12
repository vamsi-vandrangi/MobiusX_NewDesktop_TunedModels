// AST-bounded chunking (TDD §4.2): walk each file's syntax tree and split it
// into "semantic code blocks" — functions, methods, classes' individual
// members, type/interface declarations — never mid-statement. Consecutive
// top-level statements that aren't one of those (imports, top-level
// constants) merge into a single "block" chunk, growing until it would
// exceed TOKEN_BUDGET, at which point it flushes and a new group starts.
import type Parser from "web-tree-sitter";
import { createParser } from "./parser-pool.js";
import { languageForFile } from "./languages.js";
import { estimateTokens } from "./tokens.js";

type SyntaxNode = Parser.SyntaxNode;

export type ChunkKind = "function" | "method" | "class" | "interface" | "type" | "block";

export interface Chunk {
  relPath: string;
  /** A human-addressable symbol reference — "OrderService.validate", "file.ts#helper", or just the path for a merged block. */
  symbolPath: string;
  kind: ChunkKind;
  startLine: number;
  endLine: number;
  text: string;
  tokens: number;
  /** True if a single semantic unit (one function/class member) alone exceeds the token budget. Kept whole anyway — TDD §4.2 is explicit that a chunk is never split mid-unit. */
  oversized: boolean;
}

const TOKEN_BUDGET = 400;

const FUNCTION_LIKE_DECL_TYPES = new Set(["function_declaration", "interface_declaration", "type_alias_declaration"]);

function unwrapExport(node: SyntaxNode): SyntaxNode {
  if (node.type === "export_statement") {
    const inner = node.namedChildren.find((c): c is SyntaxNode => c !== null);
    if (inner) return inner;
  }
  return node;
}

function isFunctionLikeLexicalDeclaration(node: SyntaxNode): boolean {
  if (node.type !== "lexical_declaration") return false;
  return node.namedChildren.some((decl) => {
    if (!decl || decl.type !== "variable_declarator") return false;
    const value = decl.childForFieldName("value");
    return value !== null && (value.type === "arrow_function" || value.type === "function_expression");
  });
}

function declarationName(node: SyntaxNode): string {
  const nameNode = node.childForFieldName("name");
  if (nameNode) return nameNode.text;
  if (node.type === "lexical_declaration") {
    const decl = node.namedChildren.find((c) => c?.type === "variable_declarator");
    const id = decl?.childForFieldName("name");
    if (id) return id.text;
  }
  return "anonymous";
}

interface PendingGroup {
  nodes: SyntaxNode[];
  texts: string[];
  symbolPath: string;
}

export async function chunkSource(relPath: string, source: string): Promise<Chunk[]> {
  const langConfig = languageForFile(relPath);
  if (!langConfig) return [];

  const parser = await createParser(langConfig);
  const tree = parser.parse(source);
  if (!tree) return [];
  const root = tree.rootNode;

  const chunks: Chunk[] = [];
  let pending: PendingGroup | null = null;

  function flushGroup() {
    if (!pending || pending.nodes.length === 0) {
      pending = null;
      return;
    }
    const first = pending.nodes[0]!;
    const last = pending.nodes[pending.nodes.length - 1]!;
    const text = pending.texts.join("\n");
    chunks.push({
      relPath,
      symbolPath: pending.symbolPath,
      kind: "block",
      startLine: first.startPosition.row + 1,
      endLine: last.endPosition.row + 1,
      text,
      tokens: estimateTokens(text),
      oversized: false,
    });
    pending = null;
  }

  // `groupSymbolPath` scopes a merged block to where it actually lives — the
  // file itself for top-level statements, or "ClassName#fields" for grouped
  // class fields — so a caller can't confuse "misc top-level statements"
  // with "this class's private fields" just because both are kind "block".
  function addToGroup(node: SyntaxNode, groupSymbolPath: string) {
    if (pending && pending.symbolPath !== groupSymbolPath) {
      flushGroup();
    }
    const candidateTokens = estimateTokens(node.text);
    const currentTokens = pending ? estimateTokens(pending.texts.join("\n")) : 0;
    if (pending && currentTokens + candidateTokens > TOKEN_BUDGET) {
      flushGroup();
    }
    pending ??= { nodes: [], texts: [], symbolPath: groupSymbolPath };
    pending.nodes.push(node);
    pending.texts.push(node.text);
  }

  function emitBoundary(node: SyntaxNode, kind: ChunkKind, symbolPath: string) {
    flushGroup();
    const tokens = estimateTokens(node.text);
    chunks.push({
      relPath,
      symbolPath,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      text: node.text,
      tokens,
      oversized: tokens > TOKEN_BUDGET,
    });
  }

  function emitClassMembers(classNode: SyntaxNode, className: string) {
    const body = classNode.namedChildren.find((c) => c?.type === "class_body");
    if (!body) return;
    for (const member of body.namedChildren) {
      if (!member) continue;
      if (member.type === "method_definition") {
        const nameNode = member.childForFieldName("name");
        emitBoundary(member, "method", `${className}.${nameNode ? nameNode.text : "anonymous"}`);
      } else if (member.type === "public_field_definition") {
        // One-line fields aren't worth their own chunk; fold into a group under the class.
        addToGroup(member, `${className}#fields`);
      }
      // Other member kinds (accessors, static blocks, index signatures) fall through
      // unindexed in Phase 1 — a documented gap, not a silent one (see docs/phase-1).
    }
    flushGroup();
  }

  for (const rawChild of root.namedChildren) {
    if (!rawChild) continue;
    const node = unwrapExport(rawChild);

    if (node.type === "class_declaration") {
      flushGroup();
      emitClassMembers(node, declarationName(node));
      continue;
    }

    if (FUNCTION_LIKE_DECL_TYPES.has(node.type) || isFunctionLikeLexicalDeclaration(node)) {
      const kind: ChunkKind =
        node.type === "interface_declaration" ? "interface" : node.type === "type_alias_declaration" ? "type" : "function";
      emitBoundary(node, kind, `${relPath}#${declarationName(node)}`);
      continue;
    }

    addToGroup(node, relPath);
  }
  flushGroup();

  return chunks;
}
