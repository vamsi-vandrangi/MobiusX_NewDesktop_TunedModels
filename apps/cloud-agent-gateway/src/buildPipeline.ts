import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import ts from "typescript";
import type { ModelExecutionDiagnostic, ProjectArchitectureContract, ProjectContext, ProposedEdit, TaskEvent } from "@mobiusx/protocol";
import { bindComposePortsToLoopback, buildStages, ensurePlaywrightHarness, filesWithEdits, isBlankProject, shouldUseStagedBuild, validateBuildStage, type BuildStage, type BuildStageId } from "./buildContract.js";
import { approveReviewScopeArchitectureChange, architectureTaskSpecification, resolveProjectArchitecture, validateArchitectureStage, validateProjectArchitectureContract } from "./projectArchitecture.js";
import { ensureReviewScopeScaffold } from "./reviewScopeScaffold.js";
import { evolveReviewScopeCheckpoint } from "./reviewScopeCheckpoint.js";
import type { AgentRunner, RunnerInput } from "./runners/types.js";
import { ollamaContextTokens } from "./runners/ollamaRunner.js";
import { alignCustomerRegistrationRole, appendCustomerPageResponseSchema, appendEntityCollectionReadOperation, appendEntityCreateOperation, appendEntityHistoryReadOperation, appendEntityRecordReadOperation, appendOperationRoute, businessOperationPrompt, createAuthenticationLoginOperationSpec, createCustomerReadOperationContracts, createEntityCreateOperationSpec, deriveComplementaryDecisionOperation, extractBusinessDomainCatalog, reconcileEntityHistoryReadOperation, renderAuthenticationLoginOperation, upgradeAuthenticationLoginCheckpoint, validateAuthenticationLoginOperationSpec, validateBusinessOperationSpec, validateEntityCreateOperationSpec, validateEntityCreateRenderedOperation, validateEntityHistoryReadOperationSpec, type AuthenticationLoginOperationSpec, type BusinessOperationSpec, type EntityCollectionReadOperationSpec, type EntityCreateOperationSpec, type EntityHistoryReadOperationSpec, type EntityRecordReadOperationSpec } from "./businessOperations.js";
import { createUiContractSkeleton, mergeUiContractContribution, uiContributionPrompt, validateUiContract, validateUiContractContribution, type UiContract, type UiContractContribution, type UiOperation } from "./uiContract.js";
import { renderReactUi } from "./reactUiRenderer.js";
import { deriveTestSpecification, estimateTestPromptBudget, mergeTestContribution, renderTestContractArtifacts, reuseValidatedTestSliceArtifacts, testContributionPrompt, testImplementationPrompt, validateTestContribution, validateTestSpecification, type TestOperationMetadata, type TestSpecification } from "./testContracts.js";
import { discoverTestApplicationTopology, testTopologyPromptSummary, validateGeneratedTestsAgainstTopology } from "./testTopology.js";
import { activeCheckpointArtifacts, buildArtifactOwnershipManifest, validateStageArtifactOwnership, validateTestSubtaskCheckpoint } from "./artifactOwnership.js";

// Local inference can take tens of minutes across six structured generations
// and bounded repairs. Keep a finite two-hour task deadline so a CPU model can
// finish without allowing an unbounded generation task.
const DEFAULT_STAGED_BUILD_TIMEOUT_MS = 2 * 60 * 60_000;
const execFileAsync = promisify(execFile);

export async function validatePythonSources(files: Map<string, { content: string; action: ProposedEdit["action"] }>): Promise<string[]> {
  const pythonFiles = [...files.entries()].filter(([path]) => path.toLowerCase().endsWith(".py"));
  if (!pythonFiles.length) return [];
  const root = await mkdtemp(join(tmpdir(), "mobiusx-python-gate-"));
  try {
    for (const [path, file] of pythonFiles) {
      const relative = path.replaceAll("\\", "/");
      if (relative.startsWith("/") || relative.split("/").some((part) => part === "..")) return [`${path} is not a safe relative Python artifact path`];
      const destination = join(root, ...relative.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
    const python = process.env.MOBIUSX_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const check = "import ast,pathlib,sys; root=pathlib.Path(sys.argv[1]); [(compile(ast.parse(p.read_text(encoding='utf-8'), filename=str(p)), str(p), 'exec')) for p in root.rglob('*.py')]";
    try {
      await execFileAsync(python, ["-c", check, root], { timeout: 30_000, maxBuffer: 1_000_000 });
      await execFileAsync(python, ["-m", "compileall", "-q", "-f", root], { timeout: 30_000, maxBuffer: 1_000_000 });
      return [];
    } catch (error) {
      const err = error as Error & { stderr?: string; code?: string };
      return [`Python AST/compileall validation failed (${python}): ${(err.stderr || err.message).trim().slice(0, 2_000)}`];
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Correct only an unambiguous casing mismatch in Enum member references,
 * using declarations already present in the validated workspace. */
export function repairPythonEnumMemberReferences(
  edits: ProposedEdit[],
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
): { edits: ProposedEdit[]; changedPaths: string[] } {
  const declarations = new Map<string, string[]>();
  const classPattern = /^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:\s*$/gm;
  for (const file of files.values()) {
    const classes = [...file.content.matchAll(classPattern)];
    for (let index = 0; index < classes.length; index += 1) {
      const match = classes[index];
      if (!/(?:^|\.)(?:Enum|PyEnum)$/.test(match[2].trim())) continue;
      const start = match.index! + match[0].length;
      const end = classes[index + 1]?.index ?? file.content.length;
      const names = [...file.content.slice(start, end).matchAll(/^\s{4}([A-Za-z_]\w*)\s*=/gm)].map((item) => item[1]);
      if (names.length) declarations.set(match[1], names);
    }
  }
  const changedPaths: string[] = [];
  const repaired = edits.map((edit) => {
    if (!edit.path.toLowerCase().endsWith(".py")) return edit;
    const content = edit.content.replace(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g, (reference, enumName: string, member: string) => {
      const canonical = declarations.get(enumName)?.find((name) => name.toLowerCase() === member.toLowerCase());
      return canonical ? `${enumName}.${canonical}` : reference;
    });
    if (content !== edit.content) changedPaths.push(edit.path);
    return content === edit.content ? edit : { ...edit, content };
  });
  return { edits: repaired, changedPaths };
}

/** Find unresolved Python globals that compile successfully but would fail at
 * import or request time (for example a route calling select() without import). */
export async function validatePythonModuleSymbols(files: Map<string, { content: string; action: ProposedEdit["action"] }>): Promise<string[]> {
  const pythonFiles = [...files.entries()].filter(([path]) => path.toLowerCase().endsWith(".py"));
  if (!pythonFiles.length) return [];
  const enumMembers = new Map<string, Set<string>>();
  const enumClassPattern = /^class\s+([A-Za-z_]\w*)\s*\(([^)]*)\)\s*:\s*$/gm;
  for (const [, file] of pythonFiles) {
    const classes = [...file.content.matchAll(enumClassPattern)];
    for (let index = 0; index < classes.length; index += 1) {
      const match = classes[index];
      if (!/(?:^|\.)(?:Enum|PyEnum)$/.test(match[2].trim())) continue;
      const start = match.index! + match[0].length;
      const end = classes[index + 1]?.index ?? file.content.length;
      const members = new Set([...file.content.slice(start, end).matchAll(/^\s{4}([A-Za-z_]\w*)\s*=/gm)].map((item) => item[1]));
      if (members.size) enumMembers.set(match[1], members);
    }
  }
  const enumIssues = pythonFiles.flatMap(([path, file]) => [...file.content.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)\b/g)].flatMap((reference) => {
    const members = enumMembers.get(reference[1]);
    return members && !members.has(reference[2]) ? [`${path} references missing Enum member ${reference[1]}.${reference[2]}`] : [];
  }));
  const root = await mkdtemp(join(tmpdir(), "mobiusx-python-symbols-"));
  try {
    for (const [path, file] of pythonFiles) {
      const relative = path.replaceAll("\\", "/");
      if (relative.startsWith("/") || relative.split("/").some((part) => part === "..")) return [`${path} is not a safe relative Python artifact path`];
      const destination = join(root, ...relative.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
    const python = process.env.MOBIUSX_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const check = [
      "import builtins,json,pathlib,symtable,sys",
      "root=pathlib.Path(sys.argv[1]); out=[]; builtin=set(dir(builtins))",
      "for path in root.rglob('*.py'):",
      " source=path.read_text(encoding='utf-8'); table=symtable.symtable(source,str(path),'exec')",
      " module_names={s.get_name() for s in table.get_symbols() if s.is_assigned() or s.is_imported()}",
      " has_star=any(s.is_imported() and s.get_name()=='*' for s in table.get_symbols())",
      " def visit(scope):",
      "  for symbol in scope.get_symbols():",
      "   name=symbol.get_name()",
      "   if symbol.is_global() and symbol.is_referenced() and name not in module_names and name not in builtin and not has_star and not name.startswith('__'):",
      "    line=scope.get_lineno(); out.append({'path':str(path.relative_to(root)).replace('\\\\','/'),'name':name,'line':line})",
      "  for child in scope.get_children(): visit(child)",
      " visit(table)",
      "print(json.dumps(out))",
    ].join("\n");
    const result = await execFileAsync(python, ["-c", check, root], { timeout: 30_000, maxBuffer: 1_000_000 });
    const unresolved = JSON.parse(result.stdout) as Array<{ path: string; name: string; line: number }>;
    return [...new Set([...unresolved.map((item) => `${item.path} has unresolved global name '${item.name}' (referenced near line ${item.line})`), ...enumIssues])];
  } catch (error) {
    const err = error as Error & { stderr?: string };
    return [`Python symbol validation failed: ${(err.stderr || err.message).trim().slice(0, 2_000)}`];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export function validateTypeScriptSyntax(files: Map<string, { content: string; action: ProposedEdit["action"] }>): string[] {
  const issues: string[] = [];
  for (const [path, file] of files) {
    if (/\.d\.ts$/i.test(path) || !/\.(?:[cm]?tsx?|jsx?)$/i.test(path)) continue;
    const result = ts.transpileModule(file.content, {
      fileName: path,
      reportDiagnostics: true,
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    });
    for (const diagnostic of result.diagnostics ?? []) {
      if (diagnostic.category !== ts.DiagnosticCategory.Error) continue;
      const where = diagnostic.file && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
      const location = where ? `:${where.line + 1}:${where.character + 1}` : "";
      issues.push(`${path}${location}: TypeScript syntax error: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
    }
  }
  return issues;
}

/** Repair the safe FastAPI syntax case where a generated route uses `await` but is declared with `def`. */
export function promoteAwaitingPythonRoutes(
  edits: ProposedEdit[],
  issues: string[],
): { edits: ProposedEdit[]; changedPaths: string[] } {
  const invalidPaths = new Set(issues.flatMap((issue) => {
    const match = issue.match(/^([^:]+\.py) uses await outside an async def/i);
    if (match) return [match[1].replaceAll("\\", "/").toLowerCase()];
    if (!/SyntaxError:\s*'await' outside async function/i.test(issue)) return [];
    const traceback = [...issue.matchAll(/File [\"']([^\"']+\.py)[\"'], line \d+/g)].at(-1)?.[1]?.replaceAll("\\", "/");
    const projectPath = traceback?.match(/(?:^|\/)(backend\/[^/]+(?:\/[^/]+)*\.py)$/i)?.[1];
    return projectPath ? [projectPath.toLowerCase()] : [];
  }));
  if (!invalidPaths.size) return { edits, changedPaths: [] };
  const changedPaths: string[] = [];
  const repaired = edits.map((edit) => {
    if (!invalidPaths.has(edit.path.replaceAll("\\", "/").toLowerCase()) || !/(?:^|\/)routes?\//i.test(edit.path)) return edit;
    const lines = edit.content.split(/(?<=\n)/);
    const stack: Array<{ indent: number; async: boolean; line: number; route: boolean; signatureDepth: number }> = [];
    let pendingRouteDecorator = false;
    let changed = false;
    for (let index = 0; index < lines.length; index += 1) {
      const sourceLine = lines[index];
      const code = sourceLine.replace(/\s+#.*$/, "");
      if (!code.trim()) continue;
      const indent = code.match(/^\s*/)?.[0].length ?? 0;
      const pendingSignature = stack.at(-1);
      if (pendingSignature?.signatureDepth) {
        pendingSignature.signatureDepth += (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
        continue;
      }
      const definition = code.match(/^\s*(async\s+)?def\s+[A-Za-z_]\w*\s*\(/);
      if (definition) {
        while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
        const signatureDepth = (code.match(/\(/g)?.length ?? 0) - (code.match(/\)/g)?.length ?? 0);
        stack.push({ indent, async: Boolean(definition[1]), line: index, route: pendingRouteDecorator, signatureDepth });
        pendingRouteDecorator = false;
        continue;
      }
      if (indent === 0 && /^\s*@/.test(code)) pendingRouteDecorator ||= /^\s*@(?:router|app)\.(?:get|post|put|patch|delete)\s*\(/i.test(code);
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      const active = stack.at(-1);
      // The compiler diagnostic already proves this function cannot remain
      // synchronous. Do not require a directly adjacent FastAPI decorator:
      // generated modules may use multiline decorators, helper wrappers, or
      // aliases, while any `await` in a sync function is invalid regardless.
      if (active && !active.async && /\bawait\b/.test(code)) {
        lines[active.line] = lines[active.line].replace(/^(\s*)def\s+/, "$1async def ");
        active.async = true;
        changed = true;
      }
    }
    if (!changed) return edit;
    changedPaths.push(edit.path);
    return { ...edit, content: lines.join("") };
  });
  return { edits: repaired, changedPaths };
}

/** Apply only an unambiguous declared-framework/model import fix. */
export function repairKnownPythonNameErrors(
  edits: ProposedEdit[],
  issues: string[],
): { edits: ProposedEdit[]; changedPaths: string[] } {
  const knownImports: Record<string, string> = {
    FastAPI: "from fastapi import FastAPI",
    HTTPException: "from fastapi import HTTPException",
    Depends: "from fastapi import Depends",
    status: "from fastapi import status",
    APIRouter: "from fastapi import APIRouter",
    OAuth2PasswordBearer: "from fastapi.security import OAuth2PasswordBearer",
    OAuth2PasswordRequestForm: "from fastapi.security import OAuth2PasswordRequestForm",
    register_tortoise: "from tortoise.contrib.fastapi import register_tortoise",
    Tortoise: "from tortoise import Tortoise",
    run_async: "from tortoise import run_async",
    in_transaction: "from tortoise.transactions import in_transaction",
    DoesNotExist: "from tortoise.exceptions import DoesNotExist",
    User: "from backend.models import User",
    Customer: "from backend.models import Customer",
    ApprovalEvent: "from backend.models import ApprovalEvent",
    CustomerCreate: "from backend.schemas import CustomerCreate",
    CustomerResponse: "from backend.schemas import CustomerResponse",
    TokenData: "from backend.schemas import TokenData",
    CryptContext: "from passlib.context import CryptContext",
    jwt: "from jose import jwt",
    JWTError: "from jose import JWTError",
    get_current_active_user: "from backend.auth import get_current_active_user",
    os: "import os",
    Path: "from pathlib import Path",
  };
  const repairs = new Map<string, { name: string; importLine: string }>();
  for (const issue of issues) {
    const missingTortoiseTransactionImport = issue.match(/^([^:]+\.py) uses in_transaction but does not import it$/i);
    const name = missingTortoiseTransactionImport ? "in_transaction" : issue.match(/NameError:\s*name ['"]([^'"]+)['"] is not defined/i)?.[1];
    if (!name || !knownImports[name]) continue;
    const tracebackFiles = [...issue.matchAll(/File ["'](?:[^"']*\/)?(backend\/[A-Za-z0-9_./-]+\.py)["'], line \d+/gi)];
    const path = missingTortoiseTransactionImport?.[1]?.replaceAll("\\", "/").toLowerCase() ?? tracebackFiles.at(-1)?.[1]?.toLowerCase();
    if (path) repairs.set(path, { name, importLine: knownImports[name] });
  }
  // FastAPI evaluates route annotations while importing the module. A missing
  // User annotation is deterministic when the generated workspace already has
  // backend.models.User; correct it before spending another model call.
  for (const edit of edits) {
    const path = edit.path.replaceAll("\\", "/").toLowerCase();
    if (!/^backend\/routes\/[^/]+\.py$/.test(path) || !/\b(?:current_user|user)\s*:\s*User\b/.test(edit.content)) continue;
    if (/^\s*(?:from\s+[\w.]+\s+import[^\n]*\bUser\b|class\s+User\b)/m.test(edit.content)) continue;
    repairs.set(path, { name: "User", importLine: knownImports.User });
  }
  const changedPaths: string[] = [];
  let nextEdits = edits.map((edit) => {
    const normalizedPath = edit.path.replaceAll("\\", "/").toLowerCase();
    const repair = repairs.get(normalizedPath);
    if (!repair || !/^backend\/(?:main|routes\/[^/]+)\.py$/.test(normalizedPath)) return edit;
    const { name, importLine } = repair;
    if (new RegExp(`(?:from\\s+\\w+(?:\\.\\w+)*\\s+import[^\\n]*\\b${name}\\b|^import\\s+${name}\\s*$)`, "m").test(edit.content)) return edit;
    changedPaths.push(edit.path);
    const existingImport = importLine.startsWith("from fastapi import ") ? edit.content.match(/^from\s+fastapi\s+import[^\n]*$/m) : undefined;
    const content = existingImport
      ? edit.content.replace(existingImport[0], `${existingImport[0]}, ${name}`)
      : `${importLine}\n${edit.content}`;
    return { ...edit, content };
  });
  const routeImports: Record<string, { used: RegExp; imported: RegExp; line: string }> = {
    AsyncSession: { used: /\bAsyncSession\b/, imported: /^from\s+sqlalchemy\.ext\.asyncio\s+import[^\n]*\bAsyncSession\b/m, line: "from sqlalchemy.ext.asyncio import AsyncSession" },
    select: { used: /\bselect\s*\(/, imported: /^from\s+sqlalchemy\s+import[^\n]*\bselect\b/m, line: "from sqlalchemy import select" },
  };
  nextEdits = nextEdits.map((edit) => {
    if (!/^backend\/routes\/[^/]+\.py$/i.test(edit.path.replaceAll("\\", "/"))) return edit;
    const additions = Object.values(routeImports).filter(({ used, imported }) => used.test(edit.content) && !imported.test(edit.content)).map(({ line }) => line);
    if (!additions.length) return edit;
    if (!changedPaths.includes(edit.path)) changedPaths.push(edit.path);
    return { ...edit, content: `${additions.join("\n")}\n${edit.content}` };
  });
  return { edits: nextEdits, changedPaths };
}

/** Repair an incorrect relative-import depth only when the project manifest
 * contains exactly one file matching that module name. */
export function repairResolvablePythonRelativeImports(
  edits: ProposedEdit[],
  context: ProjectContext,
): { edits: ProposedEdit[]; changedPaths: string[] } {
  const files = filesWithEdits(context, edits);
  const allPaths = [...files.keys()].map((path) => path.replaceAll("\\", "/").toLowerCase());
  const changedPaths: string[] = [];
  const repaired = edits.map((edit) => {
    if (!edit.path.toLowerCase().endsWith(".py")) return edit;
    const parent = edit.path.replaceAll("\\", "/").split("/").slice(0, -1).filter(Boolean);
    let changed = false;
    const content = edit.content.replace(/^(\s*from\s+)(\.+)([\w.]+)(\s+import\s+)/gm, (whole, prefix: string, dots: string, moduleName: string, suffix: string) => {
      const moduleSegments = moduleName.split(".");
      const levelsUp = dots.length - 1;
      const currentSegments = [...parent.slice(0, parent.length - levelsUp), ...moduleSegments];
      const currentBase = currentSegments.join("/").toLowerCase();
      if (allPaths.some((path) => path === `${currentBase}.py` || path === `${currentBase}/__init__.py`)) return whole;

      const candidates = allPaths
        .filter((path) => path.endsWith(".py"))
        .map((path) => path.slice(0, -3).split("/"))
        .filter((segments) => segments.length >= moduleSegments.length && moduleSegments.every((segment, index) => segments[segments.length - moduleSegments.length + index] === segment.toLowerCase()));
      if (candidates.length !== 1) return whole;
      const target = candidates[0];
      let common = 0;
      while (common < parent.length && common < target.length && parent[common].toLowerCase() === target[common]) common += 1;
      if (common === 0) return whole;
      const correctedDots = ".".repeat(parent.length - common + 1);
      const targetModule = target.slice(common).join(".");
      if (!targetModule) return whole;
      changed = true;
      return `${prefix}${correctedDots}${targetModule}${suffix}`;
    });
    if (!changed) return edit;
    changedPaths.push(edit.path);
    return { ...edit, content };
  });
  return { edits: repaired, changedPaths };
}

function boundedValidationTimeout(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 1_000 ? Math.min(Math.floor(parsed), maximum) : fallback;
}

/** Install/build the generated frontend in an isolated temporary directory. */
export async function validateFrontendBuild(
  files: Map<string, { content: string; action: ProposedEdit["action"]; originalPath?: string }>,
  options: { runCommand?: (command: string, args: string[], cwd: string, timeoutMs: number) => Promise<void> } = {},
): Promise<string[]> {
  const frontendPrefix = [...files.keys()].find((path) => /^(?:frontend|client|web)\/package\.json$/i.test(path.replaceAll("\\", "/")));
  if (!frontendPrefix) return [];
  const prefix = frontendPrefix.slice(0, frontendPrefix.lastIndexOf("/") + 1).toLowerCase();
  const packageFile = files.get(frontendPrefix);
  if (!packageFile) return ["frontend package.json is missing from the isolated build context"];
  const root = await mkdtemp(join(tmpdir(), "mobiusx-frontend-gate-"));
  const timeoutMs = boundedValidationTimeout(process.env.MOBIUSX_FRONTEND_BUILD_TIMEOUT_MS, 8 * 60_000, 12 * 60_000);
  try {
    for (const [rawPath, file] of files) {
      const normalized = (file.originalPath ?? rawPath).replaceAll("\\", "/");
      if (!normalized.toLowerCase().startsWith(prefix)) continue;
      const relative = normalized.slice(prefix.length);
      if (!relative || relative.startsWith("/") || relative.split("/").some((part) => part === "..")) {
        return [`${rawPath} is not a safe relative frontend artifact path`];
      }
      const destination = join(root, ...relative.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
    const packageJson = JSON.parse(packageFile.content) as {
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    if (!packageJson.scripts || typeof packageJson.scripts.build !== "string") return ["frontend package.json must provide a build script before isolated validation"];
    const tsFiles = [...files.entries()].map(([path, file]) => file.originalPath ?? path).filter((path) => /\.(?:ts|tsx)$/i.test(path) && path.replaceAll("\\", "/").toLowerCase().startsWith(prefix));
    if (tsFiles.length && !packageJson.dependencies?.typescript && !packageJson.devDependencies?.typescript) {
      return ["frontend uses TypeScript but package.json does not declare TypeScript for semantic checking"];
    }
    const npm = process.env.MOBIUSX_NPM ?? "npm";
    const runCommand = options.runCommand ?? (async (command: string, args: string[], cwd: string, commandTimeoutMs: number) => {
      await execFileAsync(command, args, {
        cwd, timeout: commandTimeoutMs, maxBuffer: 2_000_000,
        env: { ...process.env, CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
      });
    });
    try {
      await runCommand(npm, ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefer-offline"], root, timeoutMs);
      if (tsFiles.length) {
        const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
        const relativeTsFiles = tsFiles.map((path) => path.replaceAll("\\", "/").slice(prefix.length));
        await runCommand(tsc, frontendTypecheckArgs(relativeTsFiles), root, timeoutMs);
      }
      await runCommand(npm, ["run", "build"], root, timeoutMs);
      return [];
    } catch (error) {
      const err = error as Error & { stderr?: string; stdout?: string; code?: string; killed?: boolean };
      const output = `${err.stderr ?? ""}\n${err.stdout ?? ""}`.trim().slice(-3_000);
      const cause = err.killed ? `timed out after ${timeoutMs}ms` : (output || err.message);
      return [`isolated frontend dependency installation/build failed (${npm}): ${cause}`];
    }
  } catch (error) {
    return [`isolated frontend validation setup failed: ${(error as Error).message}`];
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** TypeScript 4.x (still used by many generated Next.js manifests) does not
 * accept `bundler`; `node` resolution works across supported TS versions and
 * matches the conventional Next.js project setup. Keep the CLI flags aligned
 * with the declared dependency instead of forcing a newer compiler mode. */
export function frontendTypecheckArgs(relativeTsFiles: string[]): string[] {
  return ["--noEmit", "--pretty", "false", "--skipLibCheck", "--target", "ES2022", "--module", "ESNext", "--moduleResolution", "node", "--jsx", "react-jsx", "--esModuleInterop", "--allowSyntheticDefaultImports", ...relativeTsFiles];
}

/** Apply narrow, deterministic fixes for frontend tooling errors that can be
 * proven from the generated workspace itself: missing Node ambient types and
 * relative imports whose unique target exists elsewhere in that workspace. */
export function repairKnownFrontendToolingIssues(
  edits: ProposedEdit[],
  issues: string[],
): { edits: ProposedEdit[]; changedPaths: string[] } {
  const normalized = new Map(edits.map((edit) => [edit.path.replaceAll("\\", "/").toLowerCase(), edit]));
  const frontendPackageEntry = [...normalized.entries()].find(([path]) => /^(?:frontend|client|web)\/package\.json$/.test(path));
  if (!frontendPackageEntry) return { edits, changedPaths: [] };
  const [manifestPath, manifestEdit] = frontendPackageEntry;
  const prefix = manifestPath.slice(0, manifestPath.lastIndexOf("/") + 1);
  const tsconfigEntry = [...normalized.entries()].find(([path]) => path === `${prefix}tsconfig.json`);
  const sourceEntries = [...normalized.entries()].filter(([path]) => path.startsWith(prefix) && /\.(?:ts|tsx|js|jsx)$/.test(path));
  const changedPaths = new Set<string>();

  if (issues.some((issue) => /tsconfig\.json.*(?:TS1109|JSON|syntax|parse)/i.test(issue)) && tsconfigEntry) {
    const [tsconfigPath, tsconfigEdit] = tsconfigEntry;
    const repaired = tsconfigEdit.content.replace(/\*\*\/\*\.\{ts,tsx\}\*\*/g, '"**/*.ts", "**/*.tsx"');
    if (repaired !== tsconfigEdit.content) {
      normalized.set(tsconfigPath, { ...tsconfigEdit, content: repaired });
      changedPaths.add(tsconfigEdit.path);
    }
  }

  if (issues.some((issue) => /Cannot find name 'process'/.test(issue)) && sourceEntries.some(([, edit]) => /\bprocess\s*\./.test(edit.content))) {
    try {
      const manifest = JSON.parse(manifestEdit.content) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      if (!manifest.devDependencies?.["@types/node"] && !manifest.dependencies?.["@types/node"]) {
        manifest.devDependencies = { ...(manifest.devDependencies ?? {}), "@types/node": "^20.17.10" };
        normalized.set(manifestPath, { ...manifestEdit, content: `${JSON.stringify(manifest, null, 2)}\n` });
        changedPaths.add(manifestEdit.path);
      }
    } catch {
      // A malformed package manifest remains a model-repair diagnostic.
    }
  }

  // A Vite/React application must not carry an unused Next.js framework
  // dependency: older Next releases pin React 18 and make npm install fail
  // against the validated React 19 scaffold. Remove it only when Vite is the
  // declared runner and no generated source imports from `next`.
  if (issues.some((issue) => /(?:npm.*ERESOLVE|ERESOLVE.*(?:dependency|peer)|unable to resolve dependency tree)/is.test(issue))
    && normalized.has(`${prefix}vite.config.ts`)
    && !sourceEntries.some(([, edit]) => /(?:from\s+["']next(?:\/[^"']*)?["']|require\(["']next(?:\/[^"']*)?["']\))/i.test(edit.content))) {
    try {
      const manifest = JSON.parse(normalized.get(manifestPath)!.content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      if (manifest.dependencies?.next) {
        delete manifest.dependencies.next;
        normalized.set(manifestPath, { ...manifestEdit, content: `${JSON.stringify(manifest, null, 2)}\n` });
        changedPaths.add(manifestEdit.path);
      }
    } catch {
      // Leave malformed manifests to contract-aware repair.
    }
  }

  const sourceBasenames = new Map<string, string[]>();
  for (const [path, edit] of sourceEntries) {
    const basename = posix.basename(path).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx)$/i, "").toLowerCase();
    sourceBasenames.set(basename, [...(sourceBasenames.get(basename) ?? []), edit.path.replaceAll("\\", "/")]);
  }
  if (issues.some((issue) => /Cannot find module/.test(issue))) for (const [sourcePath, sourceEdit] of sourceEntries) {
    let content = sourceEdit.content;
    const rewritten = content.replace(/\bfrom\s*(["'])(\.{1,2}\/[^"']+)\1/g, (statement, quote: string, specifier: string) => {
      const targetBase = posix.normalize(posix.join(posix.dirname(sourcePath), specifier)).toLowerCase();
      const candidates = [targetBase, ...[".ts", ".tsx", ".d.ts", ".js", ".jsx"].map((extension) => `${targetBase}${extension}`), ...["index.ts", "index.tsx", "index.js", "index.jsx"].map((indexFile) => `${targetBase}/${indexFile}`)];
      if (candidates.some((candidate) => normalized.has(candidate))) return statement;
      const basename = posix.basename(specifier).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx)$/i, "").toLowerCase();
      const matches = sourceBasenames.get(basename) ?? [];
      if (matches.length !== 1) return statement;
      let next = posix.relative(posix.dirname(sourceEdit.path.replaceAll("\\", "/")), matches[0]).replace(/\.(?:d\.)?(?:ts|tsx|js|jsx)$/i, "");
      if (!next.startsWith(".")) next = `./${next}`;
      return `from ${quote}${next}${quote}`;
    });
    if (rewritten !== content) {
      content = rewritten;
      const prior = normalized.get(sourcePath)!;
      normalized.set(sourcePath, { ...prior, content });
      changedPaths.add(prior.path);
    }
  }
  return { edits: [...normalized.values()], changedPaths: [...changedPaths] };
}

/** Install declared backend dependencies inside a disposable container, then import generated code with networking disabled and source mounted read-only. */
export async function validateBackendImports(
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
): Promise<string[]> {
  const normalized = new Map([...files].map(([path, file]) => [path.replaceAll("\\", "/").toLowerCase(), file]));
  const requirements = normalized.get("backend/requirements.txt");
  if (!requirements || !normalized.has("backend/main.py")) return ["FastAPI import validation requires backend/requirements.txt and backend/main.py"];
  const image = process.env.MOBIUSX_PYTHON_VALIDATION_IMAGE ?? "python:3.12-slim";
  const timeoutMs = boundedValidationTimeout(process.env.MOBIUSX_PYTHON_VALIDATION_TIMEOUT_MS, 8 * 60_000, 12 * 60_000);
  const root = await mkdtemp(join(tmpdir(), "mobiusx-backend-gate-"));
  const dependencyHash = createHash("sha256").update(image).update("\0").update(requirements.content).digest("hex");
  const volume = `mobiusx-python-gate-${dependencyHash.slice(0, 24)}`;
  try {
    for (const [rawPath, file] of files) {
      const relative = rawPath.replaceAll("\\", "/");
      if (relative.startsWith("/") || relative.split("/").some((part) => part === "..")) return [rawPath + " is not a safe relative backend artifact path"];
      const destination = join(root, ...relative.split("/"));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, file.content, "utf8");
    }
    try {
      await execFileAsync("docker", ["volume", "create", volume], { timeout: 15_000, maxBuffer: 16_000 });
      const ensureDependencies = `python -m venv /venv && if [ ! -f /venv/.mobiusx-requirements-sha256 ] || [ "$(cat /venv/.mobiusx-requirements-sha256)" != "${dependencyHash}" ]; then PIP_CACHE_DIR=/venv/pip-cache /venv/bin/pip install --disable-pip-version-check --no-input -r /tmp/requirements.txt && printf '%s' '${dependencyHash}' > /venv/.mobiusx-requirements-sha256; fi`;
      await execFileAsync("docker", ["run", "--rm", "--pull=never", "--network", "bridge", "-v", volume + ":/venv", "-v", join(root, "backend/requirements.txt") + ":/tmp/requirements.txt:ro", image, "sh", "-lc", ensureDependencies], {
        timeout: timeoutMs, maxBuffer: 2_000_000,
      });
      const importCheck = [
        "import importlib, pathlib",
        "from sqlalchemy.orm import configure_mappers",
        "main = importlib.import_module('backend.main')",
        "app = getattr(main, 'app', None)",
        "assert app is not None, 'backend.main must export FastAPI app'",
        "app.openapi()",
        "root = pathlib.Path('/workspace/backend')",
        "for path in root.rglob('*.py'):",
        " parts = path.relative_to('/workspace').with_suffix('').parts",
        " if any(part in {'tests', 'migrations', '__pycache__'} for part in parts): continue",
        " if parts[-1] == '__init__': parts = parts[:-1]",
        " if parts: importlib.import_module('.'.join(parts))",
        "configure_mappers()",
        "from backend.database import Base",
        "assert {'customers', 'users', 'audit_events'}.issubset(Base.metadata.tables.keys()), 'SQLAlchemy metadata is missing required registered tables'",
      ].join("\n");
      await execFileAsync("docker", ["run", "--rm", "--pull=never", "--network", "none", "-e", "DATABASE_URL=postgresql+asyncpg://validation:validation@127.0.0.1:5432/validation", "-e", "SECRET_KEY=mobiusx-isolated-validation-only", "-e", "JWT_SECRET=mobiusx-isolated-validation-only", "-v", volume + ":/venv:ro", "-v", root + ":/workspace:ro", "-w", "/workspace", image, "/venv/bin/python", "-c", importCheck], {
        timeout: 45_000, maxBuffer: 2_000_000,
      });
      return [];
    } catch (error) {
      const err = error as Error & { stderr?: string; stdout?: string; killed?: boolean };
      const output = (err.stderr || "") + "\n" + (err.stdout || "");
      const cause = err.killed ? "timed out after " + timeoutMs + "ms" : (output.trim().slice(-3_000) || err.message);
      return ["isolated FastAPI dependency/import validation failed (" + image + "): " + cause];
    }
  } finally {
    // Keep the versioned venv volume so later stage checks and checkpoint
    // resumes do not redownload an identical stack on slow local networks.
    await rm(root, { recursive: true, force: true });
  }
}

let backendImportValidatorForTests: ((files: Map<string, { content: string; action: ProposedEdit["action"] }>) => Promise<string[]>) | undefined;
let frontendBuildValidatorForTests: ((files: Map<string, { content: string; action: ProposedEdit["action"] }>) => Promise<string[]>) | undefined;
/** Test seam for staged pipeline tests; production always uses the isolated Docker validator. */
export function setBackendImportValidatorForTests(
  validator?: (files: Map<string, { content: string; action: ProposedEdit["action"] }>) => Promise<string[]>,
): void {
  backendImportValidatorForTests = validator;
}

/** Unit-test seam: keep mandatory pipeline tests deterministic and leave real npm installs to bounded integration jobs. */
export function setFrontendBuildValidatorForTests(
  validator?: (files: Map<string, { content: string; action: ProposedEdit["action"] }>) => Promise<string[]>,
): void {
  frontendBuildValidatorForTests = validator;
}

async function validateGeneratedStage(
  stageId: BuildStage["id"],
  prompt: string,
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
  architecture?: ProjectArchitectureContract,
  options: { skipRuntimeImports?: boolean } = {},
): Promise<string[]> {
  const pythonFiles = new Map([...files.entries()].filter(([path]) => {
    const normalized = path.replaceAll("\\", "/").toLowerCase();
    if (!normalized.endsWith(".py")) return false;
    if (stageId === "database") return normalized === "backend/models.py" || normalized.includes("/migrations/") || normalized.startsWith("backend/migrations/");
    if (["backend", "transactions", "tests"].includes(stageId)) return normalized.startsWith("backend/");
    return true;
  }));
  const staticIssues = [
    ...validateBuildStage(stageId, prompt, files, architecture?.stack.frontend),
    ...(architecture ? validateArchitectureStage(stageId, architecture, [...files.entries()].map(([path, file]) => ({ path, content: file.content }))) : []),
    ...await validatePythonSources(pythonFiles),
    ...validateTypeScriptSyntax(files),
  ];
  if (stageId === "database" && architecture?.stack.database.toLowerCase() === "postgresql") {
    const revision = [...files.entries()].find(([path]) => /migrations\/versions\/[^/]+\.py$/i.test(path.replaceAll("\\", "/")))?.[1].content;
    if (revision && [...revision.matchAll(/(?:sa\.Enum|postgresql\.ENUM)\s*\(([^)]*)\)/g)].some((match) => !/\bname\s*=/.test(match[1]))) {
      staticIssues.push("PostgreSQL Alembic ENUM types must declare an explicit stable name");
    }
  }
  if (staticIssues.length > 0) return staticIssues;
  if (!options.skipRuntimeImports && (stageId === "database" || stageId === "backend" || stageId === "transactions")) {
    const backendIssues = await (backendImportValidatorForTests ?? validateBackendImports)(files);
    if (backendIssues.length > 0) return backendIssues;
  }
  if (stageId === "frontend") return (frontendBuildValidatorForTests ?? validateFrontendBuild)(files);
  return [];
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

/** Resolve a Python enum member by its declared wire value, independent of member casing. */
function pythonEnumMemberForValue(source: string, className: string, expectedValue: string): string | undefined {
  const lines = source.split(/\r?\n/);
  const start = lines.findIndex((line) => new RegExp(`^class\\s+${escapeRegExp(className)}(?:\\s*\\([^)]*\\))?\\s*:`).test(line));
  if (start < 0) return undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^\S/.test(line) && line.trim()) break;
    const member = line.match(/^\s*([A-Za-z_]\w*)\s*=\s*["']([^"']+)["']\s*(?:#.*)?$/);
    if (member?.[2].toLowerCase() === expectedValue.toLowerCase()) return member[1];
  }
  return undefined;
}

/** Check that the preserved customer API can support the requested browser
 * views before spending inference on a frontend that cannot read its data. */
export function validateFrontendBackendContract(
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
  prompt: string,
): string[] {
  if (!/customer/i.test(prompt) || !/manager/i.test(prompt) || !/(?:dashboard|onboard|approval|approve|reject)/i.test(prompt)) return [];
  const normalized = new Map([...files].map(([path, file]) => [path.replaceAll("\\", "/").toLowerCase(), file.content]));
  const customers = normalized.get("backend/routes/customers.py") ?? "";
  const auth = normalized.get("backend/routes/auth.py") ?? "";
  const schemas = normalized.get("backend/schemas.py") ?? "";
  const modelSource = [...normalized.entries()].filter(([path]) => /^backend\/models(?:\/|\.py$)/.test(path)).map(([, content]) => content).join("\n");
  const routes: Array<{ method: string; path: string; body: string }> = [];
  const lines = customers.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const route = lines[i].match(/^\s*@\w+\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/i);
    if (!route) continue;
    let functionIndex = i + 1;
    while (functionIndex < lines.length && !/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(lines[functionIndex])) functionIndex += 1;
    if (functionIndex >= lines.length) continue;
    let end = functionIndex + 1;
    while (end < lines.length && !/^\s*@\w+\./.test(lines[end])) end += 1;
    routes.push({ method: route[1].toUpperCase(), path: route[2], body: lines.slice(functionIndex, end).join("\n") });
    i = functionIndex;
  }
  const hasRoute = (method: string, path: string) => routes.some((route) => route.method === method && route.path === path);
  const listRoute = routes.find((route) => route.method === "GET" && route.path === "/customers");
  const detailRoute = routes.find((route) => route.method === "GET" && route.path === "/customers/{customer_id}");
  const issues: string[] = [];
  if (!/class\s+LoginRequest\b/.test(schemas) || !/\busername\s*:\s*str/.test(schemas) || !/\bpassword\s*:\s*str/.test(schemas) || !/class\s+TokenResponse\b/.test(schemas) || !/\baccess_token\s*:\s*str/.test(schemas) || !/\/auth\/login/.test(auth)) {
    issues.push("frontend login contract is incomplete: expected POST /auth/login with username/password and an access_token response");
  }
  for (const [method, path, label] of [
    ["POST", "/customers", "customer registration"],
    ["POST", "/customers/{customer_id}/submit", "customer submission"],
    ["POST", "/customers/{customer_id}/approve", "manager approval"],
    ["POST", "/customers/{customer_id}/reject", "manager rejection"],
    ["GET", "/customers/{customer_id}/audit", "audit history"],
  ]) if (!hasRoute(method, path)) issues.push(`frontend ${label} contract is missing ${method} ${path}`);
  if (!listRoute) issues.push("frontend dashboards require GET /customers for persisted customer and manager queue data");
  else {
    if (/require_role\s*\(\s*["']manager["']\s*\)/i.test(listRoute.body)) issues.push("GET /customers is manager-only; customer users have no endpoint to list their persisted applications");
    if (!/Depends\s*\(\s*get_current_user\s*\)/.test(listRoute.body) || !/Customer\.owner_id\s*==\s*current_user\.id/.test(listRoute.body)) issues.push("GET /customers must derive customer ownership filtering from the authenticated identity");
    if (!/current_user\.role\s*==\s*["']manager["']/.test(listRoute.body) || /review_scope_id/.test(listRoute.body)) issues.push("GET /customers manager queue must use the PAC-approved global manager policy without undeclared review-scope fields");
    const pendingMember = pythonEnumMemberForValue(modelSource, "CustomerStatus", "pending");
    if (!pendingMember || !new RegExp(`\\bCustomerStatus\\.${escapeRegExp(pendingMember)}\\b`).test(listRoute.body) || !/AuditEvent\.action\s*==\s*["']submitted["']/.test(listRoute.body)) issues.push("GET /customers manager queue must include only submitted pending applications using the declared CustomerStatus enum member");
    if (!/offset\s*\(\s*offset\s*\)/.test(listRoute.body) || !/limit\s*\(\s*limit\s*\)/.test(listRoute.body) || !/status_filter/.test(listRoute.body)) issues.push("GET /customers must support bounded pagination and status filtering");
  }
  if (!detailRoute) issues.push("frontend customer status reload requires GET /customers/{customer_id}");
  else {
    if (/require_role\s*\(\s*["']manager["']\s*\)/i.test(detailRoute.body) || !/get_current_user/.test(detailRoute.body)) issues.push("GET /customers/{customer_id} must support owner and authorized manager reads");
    if (!/Customer\.owner_id\s*==\s*current_user\.id/.test(detailRoute.body) || !/current_user\.role\s*==\s*["']manager["']/.test(detailRoute.body) || /review_scope_id/.test(detailRoute.body)) issues.push("GET /customers/{customer_id} lacks owner-query and global manager authorization");
  }
  const auditRoute = routes.find((route) => route.method === "GET" && route.path === "/customers/{customer_id}/audit");
  if (!auditRoute || !/Customer\.owner_id\s*==\s*current_user\.id/.test(auditRoute.body) || !/current_user\.role\s*==\s*["']manager["']/.test(auditRoute.body) || /review_scope_id/.test(auditRoute.body)) issues.push("customer audit reads must enforce owner-scoped customer access and global manager access without an undeclared review scope");
  return [...new Set(issues)];
}

export function uiOperationsFromCheckpoint(
  checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>,
  architecture: ProjectArchitectureContract,
  files: Map<string, { content: string; action: ProposedEdit["action"] }>,
): { operations: UiOperation[]; issues: string[] } {
  const issues: string[] = [];
  const operations: UiOperation[] = [];
  for (const record of checkpoint.businessOperations ?? []) {
    if (record.architectureHash !== architecture.contractHash || record.sha256 !== createHash("sha256").update(record.content).digest("hex")) {
      issues.push(`saved operation contract ${record.operationId} failed PAC/checksum verification`);
      continue;
    }
    try {
      const operation = JSON.parse(record.content) as UiOperation;
      if (operation.operationId !== record.operationId || !operation.route?.path || !operation.route?.method) {
        issues.push(`saved operation contract ${record.operationId} has an incompatible route interface`);
        continue;
      }
      if (record.operationId !== "auth.login") operations.push(operation);
    } catch {
      issues.push(`saved operation contract ${record.operationId} is not valid JSON`);
    }
  }
  const savedLoginRecord = checkpoint.businessOperations?.find((record) => record.operationId === "auth.login");
  const authSource = files.get("backend/routes/auth.py")?.content ?? "";
  const schemaSource = files.get("backend/schemas.py")?.content ?? "";
  const loginSchema = schemaSource.match(/^class\s+LoginRequest\s*\([^\n]+\):\s*$/m);
  const tokenSchema = schemaSource.match(/^class\s+TokenResponse\s*\([^\n]+\):\s*$/m);
  let loginOperation: AuthenticationLoginOperationSpec | undefined;
  try { loginOperation = savedLoginRecord ? JSON.parse(savedLoginRecord.content) as AuthenticationLoginOperationSpec : undefined; } catch { /* reported below */ }
  const registeredLoginPaths = [...authSource.matchAll(/@router\.post\s*\(\s*["']([^"']+)["']/g)].map((match) => match[1]);
  const loginDecorator = authSource.match(/@router\.post\s*\(\s*["'][^"']+["']([^\n]*)/);
  const routeOk = !!loginOperation && loginOperation.route?.method === "POST" && registeredLoginPaths.includes(loginOperation.route.path);
  const completeMetadata = !!loginOperation?.request?.fields?.length && !!loginOperation.response?.fields?.length
    && loginOperation.request.contentType === "application/json" && loginOperation.response.contentType === "application/json"
    && loginOperation.response.schema === loginOperation.dependencies?.responseSchema
    && loginOperation.session?.scheme === "bearer" && !!loginOperation.session.tokenField;
  if (!savedLoginRecord || !loginOperation || loginOperation.schemaVersion !== "2.0" || !completeMetadata || !routeOk || !loginSchema || !tokenSchema) {
    issues.push("frontend preflight requires a version 2 auth.login contract matching the generated FastAPI route, LoginRequest, and TokenResponse schemas");
  } else {
    if (!/response_model\s*=\s*TokenResponse/.test(loginDecorator?.[1] ?? "") || !/responses\s*=\s*\{\s*401\s*:/.test(loginDecorator?.[1] ?? "")) issues.push("generated auth.login route does not expose its TokenResponse and 401 error contract in OpenAPI");
    issues.push(...validateAuthenticationLoginOperationSpec(loginOperation, architecture, files.get("backend/auth.py")?.content ?? "", files.get("backend/models.py")?.content ?? "", schemaSource));
    const requestFields = loginOperation.request.fields.map((field) => field.name);
    const responseFields = loginOperation.response.fields.map((field) => field.name);
    const actualLoginFields = [...schemaSource.slice(loginSchema.index! + loginSchema[0].length, schemaSource.indexOf("class TokenResponse", loginSchema.index)).matchAll(/^\s{4}([A-Za-z_]\w*)\s*:/gm)].map((match) => match[1]);
    if (JSON.stringify(requestFields) !== JSON.stringify(actualLoginFields)) issues.push("auth.login request schema does not match generated LoginRequest fields");
    if (!responseFields.includes(loginOperation.session.tokenField) || loginOperation.response.schema !== "TokenResponse") issues.push("auth.login response schema does not include its declared session token");
    operations.push({ operationId: "auth.login", route: { method: loginOperation.route.method, path: loginOperation.route.path }, actor: { role: "public" }, requestFields, usernameField: loginOperation.input.usernameField, passwordField: loginOperation.input.passwordField, requestContentType: loginOperation.request.contentType, responseContentType: loginOperation.response.contentType, responseFields, sessionScheme: loginOperation.session.scheme, tokenField: loginOperation.session.tokenField, tokenTypeField: loginOperation.session.tokenTypeField, expirationSeconds: loginOperation.session.expiration.defaultSeconds });
  }
  if (!operations.some((operation) => operation.operationId !== "auth.login")) issues.push("frontend contract requires at least one approved business operation in addition to authentication");
  return { operations, issues };
}

type SavedUiContract = NonNullable<NonNullable<RunnerInput["resumeCheckpoint"]>["uiContracts"]>[number];

export function hasReusableUiContributionCheckpoint(record: SavedUiContract, architectureHash: string, modelId: string | undefined): boolean {
  if (record.architectureHash !== architectureHash || record.modelId !== modelId || !record.modelRequestId || !record.modelResponse || !record.contribution) return false;
  if (record.sha256 !== createHash("sha256").update(record.content).digest("hex")) return false;
  if (record.contributionSha256 !== createHash("sha256").update(record.contribution).digest("hex")) return false;
  const request = record.requestMetadata;
  if (request) {
    if (request.requestId !== record.modelRequestId || request.modelId !== record.modelId || !/^[a-f0-9]{64}$/.test(request.promptSha256)) return false;
    if (request.serializedRequestRedacted?.messages.some((message) => Object.hasOwn(message, "content"))) return false;
  }
  return true;
}

function parseUiContractArtifact(edits: ProposedEdit[]): { contract?: UiContract; error?: string } {
  const specEdits = edits.filter((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "frontend/ui-contract.v1.json");
  if (specEdits.length !== 1) return { error: `model must return exactly one frontend/ui-contract.v1.json artifact (received ${specEdits.length})` };
  const content = specEdits[0].content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return { contract: JSON.parse(content) as UiContract }; }
  catch (error) { return { error: `UI contract JSON could not be parsed: ${(error as Error).message}` }; }
}

export function parseUiContributionResponse(raw: string): { contribution?: UiContractContribution; error?: string } {
  const content = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  if (!content) return { error: "selected model returned an empty UI contribution" };
  let value: unknown;
  try { value = JSON.parse(content); }
  catch (error) { return { error: `UI contribution JSON could not be parsed: ${(error as Error).message}` }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { error: "UI contribution must be a JSON object" };
  const contribution = value as Record<string, unknown>;
  const expected = ["title", "columnOrder", "statusLabels", "emptyState"];
  if (Object.keys(contribution).length !== expected.length || expected.some((key) => !(key in contribution))) {
    return { error: `UI contribution must contain exactly these keys: ${expected.join(", ")}` };
  }
  return { contribution: contribution as unknown as UiContractContribution };
}

async function runCompactUiContribution(
  runner: AgentRunner,
  input: RunnerInput,
  stageMeta: NonNullable<RunnerInput["stagedBuild"]>,
  prompt: string,
  emit: (event: TaskEvent) => void,
  deadlineAt: number,
): Promise<{ rawResponse: string; requestId?: string; diagnostic?: ModelExecutionDiagnostic; error?: string }> {
  const response: string[] = [];
  let requestId: string | undefined;
  let diagnostic: ModelExecutionDiagnostic | undefined;
  let failure: string | undefined;
  const attemptController = new AbortController();
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), attemptController.signal]);
  const remainingMs = deadlineAt - Date.now();
  if (input.signal?.aborted) return { rawResponse: "", error: "staged Build was cancelled" };
  if (remainingMs <= 0) return { rawResponse: "", error: "staged Build exceeded its end-to-end deadline" };
  const operation = runner.run({ ...input, mode: "ask", prompt, projectContext: undefined, stagedBuild: stageMeta, signal }, (event) => {
    if (event.type === "output") response.push(event.delta);
    else if (event.type === "model_diagnostic") { requestId ??= event.diagnostic.requestId; diagnostic = event.diagnostic; emit(event); }
    else if (event.type === "error" || event.type === "provider_failure") failure = event.message;
    else if (event.type === "status" && event.status === "failed") failure ??= "selected model request failed";
    else if (event.type === "usage" || event.type === "step") emit(event);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onParentAbort = () => { attemptController.abort(); cleanup(); const error = new Error("staged Build was cancelled"); error.name = "AbortError"; reject(error); };
      const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", onParentAbort); };
      const timer = setTimeout(() => { attemptController.abort(); cleanup(); reject(new Error("staged Build exceeded its end-to-end deadline")); }, remainingMs);
      input.signal?.addEventListener("abort", onParentAbort, { once: true });
      operation.then(() => { cleanup(); resolve(); }, (error: unknown) => { cleanup(); reject(error); });
    });
  } catch (error) {
    return { rawResponse: response.join(""), ...(requestId ? { requestId } : {}), error: (error as Error).message };
  }
  return { rawResponse: response.join(""), ...(requestId ? { requestId } : {}), ...(diagnostic ? { diagnostic } : {}), ...(failure ? { error: failure } : {}) };
}

function validateResumeCheckpoint(
  checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>,
  input: RunnerInput,
  requirementsHash: string,
  stages: BuildStage[],
  provider: string,
  architecture?: ProjectArchitectureContract,
): string | undefined {
  if (checkpoint.version !== 1) return "checkpoint version is unsupported";
  if (checkpoint.requirementsHash !== requirementsHash) return "approved requirements changed";
  if (checkpoint.provider !== provider) return "selected provider changed";
  if (checkpoint.modelId !== input.modelId) return "selected model changed";
  try {
    const active = activeCheckpointArtifacts(checkpoint);
    if (active.length !== checkpoint.artifacts.length) return "active artifact manifest is incomplete";
    const ownership = buildArtifactOwnershipManifest(checkpoint);
    if (checkpoint.artifactOwnership) {
      const expected = JSON.stringify(ownership.active.map(({ path, sha256 }) => ({ path, sha256 })));
      const actual = JSON.stringify(checkpoint.artifactOwnership.active.map(({ path, sha256 }) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)));
      if (expected !== actual) return "artifact ownership manifest does not match the active artifact paths and checksums";
      const supersededIds = new Set(checkpoint.artifactOwnership.superseded.map((record) => record.artifactId));
      if (checkpoint.artifactOwnership.active.some((record) => record.replacesArtifactId && !supersededIds.has(record.replacesArtifactId))) return "artifact ownership lineage references a missing superseded artifact";
    }
  } catch (error) {
    return `artifact ownership validation failed: ${(error as Error).message}`;
  }
  if (!checkpoint.projectArchitecture && checkpoint.completedStageIds.length > 0) return "checkpoint has no approved project architecture; start a fresh generation to avoid resuming mixed-framework artifacts";
  if (checkpoint.projectArchitecture) {
    const architectureIssues = validateProjectArchitectureContract(checkpoint.projectArchitecture);
    if (architectureIssues.length) return architectureIssues.join("; ");
    if (architecture && checkpoint.projectArchitecture.contractHash !== architecture.contractHash) return "approved project architecture changed during resume";
  }
  for (const subtask of checkpoint.databaseSubtasks ?? []) {
    if (subtask.architectureHash !== checkpoint.projectArchitecture?.contractHash) return `database subtask ${subtask.id} belongs to a different PAC`;
    for (const artifact of subtask.artifacts) {
      const path = artifact.path.replaceAll("\\", "/");
      if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) return `unsafe database subtask artifact path: ${artifact.path}`;
      if (createHash("sha256").update(artifact.content).digest("hex") !== artifact.sha256) return `database subtask checksum mismatch: ${artifact.path}`;
    }
  }
  for (const subtask of checkpoint.backendSubtasks ?? []) {
    if (subtask.architectureHash !== checkpoint.projectArchitecture?.contractHash) return `backend subtask ${subtask.id} belongs to a different PAC`;
    for (const artifact of subtask.artifacts) {
      const path = artifact.path.replaceAll("\\", "/");
      if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) return `unsafe backend subtask artifact path: ${artifact.path}`;
      if (createHash("sha256").update(artifact.content).digest("hex") !== artifact.sha256) return `backend subtask checksum mismatch: ${artifact.path}`;
    }
  }
  for (const operation of checkpoint.businessOperations ?? []) {
    if (operation.architectureHash !== checkpoint.projectArchitecture?.contractHash) return `business operation ${operation.operationId} belongs to a different PAC`;
    if (createHash("sha256").update(operation.content).digest("hex") !== operation.sha256) return `business operation checksum mismatch: ${operation.operationId}`;
  }
  for (const contract of checkpoint.uiContracts ?? []) {
    if (contract.architectureHash !== checkpoint.projectArchitecture?.contractHash) return "UI contract belongs to a different PAC";
    if (contract.modelId !== checkpoint.modelId) return "UI contract was generated by a different selected model";
    if (createHash("sha256").update(contract.content).digest("hex") !== contract.sha256) return "UI contract checksum mismatch";
    if (contract.requestMetadata && (contract.requestMetadata.requestId !== contract.modelRequestId || contract.requestMetadata.modelId !== contract.modelId || !/^[a-f0-9]{64}$/.test(contract.requestMetadata.promptSha256))) return "UI inference request metadata is inconsistent with its model response";
    if (contract.requestMetadata?.serializedRequestRedacted?.messages.some((message) => Object.hasOwn(message, "content"))) return "UI inference request metadata contains unredacted message content";
  }
  for (const record of checkpoint.testSpecifications ?? []) {
    if (record.architectureHash !== checkpoint.projectArchitecture?.contractHash) return "test specification belongs to a different PAC";
    if (record.modelId !== checkpoint.modelId) return "test specification was generated by a different selected model";
    if (createHash("sha256").update(record.content).digest("hex") !== record.sha256) return "test specification checksum mismatch";
    if (record.contribution && record.contributionSha256 !== createHash("sha256").update(record.contribution).digest("hex")) return "model test contribution checksum mismatch";
    if (record.requestMetadata && (record.requestMetadata.requestId !== record.modelRequestId || record.requestMetadata.modelId !== record.modelId || !/^[a-f0-9]{64}$/.test(record.requestMetadata.promptSha256))) return "test contribution request metadata is inconsistent";
  }
  const testSubtaskIssues = validateTestSubtaskCheckpoint(checkpoint);
  if (testSubtaskIssues.length) return testSubtaskIssues.join("; ");
  const count = checkpoint.completedStageIds.length;
  if (count < 0 || (count === 0 && !checkpoint.projectArchitecture) || count >= stages.length || checkpoint.completedStageIds.some((id, index) => stages[index]?.id !== id)) return "completed stage sequence is invalid or already complete";
  const hasCompleteStageSnapshots = checkpoint.stages.length === count && checkpoint.stages.every((stage, index) => stage.id === checkpoint.completedStageIds[index] && stage.artifacts !== undefined);
  if (checkpoint.stages.some((stage) => !stages.some((known) => known.id === stage.id))) return "checkpoint contains an unknown stage record";
  const checkpointArtifacts = [
    ...checkpoint.artifacts,
    ...(checkpoint.attemptedStages ?? []).flatMap((stage) => stage.artifacts),
  ];
  for (const artifact of checkpointArtifacts) {
    const path = artifact.path.replaceAll("\\", "/");
    if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) return `unsafe checkpoint artifact path: ${artifact.path}`;
    if (createHash("sha256").update(artifact.content).digest("hex") !== artifact.sha256) return `artifact checksum mismatch: ${artifact.path}`;
  }
  for (const stage of checkpoint.stages) {
    for (const artifact of stage.artifacts ?? []) {
      const path = artifact.path.replaceAll("\\", "/");
      if (!path || path.startsWith("/") || path.split("/").some((part) => part === "..")) return `unsafe stage snapshot path: ${artifact.path}`;
      if (createHash("sha256").update(artifact.content).digest("hex") !== artifact.sha256) return `stage snapshot checksum mismatch: ${artifact.path}`;
    }
  }
  if (hasCompleteStageSnapshots) {
    const replayed = replayStageSnapshots(checkpoint.stages, checkpoint.stages.length) ?? [];
    const originalPaths = new Set(checkpoint.baseFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
    // A saved checkpoint may have recorded a first-stage proposal as `create`
    // even when that path existed in the original workspace. Reconcile both
    // sides against the original manifest before comparing the replay.
    const expected = normalizeReplayedArtifactActions(checkpoint.artifacts, originalPaths)
      .sort((a, b) => a.path.localeCompare(b.path));
    const actual = normalizeReplayedArtifactActions(replayed, originalPaths)
      .map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(artifact.content).digest("hex") }))
      .sort((a, b) => a.path.localeCompare(b.path));
    const mismatch = expected.find((artifact, index) => artifact.path !== actual[index]?.path || artifact.action !== actual[index]?.action || artifact.content !== actual[index]?.content || artifact.sha256 !== actual[index]?.sha256);
    if (expected.length !== actual.length || mismatch) {
      const index = mismatch ? expected.indexOf(mismatch) : -1;
      const replayedArtifact = index >= 0 ? actual[index] : undefined;
      const field = !replayedArtifact ? "missing from replay" : mismatch!.path !== replayedArtifact.path ? `path=${replayedArtifact.path}` : mismatch!.action !== replayedArtifact.action ? `action=${replayedArtifact.action}` : mismatch!.content !== replayedArtifact.content ? "content differs" : "checksum differs";
      return `stage snapshots do not match the accumulated artifact manifest${mismatch ? ` at ${mismatch.path} (${field})` : ` (expected ${expected.length} artifacts, replayed ${actual.length})`}`;
    }
  }
  return undefined;
}

/** A generated file may be `modify` in a later stage snapshot even though it
 * was first created during this run. The accumulated manifest must keep the
 * original workspace action, derived from the checkpoint's base-file set. */
export function normalizeReplayedArtifactActions<T extends ProposedEdit>(artifacts: T[], originalPaths: Set<string>): T[] {
  return artifacts.map((artifact) => ({
    ...artifact,
    action: originalPaths.has(artifact.path.replaceAll("\\", "/").toLowerCase()) ? "modify" : "create",
  }));
}

/** Older checkpoints captured stage deltas before operation renderers or
 * deterministic router registration finished updating the aggregate manifest.
 * Repair only metadata snapshots when every source artifact checksum is valid
 * and each snapshot path still exists in that authoritative manifest. */
export function repairIncompleteCheckpointStageSnapshot(
  checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>,
): { checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>; changed: boolean } {
  if (!checkpoint.stages.length || checkpoint.stages.length !== checkpoint.completedStageIds.length || checkpoint.stages.some((stage) => !stage.artifacts)) return { checkpoint, changed: false };
  const digest = (content: string) => createHash("sha256").update(content).digest("hex");
  const manifest = new Map(checkpoint.artifacts.map((artifact) => [artifact.path.replaceAll("\\", "/").toLowerCase(), artifact]));
  if (manifest.size !== checkpoint.artifacts.length || checkpoint.artifacts.some((artifact) => digest(artifact.content) !== artifact.sha256)) return { checkpoint, changed: false };
  for (const stage of checkpoint.stages) {
    for (const artifact of stage.artifacts ?? []) {
      if (digest(artifact.content) !== artifact.sha256 || !manifest.has(artifact.path.replaceAll("\\", "/").toLowerCase())) return { checkpoint, changed: false };
    }
  }
  const replayed = new Map<string, ProposedEdit>();
  for (const stage of checkpoint.stages) for (const artifact of stage.artifacts ?? []) replayed.set(artifact.path.replaceAll("\\", "/").toLowerCase(), artifact);
  const originalPaths = new Set(checkpoint.baseFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
  const expected = normalizeReplayedArtifactActions(checkpoint.artifacts, originalPaths).sort((a, b) => a.path.localeCompare(b.path));
  const actual = normalizeReplayedArtifactActions([...replayed.values()], originalPaths).map((artifact) => ({ ...artifact, sha256: digest(artifact.content) })).sort((a, b) => a.path.localeCompare(b.path));
  if (expected.length === actual.length && expected.every((artifact, index) => artifact.path === actual[index]?.path && artifact.action === actual[index]?.action && artifact.content === actual[index]?.content && artifact.sha256 === actual[index]?.sha256)) return { checkpoint, changed: false };
  const lastIndex = checkpoint.stages.length - 1;
  const stages = [...checkpoint.stages];
  stages[lastIndex] = {
    ...stages[lastIndex],
    artifactPaths: expected.map((artifact) => artifact.path),
    artifacts: expected,
  };
  return { checkpoint: { ...checkpoint, stages }, changed: true };
}

function snapshotStageDelta(previous: ProposedEdit[], current: ProposedEdit[], originalPaths: Set<string>) {
  const prior = new Map(previous.map((file) => [file.path.replaceAll("\\", "/").toLowerCase(), file.content]));
  return current.filter((file) => prior.get(file.path.replaceAll("\\", "/").toLowerCase()) !== file.content).map((file) => ({
    path: file.path,
    action: originalPaths.has(file.path.replaceAll("\\", "/").toLowerCase()) ? "modify" as const : "create" as const,
    content: file.content,
    sha256: createHash("sha256").update(file.content).digest("hex"),
  }));
}

export function repairFingerprint(input: { diagnostics: string[]; targetPath: string; relevantCode: string; proposedPatch: string }): {
  fingerprint: string;
  diagnosticHash: string;
  targetPath: string;
  relevantCodeHash: string;
  proposedPatchHash: string;
} {
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const targetPath = input.targetPath.replaceAll("\\", "/").toLowerCase();
  const stableDiagnostics = input.diagnostics
    .map((item) => item.trim())
    .filter((item) => !/^(?:focused repair|the model returned no file edits|ollama (?:response headers|did not finish)|provider (?:timeout|error))/i.test(item));
  const diagnosticHash = hash([...new Set(stableDiagnostics)].sort().join("\n"));
  const relevantCodeHash = hash(input.relevantCode);
  const proposedPatchHash = hash(input.proposedPatch);
  return {
    fingerprint: hash([diagnosticHash, targetPath, relevantCodeHash, proposedPatchHash].join("\0")),
    diagnosticHash,
    targetPath,
    relevantCodeHash,
    proposedPatchHash,
  };
}

function repairProgress(before: string[], after: string[]): boolean {
  if (before.length !== after.length) return true;
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return [...beforeSet].some((issue) => !afterSet.has(issue)) || [...afterSet].some((issue) => !beforeSet.has(issue));
}

function replayStageSnapshots(stages: NonNullable<RunnerInput["resumeCheckpoint"]>["stages"], count: number): ProposedEdit[] | undefined {
  const files = new Map<string, ProposedEdit>();
  for (const stage of stages.slice(0, count)) {
    if (!stage.artifacts) return undefined;
    for (const artifact of stage.artifacts) files.set(artifact.path.replaceAll("\\", "/").toLowerCase(), { path: artifact.path, action: artifact.action, content: artifact.content });
  }
  return [...files.values()];
}

function stagePrompt(original: string, stage: BuildStage, index: number, count: number, architecture: ProjectArchitectureContract, files: ProposedEdit[]): string {
  if (stage.id === "tests") {
    return [
      `MobiusX generation checkpoint ${index + 1}/${count}: tests.`,
      "Generate application-specific tests only. A compact contract-derived test specification, actual operation contracts, and the UI contract are supplied separately.",
      "Approved architecture:", JSON.stringify({ schemaVersion: architecture.schemaVersion, contractHash: architecture.contractHash, stack: architecture.stack }),
      "Original application requirements:", original.slice(0, 5_000),
      stage.instruction,
      "Never edit application source. Use actual routes/schemas/labels only; report unsupported acceptance cases as a gap.",
    ].join("\n");
  }
  const taskSpecification = architectureTaskSpecification(architecture, stage.id, files.map(({ path, content }) => ({ path, content })));
  const approvedPaths = new Set((taskSpecification.approvedFileManifest as string[]).map((path) => path.toLowerCase()));
  const stageArchitecture = {
    schemaVersion: architecture.schemaVersion,
    contractHash: architecture.contractHash,
    stack: architecture.stack,
    modules: architecture.modules.filter((module) => approvedPaths.has(module.path.toLowerCase())),
  };
  return [
    "Original application request (must remain the source of truth):",
    original,
    "",
    `MobiusX generation checkpoint ${index + 1}/${count}: ${stage.id}.`,
    "Architecture contract slice (from the immutable checkpoint PAC; do not change its stack or declared module paths):",
    JSON.stringify(stageArchitecture),
    "Structured task specification (authoritative JSON; generate only exact target paths and preserve validated interfaces):",
    JSON.stringify(taskSpecification),
    stage.instruction,
    "This is an implementation request: use reasonable, conventional defaults for unspecified details and proceed without asking routine clarification questions. Ask only when the requirements are contradictory or a missing decision prevents a safe, correct implementation. Return complete file contents in the normal structured edit format. Keep the project runnable as it evolves. Use only project-relative paths. Files included in the supplied project context are present in full: use action modify for those; use create only for new paths. Do not claim a build, migration, API test, or browser test ran unless MobiusX supplies actual command output.",
  ].join("\n");
}

type DatabaseSubtask = { id: string; targetPaths: string[]; acceptanceCriteria: string[] };

/** Keep database inference small and resume each valid entity/migration independently. */
export function databaseSubtaskPlan(architecture: ProjectArchitectureContract): DatabaseSubtask[] {
  const model = architecture.modules.find((item) => item.path.toLowerCase() === "backend/models.py")?.path ?? "backend/models.py";
  const migration = architecture.modules.find((item) => /backend\/migrations\/versions\/[^/]+\.py$/i.test(item.path))?.path ?? "backend/migrations/versions/0001_initial.py";
  return [
    { id: "customer-entity", targetPaths: [model], acceptanceCriteria: ["Define SQLAlchemy 2.x Customer mapped class with id, name, email, status, created_at, and owner_id", "Use CustomerStatus values pending, approved, rejected, and configure sqlalchemy.Enum with values_callable to persist each enum member value", "Use the PAC Base and imports from backend/database.py", "Use no ORM other than SQLAlchemy"] },
    { id: "related-entities", targetPaths: [model], acceptanceCriteria: ["Add User with id, username, password_hash, and non-null String role; declare User.customers back_populates=owner and User.audit_events back_populates=user", "Add AuditEvent with id, user_id FK, customer_id FK, action, and created_at; declare AuditEvent.user back_populates=audit_events and AuditEvent.customer back_populates=audit_events", "Ensure Customer.owner_id references users.id and Customer.audit_events reciprocates AuditEvent.customer; preserve the validated Customer class and enum mapping", "Use the PAC Base and SQLAlchemy 2.x; alias Python enum base imports so they do not shadow sqlalchemy.Enum"] },
    { id: "schema-constraints", targetPaths: [model], acceptanceCriteria: ["Add non-null and unique constraints for User.username, Customer.name/email, Customer.owner_id, and AuditEvent.user_id/customer_id; index query fields", "Preserve reciprocal relationships, enum value mapping, and existing database column names", "Return the complete updated model module"] },
    { id: "alembic-revision", targetPaths: [migration], acceptanceCriteria: ["Return one executable Alembic revision with revision and down_revision identifiers", "Create the SQLAlchemy tables, indexes, foreign keys, and constraints in dependency order", "Name PostgreSQL ENUM types explicitly so the migration executes on PostgreSQL", "downgrade removes objects safely in reverse dependency order", "Do not put revision operations in migrations/env.py"] },
    ...(architecture.reviewScope ? [{ id: "review-scope-schema", targetPaths: [model, "backend/migrations/versions/0002_review_scopes.py"], acceptanceCriteria: ["Add PAC ReviewScope plus user and customer review_scope_id foreign keys", "Backfill existing users/customers into a default scope without losing data", "Require customer creation to inherit the authenticated customer's persisted scope", "Add an indexed, reversible Alembic revision after the existing head", "Do not allow manager access without a matching persisted review scope"] }] : []),
  ];
}

/** Backend work is split along PAC module boundaries so a repair never has to
 * replace the entire API implementation. Repeated target paths represent
 * cumulative full-file revisions, each independently checked and resumable. */
export function backendSubtaskPlan(architecture: ProjectArchitectureContract): DatabaseSubtask[] {
  const modulePath = (suffix: string, fallback: string) => architecture.modules.find((item) => item.path.toLowerCase() === suffix.toLowerCase())?.path ?? fallback;
  const schemas = modulePath("backend/schemas.py", "backend/schemas.py");
  const auth = modulePath("backend/auth.py", "backend/auth.py");
  const authRoutes = modulePath("backend/routes/auth.py", "backend/routes/auth.py");
  const customers = modulePath("backend/routes/customers.py", "backend/routes/customers.py");
  const main = modulePath("backend/main.py", "backend/main.py");
  return [
    { id: "backend-schemas", targetPaths: [schemas], acceptanceCriteria: ["Define CustomerCreate with validated name/email fields", "Define CustomerResponse with id, name, email, status, created_at, and owner_id", "Define LoginRequest and TokenResponse for bearer JWT authentication", "Use Pydantic v2-compatible schemas and match backend.models names"] },
    { id: "authentication", targetPaths: [auth], acceptanceCriteria: ["Use async SQLAlchemy AsyncSession and backend.database.get_db", "Authenticate User by username and verify password_hash using passlib CryptContext", "Issue and validate JWT using settings.secret_key and an explicit algorithm/expiry", "Expose authenticate_user, get_current_user, and require_role dependencies", "Return 401 for invalid credentials/token and 403 for insufficient role"] },
    { id: "role-authorization", targetPaths: [auth], acceptanceCriteria: ["Preserve valid authentication helpers", "Implement reusable role dependency that checks persisted User.role", "Only manager role can make approval/rejection decisions", "Do not trust role claims from request body or client-supplied headers"] },
    { id: "customer-repository-service", targetPaths: [customers], acceptanceCriteria: ["Use asynchronous SQLAlchemy selects and the PAC Customer/User/AuditEvent models", "Implement reusable customer lookup and persistence helpers in this approved route module", "Scope customer reads and writes to the authenticated owner unless manager access is explicitly required", "Handle duplicate email/name using a transaction-safe database error response"] },
    { id: "customer-registration-api", targetPaths: [customers], acceptanceCriteria: ["Expose POST /customers and GET /customers/{customer_id}", "Require an authenticated customer user", "Set owner_id from authenticated identity and initial status to pending", "Commit customer creation and initial audit event atomically", "Return the PAC response schema and appropriate 201/404/409 status codes"] },
    { id: "submission-api", targetPaths: [customers], acceptanceCriteria: ["Expose POST /customers/{customer_id}/submit", "The validated PAC enum has only pending/approved/rejected: use pending as the persisted submitted/awaiting-review status, and distinguish an unsubmitted registration from a submitted customer using the submitted AuditEvent; do not add enum values or alter the migration", "Allow only the owning authenticated user to submit; reject repeat submission and invalid transitions", "Inside one AsyncSession transaction, explicitly persist CustomerStatus.PENDING and the actor-attributed submitted AuditEvent; context rollback must undo both on failure"] },
    { id: "manager-decision-api", targetPaths: [customers], acceptanceCriteria: ["Expose manager-only approval and rejection endpoints for submitted customers", "Enforce User.role authorization from the database", "Require current status pending plus a submitted AuditEvent; reject other/duplicate decisions", "Update status to the PAC approved/rejected enum and insert actor-attributed audit event atomically", "Rollback both changes when either operation fails"] },
    { id: "audit-history-api", targetPaths: [customers, schemas], acceptanceCriteria: ["Persist the versioned customer.audit.read operation contract against the unchanged PAC", "Expose audit history only after server-side authorization of the customer record", "Allow the owning customer to read their own history using Customer.owner_id", "Allow authenticated managers to read history for any customer without inventing review-scope entities or fields", "Return audit events in deterministic created_at and id order", "Use Pydantic response schemas with ORM attribute validation"] },
    { id: "auth-api", targetPaths: [authRoutes], acceptanceCriteria: ["Expose POST /auth/login", "Validate credentials through backend.auth.authenticate_user", "Issue the bearer token through the PAC backend.auth token-issuance helper and return the approved TokenResponse schema; never return a constant or fabricated token", "Reject invalid credentials with HTTP 401", "Never return password_hash or log credentials"] },
    { id: "router-registration", targetPaths: [main], acceptanceCriteria: ["Preserve the existing FastAPI app and health endpoint", "Register only approved backend.routes.auth and backend.routes.customers routers", "Configure CORS from backend.config.settings.cors_origins", "Provide startup/shutdown handling for the async SQLAlchemy engine"] },
  ];
}

export function backendSubtaskIssues(subtask: DatabaseSubtask, edits: ProposedEdit[], architecture: ProjectArchitectureContract): string[] {
  const issues: string[] = [];
  const allowed = new Set(subtask.targetPaths.map((path) => path.toLowerCase()));
  for (const edit of edits) if (!allowed.has(edit.path.replaceAll("\\", "/").toLowerCase())) issues.push(`unapproved generated path ${edit.path}`);
  const combined = edits.map((edit) => edit.content).join("\\n");
  const required: Record<string, string[]> = {
    "backend-schemas": ["CustomerCreate", "CustomerResponse", "LoginRequest", "TokenResponse"],
    authentication: ["authenticate_user", "get_current_user", "require_role"],
    "role-authorization": ["require_role"],
    "customer-repository-service": ["AsyncSession", "Customer"],
    "customer-registration-api": ["/customers", "CustomerCreate", "AuditEvent"],
    "submission-api": ["submit", "AuditEvent"],
    "manager-decision-api": ["approve", "reject", "require_role", "AuditEvent"],
    "audit-history-api": ["audit", "AuditEvent"],
    "auth-api": ["/login", "authenticate_user", "TokenResponse"],
    "router-registration": ["include_router", "auth", "customers"],
  };
  if (subtask.id === "review-scope-schema") {
    if (!combined.includes("class ReviewScope(Base)") || !/review_scope_id\s*=\s*Column\([^\n]*ForeignKey\("review_scopes\.id"\)/.test(combined)) issues.push("PAC review-scope model and foreign keys are incomplete");
    if (!/revision\s*=\s*["']0002_review_scopes["']/.test(combined) || !/down_revision\s*=\s*["']0001_initial["']/.test(combined) || !combined.includes("setval(pg_get_serial_sequence")) issues.push("review-scope Alembic revision is missing, not ordered after initial schema, or does not seed its identity sequence");
  }
  for (const symbol of required[subtask.id] ?? []) if (!combined.toLowerCase().includes(symbol.toLowerCase())) issues.push(`${subtask.id} is missing required contract symbol or route marker ${symbol}`);
  if (subtask.id === "auth-api") {
    if (!/@router\.post\s*\(\s*["']\/auth\/login["']/.test(combined)) issues.push("auth-api must register POST /auth/login on the approved FastAPI router");
    if (!/response_model\s*=\s*TokenResponse/.test(combined)) issues.push("auth-api must declare TokenResponse as the login response model");
    if (!/await\s+authenticate_user\s*\(/.test(combined)) issues.push("auth-api must validate the submitted credentials through authenticate_user");
    if (!/await\s+create_access_token\s*\(/.test(combined)) issues.push("auth-api must issue a signed token through create_access_token; constant tokens are forbidden");
    if (!/HTTPException\s*\(\s*status_code\s*=\s*(?:status\.)?HTTP_401_UNAUTHORIZED/.test(combined)) issues.push("auth-api must reject invalid credentials with HTTP 401");
    if (!/from\s+backend\.schemas\s+import[^\n]*\b(?:LoginRequest|TokenResponse)\b/.test(combined)) issues.push("auth-api must import the approved LoginRequest and TokenResponse schemas");
  }
  if (subtask.id === "router-registration") {
    for (const match of combined.matchAll(/^from\s+(?:backend\.)?routes\s+import\s+(auth|customers)\s+as\s+([A-Za-z_]\w*)\s*$/gm)) {
      if (new RegExp(`app\\.include_router\\s*\\(\\s*${match[2]}\\s*\\)`).test(combined)) issues.push(`router-registration imports the ${match[1]} module instead of its APIRouter symbol`);
    }
    const included = [...combined.matchAll(/app\.include_router\s*\(\s*([A-Za-z_]\w*)\s*\)/g)].map((match) => match[1]);
    if (new Set(included).size !== included.length) issues.push("router-registration includes the same router more than once");
  }
  if (subtask.id === "backend-schemas") {
    for (const response of combined.matchAll(/^class\s+([A-Za-z_]\w*Response)\s*\(BaseModel\)\s*:\s*([\s\S]*?)(?=^class\s|\Z)/gm)) {
      if (!/model_config\s*=\s*ConfigDict\([^\n]*from_attributes\s*=\s*True/.test(response[2]) && !/orm_mode\s*=\s*True/.test(response[2])) issues.push(`${response[1]} must enable ORM attribute validation for SQLAlchemy response models`);
    }
  }
  if (subtask.id === "audit-history-api") {
    if (!combined.includes("AuditEventResponse")) issues.push("audit-history-api is missing the AuditEventResponse contract");
    if (architecture.reviewScope) {
      if (!/Customer\.owner_id\s*==\s*current_user\.id/.test(combined) || !/Customer\.review_scope_id\s*==\s*current_user\.review_scope_id/.test(combined)) issues.push("read APIs must enforce customer ownership and manager review scope in SQL");
      if (!/CustomerStatus\.PENDING/.test(combined) || !/AuditEvent\.action\s*==\s*["']submitted["']/.test(combined)) issues.push("manager queue must include only submitted pending applications");
      if (!/CustomerPageResponse/.test(combined) || !/offset\s*\(\s*offset\s*\)/.test(combined) || !/limit\s*\(\s*limit\s*\)/.test(combined)) issues.push("customer dashboard list must return a bounded paginated response");
    } else {
      if (!/get_current_user/.test(combined) || !/current_user\.role/.test(combined) || !/Customer\.owner_id\s*==\s*current_user\.id/.test(combined)) issues.push("audit history must enforce owner-or-global-manager authorization in the server-side subject query");
      if (!/current_user\.role\s*==\s*["']manager["']/.test(combined)) issues.push("audit history must explicitly allow the approved manager role");
      if (/review_scope_id/.test(combined)) issues.push("audit history references a review scope that is not present in the approved PAC");
    }
    if (!/order_by\s*\(/.test(combined) || !/AuditEvent\.created_at\.asc\(\)/.test(combined)) issues.push("audit history must be ordered oldest to newest");
  }
  if (architecture.stack.orm.toLowerCase() === "sqlalchemy" && /\b(?:Tortoise|in_transaction|\.filter\s*\()/.test(combined)) issues.push(`${subtask.id} contains an ORM API incompatible with SQLAlchemy`);
  if (["authentication", "role-authorization"].includes(subtask.id)) {
    if (/(?:SECRET_KEY|JWT_SECRET|JWT_SECRET_KEY|API_KEY|PASSWORD)\s*=\s*["'][^"']+["']/i.test(combined)) issues.push("authentication contains a hardcoded credential; secrets must come from required environment configuration");
    if (/async\s+with\s+get_db\s*\(/.test(combined)) issues.push("get_db is an async-generator dependency; inject AsyncSession with Depends(get_db) instead of using async with get_db()");
    if (/async\s+def\s+require_role\s*\(/.test(combined)) issues.push("require_role must be a synchronous dependency factory that returns the role-check dependency");
    if (/\bOAuth2PasswordBearer\b/.test(combined) && !/^from\s+fastapi\.security\s+import[^\n]*\bOAuth2PasswordBearer\b/m.test(combined)) issues.push("authentication must import OAuth2PasswordBearer from fastapi.security");
    if (/\bOAuth2PasswordRequestForm\b/.test(combined) && !/^from\s+fastapi\.security\s+import[^\n]*\bOAuth2PasswordRequestForm\b/m.test(combined)) issues.push("authentication must import OAuth2PasswordRequestForm from fastapi.security");
    if (/settings\.\w*algorithm/.test(combined)) issues.push("JWT algorithm settings are not declared by the approved PAC Settings interface; use the approved HS256 default");
    if (!/crypt_context\.verify\s*\(/.test(combined)) issues.push("authentication must verify the stored password hash with the configured password context");
    if (!/CryptContext\s*\(/.test(combined) || !/^from\s+passlib\.context\s+import\s+CryptContext\b/m.test(combined)) issues.push("authentication must configure a Passlib CryptContext for stored password hashes");
    if (!/Depends\s*\(\s*get_db\s*\)/.test(combined)) issues.push("authentication must use the shared AsyncSession dependency from backend.database.get_db");
    if (!/^async\s+def\s+get_current_user\([^\n]*\bdb\s*:\s*AsyncSession\s*=\s*Depends\(get_db\)/m.test(combined)) issues.push("get_current_user must receive the shared AsyncSession through Depends(get_db)");
    if (/get_user\(username,\s*db\)/.test(combined) && !/async\s+def\s+(?:authenticate_user|get_current_user)\s*\([^)]*\bdb\s*:/s.test(combined)) issues.push("authentication lookup references db without injecting the AsyncSession into its dependency");
    if (/return\s+Depends\s*\(\s*\w+\s*\)/.test(combined)) issues.push("role dependency factory must return the inner dependency callable, not a Depends instance");
    if (/\bselect\s*\(/.test(combined) && !/^from\s+sqlalchemy\s+import[^\n]*\bselect\b/m.test(combined)) issues.push("authentication calls SQLAlchemy select() without importing it");
    if (/await\s+\w+\.execute\([^\n]*\)\.scalar\s*\(/.test(combined)) issues.push("await the AsyncSession.execute() result before calling scalar_one_or_none()");
    if (!/(?:current_user|user)\.role\s*!=\s*(?:required_role|role)\b/.test(combined)) issues.push("role authorization must compare the authenticated database user's persisted role with the required role");
    if (!/status\.HTTP_403_FORBIDDEN/.test(combined)) issues.push("role authorization must reject insufficient roles with HTTP 403");
  }
  if (["submission-api", "manager-decision-api"].includes(subtask.id)) {
    const route = subtask.id === "submission-api" ? /\/customers\/\{[^}]+\}\/submit/i : /\/customers\/\{[^}]+\}\/(?:approve|reject)/i;
    const handlers = pythonRouteHandlerBodies(combined, route);
    const helperBody = combined.match(/async\s+def\s+atomic_request_transaction\s*\([^)]*\)\s*:\s*([\s\S]*?)(?=\n(?:async\s+def|def|@router\.|router\s*=)|$)/)?.[1] ?? "";
    const transactionHelperSafe = /if\s+active_transaction\s+is\s+None\s*:[\s\S]*async\s+with\s+db\.begin\s*\(\)[\s\S]*yield[\s\S]*await\s+active_transaction\.commit\s*\(\)[\s\S]*except\s+BaseException[\s\S]*await\s+active_transaction\.rollback\s*\(\)/.test(helperBody);
    const atomicHandler = (body: string) => {
      const transaction = body.match(/async\s+with\s+(?:atomic_request_transaction\s*\(\s*db\s*\)|(?:session|db|db_session)\.begin\s*\(\s*\))\s*:\s*([\s\S]*?)(?=\n\s{0,3}(?:except|finally)\b|$)/);
      if (!transaction || !/\.status\s*=/.test(transaction[1]) || !/(?:db|session|db_session)\.add\s*\(\s*AuditEvent\s*\(/.test(transaction[1])) return false;
      return !/atomic_request_transaction\s*\(\s*db\s*\)/.test(body) || transactionHelperSafe;
    };
    if (subtask.id === "manager-decision-api") {
      for (const [action, targetState] of [["approve", "APPROVED"], ["reject", "REJECTED"]]) {
        const matching = pythonRouteHandlerBodies(combined, new RegExp(`/customers/\\{[^}]+\\}/${action}`, "i"));
        const body = matching[0] ?? "";
        if (!body || !atomicHandler(body)) issues.push(`manager ${action} must atomically update status and persist its audit event`);
        if (!new RegExp(`status\\s*=\\s*CustomerStatus\\.${targetState}`, "i").test(body)) issues.push(`manager ${action} must set CustomerStatus.${targetState}`);
        if (!/require_role\s*\(\s*["']manager["']\s*\)/.test(body)) issues.push(`manager ${action} must require the persisted manager role`);
        if (!/with_for_update\s*\(/.test(body)) issues.push(`manager ${action} must lock the customer row to serialize concurrent decisions`);
        if (!/status[^\n]*pending|pending[^\n]*status/i.test(body)) issues.push(`manager ${action} must require the pending source state`);
        if (!/submitted/.test(body)) issues.push(`manager ${action} must require the prior submitted audit event`);
        const auditAction = action === "approve" ? "approved" : "rejected";
        if (!new RegExp(`action\\s*=\\s*["']${auditAction}["']`, "i").test(body)) issues.push(`manager ${action} must record its actor-attributed audit event`);
        if (architecture.reviewScope && !/Customer\.review_scope_id\s*==\s*current_user\.review_scope_id/.test(body)) issues.push(`manager ${action} must enforce the persisted PAC review scope in its SQL row lookup`);
      }
    } else if (!handlers.some(atomicHandler)) issues.push(`${subtask.id} must update customer status and persist AuditEvent inside the same handler transaction (async with db.begin())`);
    if (handlers.some((body) => /await\s+(?:db|session|db_session)\.(?:commit|rollback)\s*\(/.test(body))) issues.push(`${subtask.id} must not split the status and audit unit of work with manual commits or rollbacks`);
  }
  if (subtask.id === "customer-registration-api") {
    const registration = pythonRouteHandlerBodies(combined, /\/customers\s*["']/i);
    const registrationBody = registration[0] ?? "";
    if (!/create_customer\s*\([^\n]*require_role\s*\(\s*["']customer["']\s*\)/s.test(registrationBody)) issues.push("customer registration must assign ownership to the authenticated customer role that submits the customer for approval");
    if (!/\basync\s+with\s+(?:atomic_request_transaction\s*\(\s*db\s*\)|(?:session|db|db_session)\.begin\s*\(\s*\))/.test(registrationBody)) issues.push("customer registration and its initial audit record must share one database transaction");
    const transactionBody = registration[0]?.match(/async\s+with\s+(?:atomic_request_transaction\s*\(\s*db\s*\)|(?:session|db|db_session)\.begin\s*\(\s*\))\s*:\s*([\s\S]*?)(?=\n\s{0,3}(?:except|finally)\b|$)/)?.[1] ?? "";
    if (!/(?:db|session|db_session)\.add\s*\(\s*AuditEvent\s*\(/.test(transactionBody)) issues.push("customer creation and the initial actor-attributed audit event must be persisted in the same transaction");
    if (/\bawait\s+(?:session|db|db_session)\.(?:commit|rollback)\s*\(/.test(registrationBody)) issues.push("customer registration must use the transaction context for atomic customer and audit persistence, not separate commits");
    if (architecture.reviewScope && !/review_scope_id\s*=\s*current_user\.review_scope_id/.test(registrationBody)) issues.push("customer registration must inherit the authenticated user's PAC review scope");
  }
  if (subtask.id === "submission-api") {
    const registrationRole = combined.match(/create_customer\s*\([^\n]*current_user\s*:\s*User\s*=\s*Depends\s*\(\s*require_role\s*\(\s*["']([^"']+)["']\s*\)\s*\)/)?.[1];
    const submissionRole = combined.match(/submit_customer\s*\([^\n]*current_user\s*:\s*User\s*=\s*Depends\s*\(\s*require_role\s*\(\s*["']([^"']+)["']\s*\)\s*\)/)?.[1];
    if (registrationRole !== "customer" || submissionRole !== "customer") issues.push("customer registration and submission must use the same authenticated customer owner role");
  }
  if (subtask.id === "manager-decision-api" && !/require_role\s*\(\s*["']manager["']\s*\)/.test(combined)) issues.push("approval and rejection routes must depend on require_role('manager')");
  return issues;
}

/** Extract top-level FastAPI route handler bodies so a transaction elsewhere
 * in a module cannot satisfy an unrelated endpoint's atomicity contract. */
function pythonRouteHandlerBodies(source: string, routePattern: RegExp): string[] {
  const lines = source.split(/\r?\n/);
  const bodies: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/^\s*@\w+\.(?:post|put|patch)\s*\(/i.test(lines[index])) continue;
    const decorators: string[] = [lines[index]];
    let signatureIndex = index + 1;
    while (signatureIndex < lines.length && /^\s*@/.test(lines[signatureIndex])) decorators.push(lines[signatureIndex++]);
    if (!decorators.some((line) => routePattern.test(line))) continue;
    while (signatureIndex < lines.length && !/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(lines[signatureIndex])) signatureIndex += 1;
    if (signatureIndex >= lines.length) continue;
    const functionIndent = lines[signatureIndex].match(/^\s*/)?.[0].length ?? 0;
    let end = signatureIndex + 1;
    while (end < lines.length) {
      const indent = lines[end].match(/^\s*/)?.[0].length ?? 0;
      if (lines[end].trim() && indent <= functionIndent && /^(?:async\s+)?(?:def|class)\s+\w+\b/.test(lines[end].trim())) break;
      end += 1;
    }
    bodies.push(lines.slice(signatureIndex, end).join("\n"));
    index = signatureIndex;
  }
  return bodies;
}

export function backendSubtaskContext(subtask: DatabaseSubtask, context: ProjectContext): ProjectContext {
  const path = (file: { relPath: string }) => file.relPath.replaceAll("\\", "/").toLowerCase();
  const common = new Set(["backend/database.py", "backend/models.py", "backend/schemas.py", "backend/auth.py"]);
  if (subtask.id.includes("customer") || ["submission-api", "manager-decision-api", "audit-history-api"].includes(subtask.id)) common.add("backend/routes/customers.py");
  if (subtask.id === "auth-api") {
    common.add("backend/routes/auth.py");
    common.add("backend/config.py");
  }
  if (subtask.id === "router-registration") {
    common.add("backend/routes/auth.py");
    common.add("backend/routes/customers.py");
    common.add("backend/main.py");
    common.add("backend/config.py");
  }
  for (const target of subtask.targetPaths) common.add(target.toLowerCase());
  return { ...context, relevantFiles: (context.relevantFiles ?? []).filter((file) => common.has(path(file))) };
}

/** Keep transaction-critical requirements concrete for small local coding models. */
export function backendSubtaskExecutionRules(subtask: DatabaseSubtask, architecture: ProjectArchitectureContract): string[] {
  if (!["customer-registration-api", "submission-api", "manager-decision-api"].includes(subtask.id)) return [];
  if (architecture.stack.orm.toLowerCase() !== "sqlalchemy") return [];
  return [
    "SQLAlchemy AsyncSession transaction protocol (mandatory): begin the transaction before the first query or write using `async with db.begin():`; load and validate the entity inside that block; mutate the ORM entity and call `db.add(AuditEvent(...))` inside the same block; do not call `db.commit()` or `db.rollback()` because the context manager commits on success and rolls back on exceptions.",
    "Status mapping is pre-approved for this PAC: CustomerStatus has only PENDING/APPROVED/REJECTED. Treat pending plus a submitted AuditEvent as the domain state Submitted; a registered record without a submitted event is still Draft. Never invent a Draft or Submitted enum member or alter the migration. Enforce lifecycle transitions with the existing status and audit rows.",
  ];
}

/** Keep backend requests focused on the approved workflow while retaining
 * project-specific requirements that mention its entities, security, or
 * persistence. The PAC and subtask contract carry the exact stack/interfaces. */
export function compactBackendRequirements(prompt: string, maxChars = 2_400): string {
  const lines = prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const selected = new Set<string>();
  if (lines[0]) selected.add(lines[0]);
  const relevant = /customer|onboard|approv|reject|audit|authenticat|authorization|role|postgres|fastapi|transaction|persist|manager|owner/i;
  for (const line of lines) {
    if (!relevant.test(line)) continue;
    selected.add(line);
  }
  let result = [...selected].join("\n");
  if (!result) result = prompt.slice(0, maxChars);
  if (result.length > maxChars) result = `${result.slice(0, maxChars - 1).trimEnd()}…`;
  return result;
}

/** Correct narrowly recognizable FastAPI auth mistakes without changing the PAC. */
export function repairKnownFastApiAuthIssues(edits: ProposedEdit[]): { edits: ProposedEdit[]; changedPaths: string[]; repairs: string[] } {
  const changedPaths: string[] = [];
  const repairs: string[] = [];
  const next = edits.map((edit) => {
    const normalizedPath = edit.path.replaceAll("\\", "/").toLowerCase();
    if (normalizedPath !== "backend/auth.py" && normalizedPath !== "backend/routes/auth.py") return edit;
    let content = edit.content;
    const record = (description: string) => repairs.push(description);
    if (normalizedPath === "backend/routes/auth.py") {
      const schemaSymbols = ["CustomerCreate", "CustomerResponse", "LoginRequest", "TokenResponse"];
      const referenced = schemaSymbols.filter((name) => new RegExp(`\\b${name}\\b`).test(content));
      const schemaImport = content.match(/^from\s+backend\.schemas\s+import\s+([^\n]+)$/m);
      const imported = new Set((schemaImport?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
      const missing = referenced.filter((name) => !imported.has(name));
      const authSymbols = ["authenticate_user", "create_access_token", "get_current_user", "require_role", "JWT_ACCESS_TOKEN_EXPIRE_MINUTES", "JWT_ALGORITHM"];
      const authReferenced = authSymbols.filter((name) => new RegExp(`\\b${name}\\b`).test(content));
      const authImport = content.match(/^from\s+backend\.auth\s+import\s+([^\n]+)$/m);
      const authImported = new Set((authImport?.[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean));
      const missingAuth = authReferenced.filter((name) => !authImported.has(name));
      const hasTimedelta = /\btimedelta\s*\(/.test(content);
      const hasDatetimeImport = /^from\s+datetime\s+import\s+[^\n]*\btimedelta\b/m.test(content);
      if (!missing.length && !missingAuth.length && (!hasTimedelta || hasDatetimeImport)) return edit;
      if (missing.length && schemaImport) content = content.replace(schemaImport[0], `from backend.schemas import ${[...imported, ...missing].join(", ")}`);
      else if (missing.length) content = `from backend.schemas import ${missing.join(", ")}\n${content}`;
      if (missingAuth.length && authImport) content = content.replace(authImport[0], `from backend.auth import ${[...authImported, ...missingAuth].join(", ")}`);
      else if (missingAuth.length) content = `from backend.auth import ${missingAuth.join(", ")}\n${content}`;
      if (hasTimedelta && !hasDatetimeImport) {
        const datetimeImport = content.match(/^from\s+datetime\s+import\s+([^\n]+)$/m);
        if (datetimeImport) {
          const datetimeNames = new Set(datetimeImport[1].split(",").map((name) => name.trim()));
          if (!datetimeNames.has("timedelta")) content = content.replace(datetimeImport[0], `from datetime import ${[...datetimeNames, "timedelta"].join(", ")}`);
        } else content = `from datetime import timedelta\n${content}`;
      }
      record(`resolved approved auth route imports${missing.length ? `: schemas ${missing.join(", ")}` : ""}${missingAuth.length ? `: auth ${missingAuth.join(", ")}` : ""}${hasTimedelta && !hasDatetimeImport ? ": datetime.timedelta" : ""}`);
      changedPaths.push(edit.path);
      return { ...edit, content };
    }
    if (/settings\.jwt_algorithm|settings\.algorithm/.test(content)) {
      content = content.replace(/settings\.(?:jwt_)?algorithm/g, '"HS256"');
      record("replaced an undeclared JWT settings field with the PAC-compatible HS256 algorithm");
    }
    if (/async\s+def\s+require_role\s*\(/.test(content)) {
      content = content.replace(/async\s+def\s+require_role\s*\(/, "def require_role(");
      record("made require_role a synchronous dependency factory");
    }
    const getUserStart = content.search(/^async\s+def\s+get_user\s*\(/m);
    if (getUserStart >= 0) {
      const nextFunction = content.slice(getUserStart).search(/^async\s+def\s+(?!get_user\b)\w+\s*\(|^def\s+(?!get_user\b)\w+\s*\(/m);
      const end = nextFunction < 0 ? content.length : getUserStart + nextFunction;
      const original = content.slice(getUserStart, end);
      const replacement = "async def get_user(username: str, db: AsyncSession):\n    result = await db.execute(select(User).where(User.username == username))\n    return result.scalar_one_or_none()\n\n";
      if (!/db:\s*AsyncSession/.test(original) || /async\s+with\s+get_db\s*\(/.test(original) || /db\.select\s*\(/.test(original)) {
        content = content.slice(0, getUserStart) + replacement + content.slice(end);
        record("rewrote get_user to use injected AsyncSession and SQLAlchemy select");
      }
    }
    const beforeSessionWiring = content;
    content = content.replace(/^(async\s+def\s+authenticate_user\()([^\n]*)(\):\s*)$/m, (_match, prefix: string, args: string, suffix: string) => `${prefix}${/\bdb\s*:/.test(args) ? args : `${args}, db: AsyncSession = Depends(get_db)`}${suffix}`);
    content = content.replace(/^(async\s+def\s+get_current_user\()([^\n]*)(\):\s*)$/m, (_match, prefix: string, args: string, suffix: string) => `${prefix}${/\bdb\s*:/.test(args) ? args : `${args}, db: AsyncSession = Depends(get_db)`}${suffix}`);
    content = content.replace(/get_user\(username\)/g, "get_user(username, db)");
    if (content !== beforeSessionWiring) record("injected the shared AsyncSession into authentication lookups");
    if (/return\s+Depends\s*\(\s*(\w+)\s*\)/.test(content)) {
      content = content.replace(/return\s+Depends\s*\(\s*(\w+)\s*\)/g, "return $1");
      record("returned the role-check callable from the dependency factory");
    }
    const authenticationLookup = content.match(/^(\s*)user\s*=\s*await\s+get_user\(username,\s*db\)\s*$/m);
    if (authenticationLookup && !/crypt_context\.verify\s*\(password,\s*user\.password_hash\s*\)/.test(content)) {
      const guard = `${authenticationLookup[1]}if not user or not crypt_context.verify(password, user.password_hash):\n${authenticationLookup[1]}    return False`;
      content = content.replace(authenticationLookup[0], `${authenticationLookup[0]}\n${guard}`);
      record("added the required password-hash verification and invalid-credential result");
    }
    if (/\bselect\s*\(/.test(content) && !/^from\s+sqlalchemy\s+import[^\n]*\bselect\b/m.test(content)) {
      const importLine = content.match(/^from\s+sqlalchemy\.ext\.asyncio\s+import[^\n]*$/m);
      if (importLine) content = content.replace(importLine[0], `${importLine[0]}\nfrom sqlalchemy import select`);
      else content = `from sqlalchemy import select\n${content}`;
      record("added the SQLAlchemy select import required by auth lookups");
    }
    const missingSecurityImports = ["OAuth2PasswordBearer", "OAuth2PasswordRequestForm"].filter((name) =>
      new RegExp(`\\b${name}\\b`).test(content)
      && !new RegExp(`^from\\s+fastapi\\.security\\s+import[^\\n]*\\b${name}\\b`, "m").test(content));
    if (missingSecurityImports.length) {
      content = `from fastapi.security import ${missingSecurityImports.join(", ")}\n${content}`;
      record(`added missing FastAPI security import${missingSecurityImports.length === 1 ? "" : "s"}: ${missingSecurityImports.join(", ")}`);
    }
    if (content === edit.content) return edit;
    changedPaths.push(edit.path);
    return { ...edit, content };
  });
  return { edits: next, changedPaths, repairs };
}

/** Enable SQLAlchemy attribute reads on Pydantic v2 response models. */
export function repairPydanticResponseAttributes(edits: ProposedEdit[]): { edits: ProposedEdit[]; changedPaths: string[] } {
  const changedPaths: string[] = [];
  const next = edits.map((edit) => {
    if (edit.path.replaceAll("\\", "/").toLowerCase() !== "backend/schemas.py") return edit;
    let content = edit.content;
    const responseClasses = [...content.matchAll(/^class\s+([A-Za-z_]\w*Response)\s*\(BaseModel\)\s*:\s*$/gm)];
    for (let index = responseClasses.length - 1; index >= 0; index -= 1) {
      const match = responseClasses[index];
      const bodyEnd = content.indexOf("\nclass ", match.index! + match[0].length);
      const end = bodyEnd < 0 ? content.length : bodyEnd;
      const body = content.slice(match.index! + match[0].length, end);
      if (/model_config\s*=\s*ConfigDict\([^\n]*from_attributes\s*=\s*True/.test(body) || /orm_mode\s*=\s*True/.test(body)) continue;
      const insertion = `${match[0]}\n    model_config = ConfigDict(from_attributes=True)`;
      content = content.slice(0, match.index!) + insertion + content.slice(match.index! + match[0].length);
    }
    if (content !== edit.content) {
      const pydanticImport = content.match(/^from\s+pydantic\s+import\s+([^\n]+)$/m);
      if (pydanticImport) {
        const names = pydanticImport[1].split(",").map((name) => name.trim());
        if (!names.includes("ConfigDict")) content = content.replace(pydanticImport[0], `from pydantic import ${[...names, "ConfigDict"].join(", ")}`);
      } else {
        content = `from pydantic import ConfigDict\n${content}`;
      }
      changedPaths.push(edit.path);
      return { ...edit, content };
    }
    return edit;
  });
  return { edits: next, changedPaths };
}

export function repairBackendCheckpointSubtasks(
  records: NonNullable<RunnerInput["resumeCheckpoint"]>["backendSubtasks"],
  businessOperations: NonNullable<RunnerInput["resumeCheckpoint"]>["businessOperations"] = [],
): { records: NonNullable<RunnerInput["resumeCheckpoint"]>["backendSubtasks"]; changedPaths: string[]; repairs: string[] } {
  const changedPaths = new Set<string>();
  const repairs = new Set<string>();
  const roleByModule = new Map<string, string>();
  for (const operation of businessOperations) {
    try {
      const spec = JSON.parse(operation.content) as BusinessOperationSpec & { operationKind?: string };
      if (spec.operationKind === "entity-create" && spec.targetModule && spec.actor?.role) roleByModule.set(spec.targetModule.replaceAll("\\", "/").toLowerCase(), spec.actor.role);
    } catch {
      // Resume validation reports malformed operation JSON before code generation.
    }
  }
  const next = (records ?? []).map((record) => ({
    ...record,
    artifacts: record.artifacts.map((artifact) => {
      const authRepair = repairKnownFastApiAuthIssues([{ path: artifact.path, action: artifact.action, content: artifact.content }]);
      const schemaRepair = repairPydanticResponseAttributes(authRepair.edits);
      let content = schemaRepair.edits[0]?.content ?? artifact.content;
      for (const path of authRepair.changedPaths) changedPaths.add(path);
      for (const repair of authRepair.repairs) repairs.add(repair);
      for (const path of schemaRepair.changedPaths) changedPaths.add(path);
      if (schemaRepair.changedPaths.length) repairs.add("enabled Pydantic ORM response serialization for SQLAlchemy models");
      const operationRole = roleByModule.get(artifact.path.replaceAll("\\", "/").toLowerCase());
      if (operationRole && artifact.path.replaceAll("\\", "/").toLowerCase() === "backend/routes/customers.py") {
        const aligned = alignCustomerRegistrationRole(content, operationRole);
        if (aligned.changed) {
          content = aligned.content;
          changedPaths.add(artifact.path);
          repairs.add(`aligned customer registration authorization with the ${operationRole} operation actor`);
        }
      }
      return content === artifact.content ? artifact : { ...artifact, content, sha256: createHash("sha256").update(content).digest("hex") };
    }),
  }));
  const routerRecord = next.find((record) => record.id === "router-registration");
  const mainArtifact = routerRecord?.artifacts.find((artifact) => artifact.path.replaceAll("\\", "/").toLowerCase() === "backend/main.py");
  if (mainArtifact) {
    const context: ProjectContext = { projectPath: ".", indexedChunkCount: 0, relevantFiles: next.flatMap((record) => record.artifacts.map((artifact) => ({ relPath: artifact.path, content: artifact.content, snippet: artifact.content.slice(0, 800) }))) };
    const normalized = registerGeneratedFastApiRouters("backend", [{ path: mainArtifact.path, action: mainArtifact.action, content: mainArtifact.content }], context);
    const normalizedMain = normalized.edits.find((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "backend/main.py");
    if (normalizedMain && normalizedMain.content !== mainArtifact.content) {
      mainArtifact.content = normalizedMain.content;
      if (mainArtifact.sha256 !== undefined) mainArtifact.sha256 = createHash("sha256").update(mainArtifact.content).digest("hex");
      changedPaths.add(mainArtifact.path);
      repairs.add("normalized module imports to APIRouter symbols and removed duplicate FastAPI router registrations");
    }
  }
  return { records: next, changedPaths: [...changedPaths], repairs: [...repairs] };
}

/** Keep successfully validated backend subtask files immutable while later
 * backend stages and repairs work on their own targets. A later model response
 * may mention a prior file, but it must not replace that validated interface. */
export function restoreValidatedBackendSubtaskArtifacts(
  edits: ProposedEdit[],
  records: NonNullable<RunnerInput["resumeCheckpoint"]>["backendSubtasks"],
): { edits: ProposedEdit[]; restoredPaths: string[] } {
  const validatedByPath = new Map<string, ProposedEdit>();
  const routeSnapshots = new Map<string, Array<{ id: string; path: string; action: ProposedEdit["action"]; content: string }>>();
  for (const record of records ?? []) {
    for (const artifact of record.artifacts) {
      const normalizedPath = artifact.path.replaceAll("\\", "/");
      const key = normalizedPath.toLowerCase();
      if (/^backend\/routes\/.+\.py$/i.test(normalizedPath)) {
        const snapshots = routeSnapshots.get(key) ?? [];
        snapshots.push({ id: record.id, path: normalizedPath, action: artifact.action, content: artifact.content });
        routeSnapshots.set(key, snapshots);
      } else {
        validatedByPath.set(key, { path: normalizedPath, action: artifact.action, content: artifact.content });
      }
    }
  }
  for (const [key, snapshots] of routeSnapshots) {
    const parsed = snapshots.map((snapshot) => ({ ...snapshot, ...pythonRouteSnapshotParts(snapshot.content) }));
    const base = parsed.reduce((best, current) => current.handlers.size > best.handlers.size || (current.handlers.size === best.handlers.size && current.content.length > best.content.length) ? current : best);
    const handlers = new Map(base.handlers);
    const ownsRoute = (subtaskId: string, routeKey: string): boolean => {
      if (subtaskId === "customer-registration-api") return routeKey === "post /customers";
      if (subtaskId === "submission-api") return /\/submit$/i.test(routeKey);
      if (subtaskId === "manager-decision-api") return /\/(?:approve|reject)$/i.test(routeKey);
      if (subtaskId === "audit-history-api") return /\/audit$/i.test(routeKey);
      return false;
    };
    for (const snapshot of parsed) for (const [routeKey, block] of snapshot.handlers) {
      if (!handlers.has(routeKey) || ownsRoute(snapshot.id, routeKey)) handlers.set(routeKey, block);
    }
    const imports = [...new Set(parsed.flatMap((snapshot) => snapshot.imports))];
    const content = [...imports, base.preamble.trim(), ...handlers.values()].filter(Boolean).join("\n\n").trimEnd() + "\n";
    validatedByPath.set(key, { path: base.path, action: base.action, content });
  }
  if (!validatedByPath.size) return { edits, restoredPaths: [] };
  const present = new Set<string>();
  const restoredPaths: string[] = [];
  const protectedEdits = edits.map((edit) => {
    const key = edit.path.replaceAll("\\", "/").toLowerCase();
    const validated = validatedByPath.get(key);
    if (!validated) return edit;
    present.add(key);
    if (edit.content === validated.content && edit.action === validated.action) return edit;
    restoredPaths.push(validated.path);
    return validated;
  });
  for (const [key, validated] of validatedByPath) {
    if (present.has(key)) continue;
    protectedEdits.push(validated);
    restoredPaths.push(validated.path);
  }
  return { edits: protectedEdits, restoredPaths: [...new Set(restoredPaths)] };
}

function pythonRouteSnapshotParts(source: string): { handlers: Map<string, string>; imports: string[]; preamble: string } {
  const lines = source.split(/\r?\n/);
  const imports = [...new Set(lines.filter((line) => /^(?:from\s+\S+\s+import\s+|import\s+\S)/.test(line)))];
  const handlers = new Map<string, string>();
  const removed = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const decorator = lines[index].match(/^@router\.(get|post|put|patch|delete)\s*\(\s*["']([^"']+)["']/i);
    if (!decorator) continue;
    let signature = index + 1;
    while (signature < lines.length && !/^\s*(?:async\s+)?def\s+\w+\s*\(/.test(lines[signature])) signature += 1;
    if (signature >= lines.length) continue;
    const functionIndent = lines[signature].match(/^\s*/)?.[0].length ?? 0;
    let end = signature + 1;
    while (end < lines.length) {
      const line = lines[end];
      if (line.trim() && !line.trimStart().startsWith("#") && (line.match(/^\s*/)?.[0].length ?? 0) <= functionIndent) break;
      end += 1;
    }
    handlers.set(`${decorator[1].toLowerCase()} ${decorator[2]}`, lines.slice(index, end).join("\n").trimEnd());
    for (let line = index; line < end; line += 1) removed.add(line);
    index = end - 1;
  }
  const preamble = lines.filter((line, index) => !removed.has(index) && !/^(?:from\s+\S+\s+import\s+|import\s+\S)/.test(line)).join("\n");
  return { handlers, imports, preamble };
}

function appendAuditEventResponseSchema(schemaSource: string, modelSource: string): string {
  if (/^class\s+AuditEventResponse\s*\(/m.test(schemaSource)) return schemaSource;
  const declaration = modelSource.match(/^class\s+AuditEvent\s*\(Base\)\s*:\s*$/m);
  if (!declaration) throw new Error("PAC model module has no AuditEvent declaration");
  const start = declaration.index! + declaration[0].length;
  const nextClass = modelSource.slice(start).search(/^class\s+/m);
  const body = modelSource.slice(start, nextClass < 0 ? undefined : start + nextClass);
  const fields = [...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*=\s*Column\(\s*(Integer|String|DateTime)\b/gm)].map((match) => ({ name: match[1], type: ({ Integer: "int", String: "str", DateTime: "datetime" } as Record<string, string>)[match[2]] }));
  if (!fields.some((field) => field.name === "user_id") || !fields.some((field) => field.name === "action") || !fields.some((field) => field.name === "created_at")) throw new Error("AuditEvent does not expose the required actor, action, and timestamp columns");
  let result = schemaSource;
  if (!/^from pydantic import .*\bConfigDict\b/m.test(result)) {
    const pydanticImport = result.match(/^from pydantic import (.+)$/m);
    if (pydanticImport) result = result.replace(pydanticImport[0], `from pydantic import ${[...new Set([...pydanticImport[1].split(/,\s*/), "ConfigDict"])].join(", ")}`);
    else result = `from pydantic import BaseModel, ConfigDict\n${result}`;
  }
  if (fields.some((field) => field.type === "datetime") && !/^from datetime import datetime$/m.test(result)) result = `from datetime import datetime\n${result}`;
  const fieldsSource = fields.map((field) => `    ${field.name}: ${field.type}`).join("\n");
  return `${result.trimEnd()}\n\nclass AuditEventResponse(BaseModel):\n    model_config = ConfigDict(from_attributes=True)\n${fieldsSource}\n`;
}

function sqlalchemyRelationshipIssues(source: string): string[] {
  const classes = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  const save = () => { if (current) classes.set(current, body.join("\n")); };
  for (const line of source.split(/\r?\n/)) {
    const declaration = line.match(/^class\s+([A-Za-z_]\w*)\b/);
    if (declaration) { save(); current = declaration[1]; body = []; }
    else if (current) body.push(line);
  }
  save();
  const issues: string[] = [];
  for (const [className, classBody] of classes) {
    const relationPattern = /\b([A-Za-z_]\w*)\s*=\s*relationship\(\s*["']([A-Za-z_]\w*)["']([^)]*)\)/gs;
    for (const match of classBody.matchAll(relationPattern)) {
      const [, attribute, targetClass, args] = match;
      const targetBody = classes.get(targetClass);
      if (!targetBody) { issues.push(`${className}.${attribute} references missing relationship target class ${targetClass}`); continue; }
      const reverse = args.match(/\bback_populates\s*=\s*["']([A-Za-z_]\w*)["']/)?.[1];
      if (!reverse) continue;
      if (!new RegExp(`\\b${reverse}\\s*=\\s*relationship\\(`).test(targetBody)) {
        issues.push(`${className}.${attribute} back_populates references missing ${targetClass}.${reverse}`);
        continue;
      }
      const reciprocal = [...targetBody.matchAll(new RegExp(`\\b${reverse}\\s*=\\s*relationship\\(\\s*["']${className}["']([^)]*)\\)`, "gs"))]
        .some((candidate) => new RegExp(`\\bback_populates\\s*=\\s*["']${attribute}["']`).test(candidate[1]));
      if (!reciprocal) issues.push(`${className}.${attribute} and ${targetClass}.${reverse} do not declare matching back_populates`);
    }
  }
  return issues;
}

export function repairKnownSqlAlchemyModelIssues(edits: ProposedEdit[]): { edits: ProposedEdit[]; changedPaths: string[] } {
  const changedPaths: string[] = [];
  const output = edits.map((edit) => {
    if (!/^(?:backend\/)?models\.py$/i.test(edit.path.replaceAll("\\", "/"))) return edit;
    let content = edit.content;
    if (/^from\s+enum\s+import\s+Enum\s*$/m.test(content)) {
      content = content.replace(/^from\s+enum\s+import\s+Enum\s*$/m, "from enum import Enum as PyEnum");
      content = content.replace(/^(\s*class\s+\w+\s*\()Enum(\s*\)\s*:)/gm, "$1PyEnum$2");
    }
    const usesPythonEnumBase = /from\s+enum\s+import\s+Enum\s+as\s+PyEnum\b/.test(content);
    if (usesPythonEnumBase) content = content.replace(/((?:\b\w+\.)?Column\s*\(\s*)Enum\s*\(\s*(?:PyEnum|Role)\s*\)/g, "$1String");
    // Models occasionally spell an enum default using the serialized value
    // (for example CustomerStatus.pending) instead of the declared member
    // (CustomerStatus.PENDING). Normalize only defaults whose enum class and
    // matching member are both present in this file.
    const enumMembers = new Map<string, string[]>();
    const classHeaders = [...content.matchAll(/^class\s+(\w+)\s*\(([^)]+)\)\s*:\s*$/gm)];
    for (let index = 0; index < classHeaders.length; index += 1) {
      const header = classHeaders[index];
      if (!/^(?:PyEnum|Enum)$/.test(header[2].trim())) continue;
      const bodyStart = header.index! + header[0].length;
      const bodyEnd = classHeaders[index + 1]?.index ?? content.length;
      const members = [...content.slice(bodyStart, bodyEnd).matchAll(/^\s+([A-Za-z_]\w*)\s*=/gm)].map((member) => member[1]);
      enumMembers.set(header[1], members);
    }
    if (enumMembers.size) {
      content = content.replace(/(\bdefault\s*=\s*)(\w+)\.([A-Za-z_]\w*)/g, (reference, prefix: string, enumName: string, member: string) => {
        const declared = enumMembers.get(enumName);
        const canonical = declared?.find((candidate) => candidate.toLowerCase() === member.toLowerCase());
        return canonical ? `${prefix}${enumName}.${canonical}` : reference;
      });
    }
    content = content.replace(/^(\s*role\s*=\s*)Column\(\s*String\b[^\n]*\)$/m, '$1Column(String, nullable=False, default="customer")');
    if (/from\s+backend\.database\s+import\s+[^\n]*\bBase\b/.test(content)) content = content.replace(/^Base\s*=\s*declarative_base\(\)\s*\n?/m, "");
    if (/\bCustomerStatus\b/.test(content) && !/^class\s+CustomerStatus\b/m.test(content)) {
      const enumBase = usesPythonEnumBase ? "PyEnum" : "Enum";
      const declaration = `class CustomerStatus(${enumBase}):\n    PENDING = "pending"\n    APPROVED = "approved"\n    REJECTED = "rejected"\n\n`;
      if (/^class\s+Customer\b/m.test(content)) content = content.replace(/(?=^class\s+Customer\b)/m, declaration);
      else content = `${content.trimEnd()}\n\n${declaration}`;
    }
    if (/^class\s+User\b/m.test(content)) {
      if (/\brole\s*=\s*Column\(\s*Enum\(/.test(content)) content = content.replace(/^(\s*role\s*=\s*)Column\(\s*Enum\([^\n]*?\)\s*\)([^\n]*)$/m, '$1Column(String, nullable=False, default="customer")');
      if (!/^\s+role\s*=/m.test(content)) content = content.replace(/^(class\s+User\b[^\n]*:\n(?:[ \t]+[^\n]*\n)*?)(?=^class\s|\Z)/m, (block) => `${block}    role = Column(String, nullable=False, default="customer")\n`);
    }
    let customerStatusFixed = false;
    content = content.replace(/((?:\b\w+\.)?Column\s*\(\s*)CustomerStatus(\s*(?:,|\)))/g, (_match, before: string, after: string) => {
      customerStatusFixed = true;
      return `${before}Enum(CustomerStatus, values_callable=lambda enum_cls: [member.value for member in enum_cls])${after}`;
    });
    if (!/values_callable\s*=/.test(content)) content = content.replace(/\bEnum\(\s*CustomerStatus\s*\)/g, "Enum(CustomerStatus, values_callable=lambda enum_cls: [member.value for member in enum_cls])");
    const ensureSqlAlchemyImport = (symbol: string) => {
      const importLine = content.match(/^from\s+sqlalchemy\s+import\s+([^\n]+)$/m);
      if (importLine) {
        const symbols = importLine[1].split(",").map((item) => item.trim().split(/\s+as\s+/i)[0]);
        if (!symbols.includes(symbol)) content = content.replace(importLine[0], `${importLine[0]}, ${symbol}`);
      } else content = `from sqlalchemy import ${symbol}\n${content}`;
    };
    if (customerStatusFixed) ensureSqlAlchemyImport("Enum");
    if (usesPythonEnumBase && /\bColumn\s*\(\s*String\b/.test(content)) ensureSqlAlchemyImport("String");
    if (content !== edit.content) changedPaths.push(edit.path);
    return content === edit.content ? edit : { ...edit, content };
  });
  return { edits: output, changedPaths };
}

export function repairKnownPostgresEnumMigrationIssues(edits: ProposedEdit[], modelSource = ""): { edits: ProposedEdit[]; changedPaths: string[] } {
  const enumClass = modelSource.match(/\bEnum\(\s*([A-Z]\w*)\b/)?.[1];
  if (!enumClass || !new RegExp(`^class\\s+${enumClass}\\s*\\(\\s*(?:PyEnum|Enum)\\s*\\)`, "m").test(modelSource)) {
    return { edits, changedPaths: [] };
  }
  const typeName = enumClass.toLowerCase();
  const changedPaths: string[] = [];
  const normalized = edits.map((edit) => {
    if (!/migrations\/versions\/[^/]+\.py$/i.test(edit.path.replaceAll("\\", "/"))) return edit;
    let content = edit.content;
    content = content.replace(/((?:sa\.Enum|postgresql\.ENUM)\s*\([^)]*)(\))/g, (whole, args: string, close: string) =>
      /\bname\s*=/.test(args) ? whole : `${args.trimEnd()}, name=${JSON.stringify(typeName)}${close}`,
    );
    if (content !== edit.content) changedPaths.push(edit.path);
    return content === edit.content ? edit : { ...edit, content };
  });
  return { edits: normalized, changedPaths };
}

export function repairDatabaseCheckpointSubtasks(
  records: NonNullable<RunnerInput["resumeCheckpoint"]>["databaseSubtasks"],
  architecture: ProjectArchitectureContract,
): NonNullable<RunnerInput["resumeCheckpoint"]>["databaseSubtasks"] {
  const modelSource = [...(records ?? [])].reverse().flatMap((record) => record.artifacts).find((artifact) => /^(?:backend\/)?models\.py$/i.test(artifact.path.replaceAll("\\", "/")))?.content ?? "";
  return (records ?? []).map((record) => {
    if (record.architectureHash !== architecture.contractHash) return record;
    const modelRepair = repairKnownSqlAlchemyModelIssues(record.artifacts.map(({ path, action, content }) => ({ path, action, content })));
    const migrationRepair = repairKnownPostgresEnumMigrationIssues(modelRepair.edits, modelSource);
    const changed = new Set([...modelRepair.changedPaths, ...migrationRepair.changedPaths].map((path) => path.replaceAll("\\", "/").toLowerCase()));
    if (!changed.size) return record;
    const byPath = new Map(migrationRepair.edits.map((edit) => [edit.path.replaceAll("\\", "/").toLowerCase(), edit.content]));
    return {
      ...record,
      artifacts: record.artifacts.map((artifact) => {
        const key = artifact.path.replaceAll("\\", "/").toLowerCase();
        if (!changed.has(key)) return artifact;
        const content = byPath.get(key) ?? artifact.content;
        return { ...artifact, content, sha256: createHash("sha256").update(content).digest("hex") };
      }),
    };
  });
}

export function repairDatabaseCheckpointArtifacts(
  checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>,
  architecture: ProjectArchitectureContract,
): { checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]>; changedPaths: string[] } {
  if (checkpoint.projectArchitecture?.contractHash !== architecture.contractHash) return { checkpoint, changedPaths: [] };
  const allArtifacts = [
    ...checkpoint.artifacts,
    ...checkpoint.stages.flatMap((stage) => stage.artifacts ?? []),
    ...(checkpoint.attemptedStages ?? []).flatMap((stage) => stage.artifacts),
    ...(checkpoint.databaseSubtasks ?? []).flatMap((stage) => stage.artifacts),
  ];
  const modelSource = [...allArtifacts].reverse().find((artifact) => /^(?:backend\/)?models\.py$/i.test(artifact.path.replaceAll("\\", "/")))?.content ?? "";
  const changedPaths = new Set<string>();
  const normalize = <T extends { path: string; action: ProposedEdit["action"]; content: string; sha256?: string }>(artifacts: T[]): T[] => {
    const modelRepair = repairKnownSqlAlchemyModelIssues(artifacts.map(({ path, action, content }) => ({ path, action, content })));
    const migrationRepair = repairKnownPostgresEnumMigrationIssues(modelRepair.edits, modelSource);
    const byPath = new Map(migrationRepair.edits.map((edit) => [edit.path.replaceAll("\\", "/").toLowerCase(), edit.content]));
    const modified = new Set([...modelRepair.changedPaths, ...migrationRepair.changedPaths].map((path) => path.replaceAll("\\", "/").toLowerCase()));
    for (const path of modified) changedPaths.add(path);
    return artifacts.map((artifact) => {
      const key = artifact.path.replaceAll("\\", "/").toLowerCase();
      if (!modified.has(key)) return artifact;
      const content = byPath.get(key) ?? artifact.content;
      return { ...artifact, content, ...(artifact.sha256 !== undefined ? { sha256: createHash("sha256").update(content).digest("hex") } : {}) };
    });
  };
  const next = {
    ...checkpoint,
    artifacts: normalize(checkpoint.artifacts),
    stages: checkpoint.stages.map((stage) => ({ ...stage, ...(stage.artifacts ? { artifacts: normalize(stage.artifacts) } : {}) })),
    ...(checkpoint.attemptedStages ? { attemptedStages: checkpoint.attemptedStages.map((stage) => ({ ...stage, artifacts: normalize(stage.artifacts) })) } : {}),
    ...(checkpoint.databaseSubtasks ? { databaseSubtasks: repairDatabaseCheckpointSubtasks(checkpoint.databaseSubtasks, architecture) } : {}),
  } satisfies NonNullable<RunnerInput["resumeCheckpoint"]>;
  const databaseIndex = next.stages.findIndex((stage) => stage.id === "database");
  if (databaseIndex >= 0 && next.completedStageIds.includes("database")) {
    const previous = replayStageSnapshots(next.stages, databaseIndex) ?? [];
    const originalPaths = new Set(next.baseFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
    const delta = snapshotStageDelta(previous, next.artifacts.map(({ path, action, content }) => ({ path, action, content })), originalPaths);
    next.stages[databaseIndex] = { ...next.stages[databaseIndex], artifactPaths: delta.map((artifact) => artifact.path), artifacts: delta };
  }
  return { checkpoint: next, changedPaths: [...changedPaths] };
}

export function databaseSubtaskIssues(subtask: DatabaseSubtask, edits: ProposedEdit[], architecture: ProjectArchitectureContract): string[] {
  const issues: string[] = [];
  const expected = new Set(subtask.targetPaths.map((path) => path.replaceAll("\\", "/").toLowerCase()));
  for (const edit of edits) if (!expected.has(edit.path.replaceAll("\\", "/").toLowerCase())) issues.push(`${subtask.id} proposed an unapproved path: ${edit.path}`);
  for (const path of expected) if (!edits.some((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === path)) issues.push(`${subtask.id} did not produce required artifact ${path}`);
  const modelPath = architecture.modules.find((item) => item.path.toLowerCase() === "backend/models.py")?.path ?? "backend/models.py";
  const modelEdit = edits.find((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === modelPath.toLowerCase());
  if (modelEdit) {
    const source = modelEdit.content;
    if (/\b(tortoise|fields\.(?:CharField|IntField|DatetimeField)|\.filter\([^\n]*\)\.first\(\))/i.test(source)) issues.push(`${subtask.id} contains ORM APIs incompatible with the PAC SQLAlchemy stack`);
    if (!/class\s+\w+\s*\(\s*Base\s*\)/.test(source) && !/\bDeclarativeBase\b|\bdeclarative_base\s*\(/.test(source)) issues.push(`${subtask.id} does not use the declared SQLAlchemy declarative base`);
    if (subtask.id === "customer-entity" && !/class\s+Customer\b/.test(source)) issues.push("Customer model artifact does not define class Customer");
    if (subtask.id === "customer-entity" && !/\b(name|business_name)\b/.test(source)) issues.push("Customer model is missing a customer name field");
    if (subtask.id === "customer-entity" && !/\bemail\b/.test(source)) issues.push("Customer model is missing an email field");
    if (subtask.id === "customer-entity" && /(?:Column|mapped_column)\s*\(\s*CustomerStatus\b/.test(source)) issues.push("CustomerStatus must be wrapped in sqlalchemy.Enum(CustomerStatus) for a SQLAlchemy column");
    if (subtask.id === "customer-entity" && /\bCustomerStatus\b/.test(source) && !/^class\s+CustomerStatus\b/m.test(source)) issues.push("CustomerStatus is referenced but its Python enum class is missing");
    if (subtask.id === "customer-entity" && /\bEnum\(\s*CustomerStatus\b/.test(source) && !/values_callable\s*=/.test(source)) issues.push("CustomerStatus SQLAlchemy Enum must persist enum .value strings so PostgreSQL matches the Alembic labels");
    if (/^from\s+sqlalchemy\s+import\s+[^\n]*\bEnum\b[^\n]*$/m.test(source) && /^from\s+enum\s+import\s+Enum\s*$/m.test(source)) issues.push("Python Enum import shadows sqlalchemy.Enum; alias the Python enum base as PyEnum");
    if (/from\s+backend\.database\s+import\s+[^\n]*\bBase\b/.test(source) && /^Base\s*=\s*declarative_base\(\)/m.test(source)) issues.push("Do not replace the PAC Base imported from backend.database with a separate declarative base");
    if (/\b(?:Column|mapped_column)\s*\(\s*Enum\s*\(\s*(?:PyEnum|enum\.Enum)\s*\)/.test(source)) issues.push("SQLAlchemy Enum must wrap a declared application enum such as UserRole, not the enum base class");
    if (subtask.id === "related-entities" && !/class\s+User\b/.test(source)) issues.push("related entity artifact does not define class User");
    if (subtask.id === "related-entities" && !/class\s+AuditEvent\b/.test(source)) issues.push("related entity artifact does not define class AuditEvent");
    if (subtask.id === "related-entities" && !/\brole\s*=/.test(source)) issues.push("User ORM model is missing the role field required for authorization");
    if (subtask.id === "related-entities" && /\brole\s*=\s*Column\(\s*Enum\(/.test(source)) issues.push("User role must use a persisted String field, not the Python Enum base class");
    if (subtask.id === "related-entities") issues.push(...sqlalchemyRelationshipIssues(source));
  }
  const migrationEdit = edits.find((edit) => /migrations\/versions\//i.test(edit.path));
  if (migrationEdit && subtask.id === "alembic-revision") {
    if (!/\brevision\s*=/.test(migrationEdit.content) || !/\bdown_revision\s*=/.test(migrationEdit.content)) issues.push("Alembic revision identifiers are missing");
    if (!/def\s+upgrade\s*\(/.test(migrationEdit.content) || !/def\s+downgrade\s*\(/.test(migrationEdit.content)) issues.push("Alembic revision must define executable upgrade and downgrade functions");
    if (!/op\.create_table\s*\(/.test(migrationEdit.content)) issues.push("Alembic revision does not create a database table");
    if (!/op\.create_table\s*\(\s*["']customers["']/.test(migrationEdit.content)) issues.push("Alembic revision does not create the required customers table");
    if (architecture.stack.database.toLowerCase() === "postgresql" && [...migrationEdit.content.matchAll(/(?:sa\.Enum|postgresql\.ENUM)\s*\(([^)]*)\)/g)].some((match) => !/\bname\s*=/.test(match[1]))) {
      issues.push("PostgreSQL Alembic ENUM types must declare an explicit stable name");
    }
  }
  return [...new Set(issues)];
}

export function validateDatabaseSubtaskCheckpoint(records: Array<{ id: string; artifacts: Array<{ path: string; action: ProposedEdit["action"]; content: string }> }>, architecture: ProjectArchitectureContract): { invalidSubtaskId?: string; issues: string[] } {
  const plan = databaseSubtaskPlan(architecture);
  for (const record of records) {
    const subtask = plan.find((item) => item.id === record.id);
    if (!subtask) return { invalidSubtaskId: record.id, issues: [`unknown database subtask ${record.id}`] };
    const issues = databaseSubtaskIssues(subtask, record.artifacts, architecture);
    if (issues.length) return { invalidSubtaskId: record.id, issues };
  }
  return { issues: [] };
}

export function checkpointValidatedDatabaseSubtasks(
  records: NonNullable<RunnerInput["resumeCheckpoint"]>["databaseSubtasks"],
  artifacts: ProposedEdit[],
  architecture: ProjectArchitectureContract,
  completedAt: string,
): { records: NonNullable<NonNullable<RunnerInput["resumeCheckpoint"]>["databaseSubtasks"]>; addedIds: string[]; issues: string[] } {
  const next = [...(records ?? [])];
  const addedIds: string[] = [];
  const issues: string[] = [];
  for (const subtask of databaseSubtaskPlan(architecture)) {
    if (next.some((record) => record.id === subtask.id)) continue;
    const targeted = artifacts.filter((artifact) => subtask.targetPaths.some((path) => path.replaceAll("\\", "/").toLowerCase() === artifact.path.replaceAll("\\", "/").toLowerCase()));
    const validation = databaseSubtaskIssues(subtask, targeted, architecture);
    if (validation.length) {
      issues.push(...validation.map((issue) => `${subtask.id}: ${issue}`));
      continue;
    }
    next.push({
      id: subtask.id,
      completedAt,
      architectureHash: architecture.contractHash,
      artifacts: targeted.map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(artifact.content).digest("hex") })),
    });
    addedIds.push(subtask.id);
  }
  return { records: next, addedIds, issues: [...new Set(issues)] };
}

/** Keep each staged local-model prompt grounded in the files needed by that
 * stage. Validation still uses the complete accumulated workspace context. */
export function contextForBuildStage(stageId: BuildStageId, context: ProjectContext): ProjectContext {
  const files = context.relevantFiles ?? [];
  const keep = (rawPath: string): boolean => {
    const path = rawPath.replaceAll("\\", "/").toLowerCase();
    const backendCore = /^backend\/(?:requirements\.txt|\.env\.example|main\.py|models\.py|schemas\.py|auth\.py|database\.py|routes\/[^/]+\.py)$/.test(path);
    const frontendFiles = /^(?:frontend|client|web)\//.test(path);
    const migrationOrRuntime = /^(?:backend\/migrations\/|docker-compose\.ya?ml$|(?:playwright|pytest|vitest|jest)\.config\.)/.test(path);
    switch (stageId) {
      case "scaffold": return false;
      case "database": return /^backend\/(?:requirements\.txt|main\.py|models\.py|database\.py)$/.test(path) || migrationOrRuntime;
      case "backend": return backendCore || migrationOrRuntime;
      case "transactions": return backendCore;
      case "frontend": return frontendFiles || backendCore && /(?:schemas|auth|routes\/|main\.py)/.test(path) || /^(?:docker-compose\.ya?ml|backend\/\.env\.example)$/.test(path);
      case "tests": return frontendFiles || backendCore || migrationOrRuntime;
    }
  };
  return { ...context, relevantFiles: files.filter((file) => keep(file.relPath)) };
}

export function repairGuidance(issues: string[], context?: ProjectContext): string {
  const guidance = new Set<string>();
  const contextText = (context?.relevantFiles ?? []).map((file) => `${file.relPath}\n${file.content ?? file.snippet ?? ""}`).join("\n");
  const usesTortoise = /tortoise-orm|from\s+tortoise\b|import\s+tortoise\b/i.test(contextText);
  for (const issue of issues) {
    const undefinedPythonName = issue.match(/NameError:\s*name ['"]([^'"]+)['"] is not defined/i)?.[1];
    const tracebackFiles = [...issue.matchAll(/File ["'](?:[^"']*\/)?(backend\/[A-Za-z0-9_./-]+\.py)["'], line \d+/gi)];
    const failingPythonPath = tracebackFiles.at(-1)?.[1] ?? issue.match(/(?:^|[\s"'(/])(backend\/[A-Za-z0-9_./-]+\.py)\b/i)?.[1];
    if (undefinedPythonName && failingPythonPath) {
      if (failingPythonPath.toLowerCase() === "backend/main.py" && undefinedPythonName.toLowerCase() === "fastapi") {
        guidance.add("Repair only backend/main.py for the exact startup NameError. Add `from fastapi import FastAPI` before `app = FastAPI()`. Preserve the existing app creation, database configuration, and router registrations. Do not add OAuth/security imports for this diagnostic, and do not modify any other file.");
        continue;
      }
      if (failingPythonPath.toLowerCase() === "backend/auth.py" && undefinedPythonName === "oauth2_scheme") {
        guidance.add("Repair only backend/auth.py for the isolated FastAPI import failure. Import OAuth2PasswordBearer from fastapi.security and define oauth2_scheme using the login route already present in the supplied project files (use /auth/login when the contract has not defined another path). Keep the existing token and role behavior. Inspect this full module and ensure every referenced name has a valid import or definition, including jwt/JWTError, SECRET_KEY/ALGORITHM, TokenData, and User if they are referenced. Import the persisted User model from backend.models; define any token payload schema locally only if no matching schema exists in the shown files. Read secrets from the environment and fail clearly when unset; do not add hardcoded credentials. Do not modify migrations, models, frontend, or unrelated files.");
      } else {
        guidance.add(`Repair only ${failingPythonPath} for the exact Python import failure: NameError for ${undefinedPythonName}. Add or correct the import/definition using the supplied project files and declared dependencies. Do not change unrelated files or behavior; preserve environment-only secrets and return this file's complete contents.`);
      }
    }
    if (/users table required|invalid table dependency/i.test(issue)) {
      guidance.add("Repair only the existing PostgreSQL migration and backend/models.py. Ensure the migration creates all tables used by the requested persisted authentication, customer workflow, and ORM entities; create referenced tables before foreign keys point to them, or add foreign keys after table creation. Keep the SQL and ORM table/column definitions consistent. Do not replace PostgreSQL with another database and do not alter unrelated application files.");
    }
    if (/customer approval workflow|Customer ORM entity|Customer ORM model|User ORM model/i.test(issue)) {
      guidance.add("Repair only the customer approval schema files implicated by these diagnostics. Preserve the requested customer onboarding domain; do not substitute employee, department, payroll, or other unrelated entities. Create the PostgreSQL customers table in the existing migration in dependency order, and define a matching Customer ORM model in backend/models.py. When authentication and roles are requested, define a persisted User ORM model with the role fields used by the generated auth and route code. Return complete contents for only the affected migration and model files; do not regenerate the project.");
    }
    if (/CustomerCreate|CustomerResponse|customer name\/business-name field|customer email field/i.test(issue)) {
      guidance.add("Repair only backend/schemas.py. Define complete Pydantic CustomerCreate and CustomerResponse schemas for the actual Customer ORM model shown in context. The create schema must accept a customer/business name and email; the response must expose the persisted customer fields used by frontend and routes. Do not use employee, department, payroll, or task fields for this customer application. Do not modify the ORM, migration, or unrelated modules.");
    }
    if (/Customer ORM model mixes user authentication fields/i.test(issue)) {
      guidance.add("Repair only backend/models.py. Keep customer/business identity and onboarding state on Customer, and move password hashes and role/authorization fields to the persisted User entity. Preserve model names and relationships used by the routes and audit events. Do not change migrations or unrelated files unless the diagnostic explicitly names them.");
    }
    if (/TODO, pass, or unimplemented placeholder/i.test(issue)) {
      guidance.add("Use the exact placeholder line numbers from the diagnostic. Repair only the named file and replace each empty pass/ellipsis/TODO or placeholder comment with a complete executable implementation. For backend/auth.py, implement verified token/session authentication and real password-hash verification; do not return a fixed user ID or compare a submitted password directly with a stored hash. Import the existing persisted User model from backend.models. For backend/main.py, define the FastAPI app, a real health endpoint, and router registration. Do not use empty class or function bodies.");
    }
    if (/hardcoded authentication identity|compares a submitted password directly with a stored hash|duplicate User ORM class/i.test(issue)) {
      guidance.add("Repair only backend/auth.py. Remove fixed-identity dependencies and plaintext password comparisons. Resolve the caller from a verified bearer token/session and persisted backend.models.User; validate passwords with the declared password-hashing dependency and keep signing secrets in required environment configuration. Do not define another User ORM model in this module, do not add a fake user or fallback secret, and return the complete corrected auth.py contents.");
    }
    if (/hardcoded credential/i.test(issue)) {
      guidance.add("Remove every literal secret, JWT key, API key, and password default from source code and seed records. Read required secrets from environment variables and fail clearly when a required secret is unset; do not use a development fallback secret.");
    }
    if (/uses SQLite even though PostgreSQL was requested/i.test(issue)) {
      guidance.add("Update only the generated FastAPI database configuration files: remove every sqlite:// URL, read DATABASE_URL from the environment, and configure the requested PostgreSQL driver/ORM. Do not change the requested PostgreSQL stack to SQLite.");
    }
    if (/package\.json.*runnable scripts|must provide dev and build scripts/i.test(issue)) {
      guidance.add("Update frontend/package.json with valid `dev` and `build` scripts and the framework dependencies already requested.");
    }
    if (/migration|schema operations/i.test(issue)) {
      guidance.add("Create a real forward migration containing executable PostgreSQL CREATE TABLE/ALTER TABLE statements, constraints, and indexes derived from the required entities.");
    }
    if (/database service configuration is missing|docker compose.*postgresql/i.test(issue)) {
      guidance.add("Create or repair docker-compose.yml at the project root. It must define a `services:` mapping with a PostgreSQL service using a versioned postgres image, POSTGRES_DB/USER/PASSWORD environment variables, a persistent named volume, a healthcheck, and a loopback-only host port mapping such as 127.0.0.1:5432:5432. Return the complete compose file.");
    }
    if (/transaction boundary|database transaction|status and audit writes|audit(?:\/history)? persistence|audit event persistence|same handler transaction|persist AuditEvent inside/i.test(issue)) {
      const routeTargets = transactionRouteTargets(context, issues);
      const targetText = routeTargets.join(" and ");
      guidance.add(usesTortoise
        ? `Repair only ${targetText}; do not generate frontend, config, or documentation files. This project uses Tortoise ORM: import in_transaction from tortoise.transactions, then use async with in_transaction() as connection in each affected async handler. Persist status with await Customer.filter(id=customer_id).using_db(connection).update(...) and persist the audit row with await ApprovalEvent.create(..., using_db=connection) before leaving the transaction block. Keep owner and manager authorization and valid-state checks. Do not use SQLAlchemy APIs, merely instantiate an event, or commit state and audit separately. Return complete contents only for the allowed route files.`
        : `Repair only ${targetText}; do not generate frontend, config, or documentation files. In each affected submit/decision handler, use one atomic SQLAlchemy AsyncSession unit of work. Because FastAPI authentication may already have opened the shared request session transaction, use atomic_request_transaction(db) when available: it must start db.begin() if none is active, otherwise commit the existing transaction exactly once on success and roll it back on every exception. Inside that handler scope load and validate the customer, update customer.status, and persist db.add(AuditEvent(user_id=current_user.id, customer_id=customer.id, action=...)). Do not add independent status/audit commits. Keep actor authorization and valid-state checks. Return complete contents only for the allowed route files.`);
    }
    if (/customer submission transition is missing/i.test(issue)) {
      const target = transactionRouteTargets(context, issues).find((path) => /backend\/routes\//i.test(path)) ?? "backend/routes/customers.py";
      guidance.add(usesTortoise
        ? `Repair only ${target}. Use the existing Tortoise models and import in_transaction from tortoise.transactions. Require the authenticated owner, enforce the PAC-approved transition, and persist the audit event in the same transaction. Do not create a route module outside the PAC.`
        : `Repair only ${target}. Use the existing SQLAlchemy Customer, AuditEvent, User, schemas, and auth dependencies. Add POST /customers/{customer_id}/submit; require the authenticated owner and pending state, reject a prior submitted audit event, keep status and audit writes in atomic_request_transaction(db), and use CustomerStatus.PENDING as the persisted state. Do not add a new route module or change the PAC.`);
    }
    if (/no database write|repository persistence/i.test(issue)) {
      guidance.add("Replace mock/success-only behavior with a database write and commit through the configured PostgreSQL session.");
    }
  }
  return [...guidance].join("\n");
}

export function combineBuildEdits(
  prior: ProposedEdit[],
  current: ProposedEdit[],
  originalPaths: Set<string>,
): { edits: ProposedEdit[]; actionIssues: string[] } {
  const merged = new Map<string, ProposedEdit>();
  for (const edit of prior) merged.set(edit.path.replaceAll("\\", "/").toLowerCase(), edit);
  const actionIssues: string[] = [];
  for (const edit of current) {
    const key = edit.path.replaceAll("\\", "/").toLowerCase();
    const previous = merged.get(key);
    const wasExisting = originalPaths.has(key);
    // Models sometimes label a complete replacement as "create" even after
    // the file was supplied in full from a prior checkpoint. In that case the
    // intended operation is unambiguous and safe: normalize it to modify.
    // originalPaths contains only files whose complete contents were supplied
    // to the model, so this cannot turn a blind create into an overwrite.
    const action = previous || wasExisting ? "modify" : edit.action;
    merged.set(key, {
      path: edit.path,
      action: previous?.action ?? action,
      content: edit.content,
    });
  }
  return { edits: [...merged.values()], actionIssues };
}

function addEditsToContext(context: ProjectContext | undefined, edits: ProposedEdit[]): ProjectContext {
  const files = new Map((context?.relevantFiles ?? []).map((file) => [file.relPath.replaceAll("\\", "/").toLowerCase(), file]));
  for (const edit of edits) {
    const key = edit.path.replaceAll("\\", "/").toLowerCase();
    files.set(key, { relPath: edit.path, snippet: edit.content.slice(0, 600), content: edit.content });
  }
  return { ...context, relevantFiles: [...files.values()], indexedChunkCount: context?.indexedChunkCount ?? 0 };
}

/** Keep a focused repair's input proportional to the failing diagnostics. */
export function focusRepairContext(context: ProjectContext | undefined, edits: ProposedEdit[], issues: string[]): ProjectContext {
  const fullContext = addEditsToContext(context, edits);
  const files = fullContext.relevantFiles ?? [];
  const selected = new Set<string>();
  for (const issue of issues) {
    const normalizedIssue = issue.replaceAll("\\", "/").toLowerCase();
    const tracebackFiles = [...issue.matchAll(/File ["'](?:[^"']*\/)?(backend\/[A-Za-z0-9_./-]+\.py)["'], line \d+/gi)];
    if (/NameError:\s*name [\"']/.test(issue) && tracebackFiles.length > 0) {
      // The last Python traceback frame is where the undefined name is
      // evaluated. Earlier frames are callers and should not become repair
      // targets just because they appear in the same stack trace.
      const failingPath = tracebackFiles.at(-1)![1].toLowerCase();
      selected.add(failingPath);
      for (const dependency of ["backend/models.py", "backend/schemas.py", "backend/requirements.txt"]) {
        if (files.some((file) => file.relPath.replaceAll("\\", "/").toLowerCase() === dependency)) selected.add(dependency);
      }
      continue;
    }
    for (const file of files) {
      const path = file.relPath.replaceAll("\\", "/").toLowerCase();
      if (normalizedIssue.includes(path)) selected.add(path);
      // The database contract reports the PostgreSQL/SQLite mismatch as a
      // capability diagnostic, so locate the actual source/config file that
      // contains the incorrect SQLite wiring and include its full content.
      if (/sqlite/i.test(issue) && /sqlite/i.test(file.content ?? file.snippet ?? "")) selected.add(path);
      if (/(?:transaction|audit|submission transition|approval handler|rejection handler)/i.test(issue) && /(^|\/)backend\/routes?\/.*\.py$/i.test(file.relPath)) selected.add(path);
      if (/(?:transaction|audit|submission transition|approval handler|rejection handler)/i.test(issue) && /(^|\/)backend\/(?:models|schemas|auth)\.py$/i.test(file.relPath)) selected.add(path);
    }
  }
  if (selected.size === 0) return fullContext;
  return { ...fullContext, relevantFiles: files.filter((file) => selected.has(file.relPath.replaceAll("\\", "/").toLowerCase())) };
}

/** Test-stage repairs receive only the approved test context and complete test
 * targets. Application business source is intentionally excluded. */
export function testStageRepairContext(compactContext: ProjectContext, projectContext: ProjectContext | undefined, edits: ProposedEdit[]): ProjectContext {
  const allowedTestPath = /^(?:backend\/tests\/|frontend\/e2e\/|frontend\/playwright\.config\.[cm]?[jt]s)/i;
  const allowedConfigPath = /^(?:backend\/requirements\.txt|frontend\/package\.json|pytest\.ini|pyproject\.toml)$/i;
  const relevantFiles = new Map<string, NonNullable<ProjectContext["relevantFiles"]>[number]>();
  for (const file of compactContext.relevantFiles ?? []) relevantFiles.set(file.relPath.replaceAll("\\", "/").toLowerCase(), file);
  for (const edit of edits) {
    const path = edit.path.replaceAll("\\", "/");
    if (!allowedTestPath.test(path)) continue;
    relevantFiles.set(path.toLowerCase(), { relPath: path, snippet: edit.content.slice(0, 1_000), content: edit.content });
  }
  for (const file of projectContext?.relevantFiles ?? []) {
    const path = file.relPath.replaceAll("\\", "/");
    if (!allowedConfigPath.test(path)) continue;
    relevantFiles.set(path.toLowerCase(), file);
  }
  return { ...compactContext, relevantFiles: [...relevantFiles.values()] };
}

/** Restrict model repair edits to paths identified by the exact diagnostics. */
export function repairAllowedPaths(issues: string[], context?: ProjectContext): Set<string> {
  const paths = new Set<string>();
  for (const issue of issues) {
    const tracebackFiles = [...issue.matchAll(/File ["'](?:[^"']*\/)?(backend\/[A-Za-z0-9_./-]+\.py)["'], line \d+/gi)];
    if (/NameError:\s*name [\"']/.test(issue) && tracebackFiles.length > 0) {
      paths.add(tracebackFiles.at(-1)![1].toLowerCase());
      continue;
    }
    if (/customer submission transition is missing/i.test(issue)) paths.add("backend/routes/customers.py");
    if (/manager (?:approval|rejection) handler is missing/i.test(issue)) paths.add("backend/routes/customers.py");
    for (const match of issue.matchAll(/(?:^|[\s"'(])((?:backend|frontend)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_.-]+)/gi)) paths.add(match[1].toLowerCase());
  }
  const guidance = repairGuidance(issues, context);
  for (const match of guidance.matchAll(/Repair only ([^;\n]+);/g)) {
    for (const filePath of match[1].matchAll(/\b((?:backend|frontend)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9_.-]+)\b/g)) paths.add(filePath[1].toLowerCase());
  }
  return paths;
}

/** Include the existing frontend manifest only when diagnostics identify package installation/resolution. */
export function repairAllowedPathsForStage(stageId: BuildStageId, issues: string[], context: ProjectContext | undefined, edits: ProposedEdit[]): Set<string> {
  const paths = repairAllowedPaths(issues, context);
  if (stageId !== "frontend" || !issues.some((issue) => /(?:npm|dependency|ERESOLVE|peer dependency|package\.json)/i.test(issue))) return paths;
  const manifest = edits.find((edit) => /^(?:frontend|client|web)\/package\.json$/i.test(edit.path.replaceAll("\\", "/")))?.path
    ?? context?.relevantFiles?.find((file) => /^(?:frontend|client|web)\/package\.json$/i.test(file.relPath.replaceAll("\\", "/")))?.relPath;
  if (manifest) paths.add(manifest.replaceAll("\\", "/").toLowerCase());
  return paths;
}

/** Return only PAC-approved target paths that are absent from the current full project context. */
export function missingApprovedStagePaths(approvedTargetPaths: string[], context?: ProjectContext): string[] {
  const existing = new Set((context?.relevantFiles ?? []).map((file) => file.relPath.replaceAll("\\", "/").toLowerCase()));
  return approvedTargetPaths
    .map((path) => path.replaceAll("\\", "/"))
    .filter((path) => !existing.has(path.toLowerCase()));
}

/** Resolve transaction repairs to the backend route modules that own the affected state transitions. */
function transactionRouteTargets(context: ProjectContext | undefined, issues: string[]): string[] {
  const files = context?.relevantFiles ?? [];
  const usesSqlAlchemy = files.some((file) => /sqlalchemy/i.test(`${file.relPath}\n${file.content ?? file.snippet ?? ""}`));
  const usesTortoise = files.some((file) => /tortoise/i.test(`${file.relPath}\n${file.content ?? file.snippet ?? ""}`));
  const pacCustomerRoute = files.some((file) => file.relPath.replaceAll("\\", "/").toLowerCase() === "backend/routes/customers.py");
  const names = new Set<string>();
  const submissionMissing = issues.some((issue) => /customer submission transition is missing/i.test(issue));
  const approvalMissing = issues.some((issue) => /manager approval handler is missing/i.test(issue));
  const rejectionMissing = issues.some((issue) => /manager rejection handler is missing/i.test(issue));
  if (submissionMissing) names.add("backend/routes/customers.py");
  if (approvalMissing || rejectionMissing) names.add("backend/routes/customers.py");
  const hasGenericTransactionFailure = issues.some((issue) => /transaction boundary|audit(?:\/history)? persistence|audit event persistence/i.test(issue));
  if (hasGenericTransactionFailure) {
    const owners = files.filter((file) => /(^|\/)backend\/routes?\/.*\.py$/i.test(file.relPath) && /(?:submit|approv|reject|in_transaction|ApprovalEvent|AuditEvent)/i.test(file.content ?? file.snippet ?? "")
      && !(usesSqlAlchemy && !usesTortoise && pacCustomerRoute && /(^|\/)backend\/routes\/submission\.py$/i.test(file.relPath)));
    for (const owner of owners) names.add(owner.relPath.replaceAll("\\", "/").toLowerCase());
  }
  if (names.size === 0) {
    names.add("backend/routes/customers.py");
  }
  return [...names].sort();
}

function ensurePostgresServiceScaffold(stageId: string, prompt: string, edits: ProposedEdit[], context: ProjectContext): ProposedEdit[] {
  if (stageId !== "scaffold" || !/\bpostgres(?:ql)?\b/i.test(prompt)) return edits;
  const existing = filesWithEdits(context, edits);
  if ([...existing.keys()].some((path) => /(^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(path))) return edits;
  // A generic database container skeleton is deterministic infrastructure,
  // not a business-app implementation. It prevents model omissions in the
  // most basic executable scaffold while leaving app services to generation.
  return [...edits, {
    path: "docker-compose.yml",
    action: "create",
    content: [
      "services:",
      "  db:",
      "    image: postgres:16-alpine",
      "    environment:",
      "      POSTGRES_DB: ${POSTGRES_DB:-app}",
      "      POSTGRES_USER: ${POSTGRES_USER:-app}",
      "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in your environment}",
      "    ports:",
      '      - "127.0.0.1:5432:5432"',
      "    volumes:",
      "      - postgres_data:/var/lib/postgresql/data",
      "    healthcheck:",
      '      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-app} -d ${POSTGRES_DB:-app}"]',
      "      interval: 5s",
      "      timeout: 3s",
      "      retries: 20",
      "volumes:",
      "  postgres_data:",
      "",
    ].join("\n"),
  }];
}

interface ArchitectureScaffoldAdapter {
  id: string;
  supports(prompt: string, architecture: ProjectArchitectureContract): boolean;
  create(context: ProjectContext, edits: ProposedEdit[]): ProposedEdit[];
}

function fastApiSqlAlchemyScaffold(context: ProjectContext, edits: ProposedEdit[]): ProposedEdit[] {
  const current = filesWithEdits(context, edits);
  const output = new Map(edits.map((edit) => [edit.path.toLowerCase(), edit]));
  const put = (path: string, content: string) => {
    const existing = current.get(path.toLowerCase());
    const workspaceFileExists = (context.relevantFiles ?? []).some((file) => file.relPath.replaceAll("\\", "/").toLowerCase() === path.toLowerCase() && typeof file.content === "string");
    const proposed = output.get(path.toLowerCase());
    output.set(path.toLowerCase(), { path, action: workspaceFileExists ? "modify" : proposed?.action ?? "create", content });
  };
  const dependencyLines = (current.get("backend/requirements.txt")?.content ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .map((line) => /^sqlalchemy(?:\s|[<>=!~@]|$)/i.test(line) && !/^sqlalchemy\[asyncio\]/i.test(line) ? line.replace(/^sqlalchemy/i, "sqlalchemy[asyncio]") : line);
  const additions = ["fastapi>=0.115,<1", "uvicorn[standard]>=0.30,<1", "sqlalchemy[asyncio]>=2.0,<3", "asyncpg>=0.29,<1", "alembic>=1.13,<2", "pydantic-settings>=2.5,<3", "passlib[bcrypt]>=1.7,<2", "bcrypt>=4.0,<4.1", "python-jose[cryptography]>=3.3,<4", "python-multipart>=0.0.9,<1", "pytest>=8,<9", "httpx>=0.27,<1"];
  const requiredNames = additions.map((line) => line.split(/[<>=!~]/, 1)[0].split("[", 1)[0].toLowerCase());
  const present = new Set(dependencyLines.map((line) => line.split(/[<>=!~]/, 1)[0].split("[", 1)[0].toLowerCase()));
  put("backend/requirements.txt", [...dependencyLines, ...additions.filter((line, index) => !present.has(requiredNames[index]))].join("\n") + "\n");
  put("backend/__init__.py", '"""MobiusX generated FastAPI application package."""\n');
  put("backend/routes/__init__.py", '"""FastAPI route modules."""\n');
  put("backend/config.py", [
    "from pydantic_settings import BaseSettings, SettingsConfigDict",
    "",
    "class Settings(BaseSettings):",
    "    database_url: str",
    "    secret_key: str",
    "    cors_origins: str = \"http://127.0.0.1:3000,http://localhost:3000\"",
    "    model_config = SettingsConfigDict(env_file=\".env\", extra=\"ignore\")",
    "",
    "settings = Settings()",
    "",
  ].join("\n"));
  put("backend/database.py", [
    "from collections.abc import AsyncIterator",
    "from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine",
    "from sqlalchemy.orm import DeclarativeBase",
    "from backend.config import settings",
    "",
    "engine = create_async_engine(settings.database_url, pool_pre_ping=True)",
    "SessionLocal = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)",
    "",
    "class Base(DeclarativeBase):",
    "    \"\"\"Declarative base shared by generated database models.\"\"\"",
    "",
    "async def get_db() -> AsyncIterator[AsyncSession]:",
    "    async with SessionLocal() as session:",
    "        yield session",
    "",
  ].join("\n"));
  put("backend/alembic.ini", [
    "[alembic]",
    "script_location = backend/migrations",
    "prepend_sys_path = .",
    "sqlalchemy.url =",
    "",
    "[loggers]",
    "keys = root,sqlalchemy,alembic",
    "[handlers]",
    "keys = console",
    "[formatters]",
    "keys = generic",
    "[logger_root]",
    "level = WARN",
    "handlers = console",
    "qualname =",
    "[logger_sqlalchemy]",
    "level = WARN",
    "handlers =",
    "qualname = sqlalchemy.engine",
    "[logger_alembic]",
    "level = INFO",
    "handlers =",
    "qualname = alembic",
    "[handler_console]",
    "class = StreamHandler",
    "args = (sys.stderr,)",
    "level = NOTSET",
    "formatter = generic",
    "[formatter_generic]",
    "format = %(levelname)-5.5s [%(name)s] %(message)s",
    "datefmt = %H:%M:%S",
    "",
  ].join("\n"));
  put("backend/migrations/env.py", [
    "import asyncio",
    "from logging.config import fileConfig",
    "from alembic import context",
    "from sqlalchemy import pool",
    "from sqlalchemy.ext.asyncio import async_engine_from_config",
    "from backend.config import settings",
    "from backend.database import Base",
    "import backend.models  # noqa: F401 - registers mapped tables on Base.metadata",
    "",
    "config = context.config",
    "config.set_main_option(\"sqlalchemy.url\", settings.database_url.replace(\"%\", \"%%\"))",
    "if config.config_file_name:",
    "    fileConfig(config.config_file_name)",
    "target_metadata = Base.metadata",
    "",
    "def run_migrations_offline() -> None:",
    "    context.configure(url=settings.database_url, target_metadata=target_metadata, literal_binds=True, dialect_opts={\"paramstyle\": \"named\"})",
    "    with context.begin_transaction():",
    "        context.run_migrations()",
    "",
    "def do_run_migrations(connection) -> None:",
    "    context.configure(connection=connection, target_metadata=target_metadata)",
    "    with context.begin_transaction():",
    "        context.run_migrations()",
    "",
    "async def run_migrations_online() -> None:",
    "    connectable = async_engine_from_config(config.get_section(config.config_ini_section, {}), prefix=\"sqlalchemy.\", poolclass=pool.NullPool)",
    "    async with connectable.connect() as connection:",
    "        await connection.run_sync(do_run_migrations)",
    "    await connectable.dispose()",
    "",
    "if context.is_offline_mode():",
    "    run_migrations_offline()",
    "else:",
    "    asyncio.run(run_migrations_online())",
    "",
  ].join("\n"));
  put("backend/main.py", [
    "from fastapi import FastAPI",
    "",
    "app = FastAPI(title=\"Generated Application API\")",
    "",
    "@app.get(\"/health\")",
    "async def health() -> dict[str, str]:",
    "    return {\"status\": \"healthy\"}",
    "",
    "",
  ].join("\n"));
  // Vite/React packaging is stable stack infrastructure. Keeping it in the
  // scaffold adapter avoids spending a local model call on manifests that
  // can be validated deterministically; application screens remain generated
  // later from the requirements.
  const frontendManifest = current.get("frontend/package.json")?.content;
  if (!frontendManifest) put("frontend/package.json", JSON.stringify({
    name: "generated-frontend",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite --host 0.0.0.0", build: "tsc -b && vite build", start: "vite preview --host 0.0.0.0 --port 3000", "test:e2e": "playwright test" },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { "@playwright/test": "^1.55.0", "@types/react": "^19.0.0", "@types/react-dom": "^19.0.0", "@vitejs/plugin-react": "^4.3.0", typescript: "^5.6.3", vite: "^5.4.0" },
  }, null, 2) + "\n");
  if (!current.has("frontend/index.html")) put("frontend/index.html", "<!doctype html>\n<html lang=\"en\">\n  <head><meta charset=\"UTF-8\" /><meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" /><title>Customer Onboarding</title></head>\n  <body><div id=\"root\"></div><script type=\"module\" src=\"/src/main.tsx\"></script></body>\n</html>\n");
  if (!current.has("frontend/vite.config.ts")) put("frontend/vite.config.ts", "import { defineConfig } from \"vite\";\nimport react from \"@vitejs/plugin-react\";\n\nexport default defineConfig({ plugins: [react()] });\n");
  if (!current.has("frontend/tsconfig.json")) put("frontend/tsconfig.json", JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }, { path: "./tsconfig.node.json" }] }, null, 2) + "\n");
  if (!current.has("frontend/tsconfig.app.json")) put("frontend/tsconfig.app.json", JSON.stringify({ compilerOptions: { tsBuildInfoFile: "./node_modules/.tmp/tsconfig.app.tsbuildinfo", target: "ES2022", useDefineForClassFields: true, lib: ["ES2022", "DOM", "DOM.Iterable"], module: "ESNext", skipLibCheck: true, moduleResolution: "bundler", allowImportingTsExtensions: true, verbatimModuleSyntax: true, moduleDetection: "force", noEmit: true, jsx: "react-jsx", strict: true, noUnusedLocals: true, noUnusedParameters: true }, include: ["src"] }, null, 2) + "\n");
  if (!current.has("frontend/tsconfig.node.json")) put("frontend/tsconfig.node.json", JSON.stringify({ compilerOptions: { composite: true, skipLibCheck: true, module: "ESNext", moduleResolution: "bundler", allowImportingTsExtensions: true, verbatimModuleSyntax: true, moduleDetection: "force", noEmit: true, strict: true }, include: ["vite.config.ts", "playwright.config.ts"] }, null, 2) + "\n");
  if (!current.has("frontend/src/main.tsx")) put("frontend/src/main.tsx", "import React from \"react\";\nimport { createRoot } from \"react-dom/client\";\nimport App from \"./App\";\n\ncreateRoot(document.getElementById(\"root\")!).render(<React.StrictMode><App /></React.StrictMode>);\n");
  put("README.md", [
    "# Generated Application",
    "",
    "## Run locally",
    "",
    "1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` and `SECRET_KEY`.",
    "2. Run `docker compose up --build`.",
    "3. The API health endpoint is `http://127.0.0.1:8000/health`.",
    "4. Run backend tests with `docker compose exec backend pytest`.",
    "5. Run browser tests with `docker compose exec frontend npm run test:e2e`.",
    "",
    "Database schema changes use Alembic (`alembic -c backend/alembic.ini upgrade head`).",
    "",
  ].join("\n"));
  return [...output.values()];
}

const architectureScaffoldAdapters: ArchitectureScaffoldAdapter[] = [{
  id: "fastapi-sqlalchemy-postgresql",
  supports: (prompt, architecture) => /fastapi/i.test(prompt) && architecture.stack.backend === "fastapi" && architecture.stack.orm === "sqlalchemy" && architecture.stack.database === "postgresql",
  create: fastApiSqlAlchemyScaffold,
}];

export function ensureArchitectureScaffold(stageId: string, prompt: string, architecture: ProjectArchitectureContract, edits: ProposedEdit[], context: ProjectContext): ProposedEdit[] {
  const adapter = architectureScaffoldAdapters.find((candidate) => candidate.supports(prompt, architecture));
  if (!adapter) return edits;
  const scaffoldEdits = adapter.create(context, edits);
  if (stageId === "scaffold") return scaffoldEdits;
  // On resumed projects, refresh only the deterministic dependency manifest
  // required by the validated adapter. Never replay its entry-point/config
  // files over an already validated or user-modified scaffold.
  const requirements = scaffoldEdits.find((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "backend/requirements.txt");
  if (!requirements || edits.some((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "backend/requirements.txt" && edit.content === requirements.content)) return edits;
  return [...edits, requirements];
}

function hasValidatedScaffoldAdapter(prompt: string, architecture: ProjectArchitectureContract): boolean {
  return architectureScaffoldAdapters.some((adapter) => adapter.supports(prompt, architecture));
}

export function shouldUseValidatedScaffoldOnly(
  stageId: BuildStageId,
  isResume: boolean,
  prompt: string,
  context: ProjectContext | undefined,
  architecture: ProjectArchitectureContract,
): boolean {
  return stageId === "scaffold"
    && !isResume
    && isBlankProject(context)
    && hasValidatedScaffoldAdapter(prompt, architecture);
}

/** Add reusable runtime packaging for the explicitly supported Next.js/FastAPI/PostgreSQL stack. */
export function ensureWebDeploymentScaffold(stageId: string, prompt: string, edits: ProposedEdit[], context: ProjectContext, migrationFramework = "sql"): { edits: ProposedEdit[]; changed: string[] } {
  // Deployment infrastructure has scaffold/database ownership. Re-running it
  // during backend, UI, or test stages used to rewrite docker-compose.yml
  // from a failed test proposal and silently shadow the validated version.
  if (!["scaffold", "database"].includes(stageId)
    || !/postgres(?:ql)?/i.test(prompt) || !/fastapi/i.test(prompt) || !/(?:next(?:\.js|js)?|react)/i.test(prompt)) {
    return { edits: [], changed: [] };
  }
  const files = filesWithEdits(context, edits);
  const generated: ProposedEdit[] = [];
  const migrationCommand = migrationFramework.toLowerCase() === "alembic"
    ? "alembic -c backend/alembic.ini upgrade head"
    : "python -m backend.migrate";
  const has = (path: string) => files.has(path.toLowerCase());
  const actionFor = (path: string): ProposedEdit["action"] => has(path) ? "modify" : "create";
  if (has("backend/requirements.txt") && !has("backend/dockerfile")) generated.push({
    path: "backend/Dockerfile", action: "create",
    content: "FROM python:3.12-slim\nENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PYTHONPATH=/app\nWORKDIR /app\nCOPY requirements.txt /app/backend/requirements.txt\nRUN pip install --no-cache-dir -r /app/backend/requirements.txt\nCOPY . /app/backend\nEXPOSE 8000\nCMD [\"uvicorn\", \"backend.main:app\", \"--host\", \"0.0.0.0\", \"--port\", \"8000\"]\n",
  });
  const packageFile = files.get("frontend/package.json");
  if (packageFile && !has("frontend/dockerfile")) generated.push({
    path: "frontend/Dockerfile", action: "create",
    content: "FROM node:20-alpine AS build\nWORKDIR /app\nARG NEXT_PUBLIC_API_URL=http://127.0.0.1:8000/api\nENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL\nCOPY package*.json ./\nRUN npm install\nCOPY . .\nRUN npm run build\n\nFROM node:20-alpine AS runtime\nENV NODE_ENV=production\nWORKDIR /app\nCOPY --from=build /app ./\nEXPOSE 3000\nCMD [\"npm\", \"run\", \"start\"]\n",
  });

  const sqlMigrations = [...files.keys()].filter((path) => /^backend\/migrations\/.*\.sql$/i.test(path));
  const requirements = files.get("backend/requirements.txt");
  if (migrationFramework.toLowerCase() !== "alembic" && sqlMigrations.length && requirements && !has("backend/migrate.py")) {
    if (!/^asyncpg(?:\s|[<>=!~]|$)/im.test(requirements.content)) {
      generated.push({ ...files.get("backend/requirements.txt")!, path: files.get("backend/requirements.txt")!.originalPath ?? "backend/requirements.txt", action: actionFor("backend/requirements.txt"), content: `${requirements.content.trimEnd()}\nasyncpg>=0.29,<1.0\n` });
    }
    generated.push({ path: "backend/migrate.py", action: "create", content: "import asyncio\nimport os\nfrom pathlib import Path\nimport asyncpg\n\nasync def main():\n    dsn = os.environ.get('DATABASE_URL')\n    if not dsn:\n        raise RuntimeError('DATABASE_URL must be configured')\n    if dsn.startswith('postgres://'):\n        dsn = 'postgresql://' + dsn[len('postgres://'):]\n    connection = await asyncpg.connect(dsn)\n    try:\n        await connection.execute('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)')\n        for path in sorted((Path(__file__).parent / 'migrations').glob('*.sql')):\n            if await connection.fetchval('SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE version=$1)', path.name):\n                continue\n            statements = [part.strip() for part in path.read_text().split(';') if part.strip()]\n            async with connection.transaction():\n                for statement in statements:\n                    await connection.execute(statement)\n                await connection.execute('INSERT INTO schema_migrations(version) VALUES($1)', path.name)\n            print(f'Applied migration {path.name}')\n    finally:\n        await connection.close()\n\nif __name__ == '__main__':\n    asyncio.run(main())\n" });
  }

  const composeEntry = [...files.entries()].find(([path]) => /(^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(path));
  if (composeEntry) {
    const [key, file] = composeEntry;
    let lines = file.content.trimEnd().split(/\r?\n/);
    const servicesIndex = lines.findIndex((line) => /^services\s*:\s*$/.test(line));
    if (servicesIndex >= 0) {
      const blocks = new Map<string, string[]>();
      let active = "";
      for (let i = servicesIndex + 1; i < lines.length; i += 1) {
        const service = lines[i].match(/^  ([A-Za-z0-9_-]+):\s*$/);
        if (service) { active = service[1]; blocks.set(active, []); continue; }
        if (/^\S/.test(lines[i])) { active = ""; continue; }
        if (active) blocks.get(active)!.push(lines[i]);
      }
      let changed = false;
      let databaseService = [...blocks.entries()].find(([, body]) => body.some((line) => /image\s*:\s*postgres(?:[:\s]|$)/i.test(line)))?.[0];
      const insertAt = () => { const idx = lines.findIndex((line, i) => i > servicesIndex && /^(?:volumes|networks|configs|secrets)\s*:\s*$/.test(line)); return idx < 0 ? lines.length : idx; };
      const addService = (name: string, body: string[]) => {
        const index = insertAt();
        lines.splice(index, 0, ...(index > 0 && lines[index - 1] !== "" ? [""] : []), `  ${name}:`, ...body.map((line) => `    ${line}`));
        changed = true;
      };
      if (!databaseService) {
        databaseService = "db";
        addService(databaseService, ["image: postgres:17-alpine", "environment:", "  POSTGRES_DB: ${POSTGRES_DB:?Set POSTGRES_DB in .env}", "  POSTGRES_USER: ${POSTGRES_USER:?Set POSTGRES_USER in .env}", "  POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}", "volumes:", "  - postgres_data:/var/lib/postgresql/data", "healthcheck:", '  test: [\"CMD-SHELL\", \"pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}\"]', "  interval: 5s", "  timeout: 3s", "  retries: 20"]);
      }
      if (databaseService && !(blocks.get(databaseService) ?? []).some((line) => /^\s*healthcheck\s*:/i.test(line))) {
        const start = lines.findIndex((line) => line === `  ${databaseService}:`);
        let end = start + 1;
        while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
        lines.splice(end, 0, "    healthcheck:", '      test: ["CMD-SHELL", "pg_isready -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]', "      interval: 5s", "      timeout: 3s", "      retries: 20");
        changed = true;
      }
      if (databaseService) {
        const body = blocks.get(databaseService) ?? [];
        const start = lines.findIndex((line) => line === `  ${databaseService}:`);
        let end = start + 1;
        while (end < lines.length && !/^  [A-Za-z0-9_-]+:\s*$/.test(lines[end]) && !/^\S/.test(lines[end])) end += 1;
        const additions: string[] = [];
        if (!body.some((line) => /^\s*environment\s*:/i.test(line))) {
          additions.push("    environment:", "      POSTGRES_DB: ${POSTGRES_DB:?Set POSTGRES_DB in .env}", "      POSTGRES_USER: ${POSTGRES_USER:?Set POSTGRES_USER in .env}", "      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD in .env}");
        }
        if (!body.some((line) => /^\s*volumes\s*:/i.test(line))) additions.push("    volumes:", "      - postgres_data:/var/lib/postgresql/data");
        if (additions.length) { lines.splice(end, 0, ...additions); changed = true; }
      }
      const databaseUrl = migrationFramework.toLowerCase() === "alembic"
        ? `postgresql+asyncpg://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@${databaseService}:5432/\${POSTGRES_DB}`
        : `postgresql://\${POSTGRES_USER}:\${POSTGRES_PASSWORD}@${databaseService}:5432/\${POSTGRES_DB}`;
      if (!blocks.has("backend") && has("backend/requirements.txt")) addService("backend", ["build: ./backend", "environment:", `  DATABASE_URL: ${databaseUrl}`, "  SECRET_KEY: ${SECRET_KEY:?Set SECRET_KEY in .env}", "  CORS_ORIGINS: ${CORS_ORIGINS:-http://127.0.0.1:3000,http://localhost:3000}", `command: ["sh", "-c", "${migrationCommand} && uvicorn backend.main:app --host 0.0.0.0 --port 8000"]`, 'ports: ["127.0.0.1:8000:8000"]', "depends_on:", `  ${databaseService}:`, "    condition: service_healthy", "healthcheck:", `  test: ["CMD", "python", "-c", "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=2)"]`, "  interval: 5s", "  timeout: 3s", "  retries: 20"]);
      if (blocks.has("backend") && migrationFramework.toLowerCase() === "alembic") {
        const backendStart = lines.findIndex((line) => line === "  backend:");
        const backendEnd = lines.findIndex((line, index) => index > backendStart && (/^  [A-Za-z0-9_-]+:\s*$/.test(line) || /^\S/.test(line)));
        const end = backendEnd < 0 ? lines.length : backendEnd;
        for (let index = backendStart + 1; index < end; index += 1) {
          if (/^\s+command\s*:/i.test(lines[index])) {
            lines[index] = `    command: ["sh", "-c", "${migrationCommand} && uvicorn backend.main:app --host 0.0.0.0 --port 8000"]`;
            changed = true;
          }
          if (/^\s+DATABASE_URL\s*:/i.test(lines[index])) {
            lines[index] = `      DATABASE_URL: ${databaseUrl}`;
            changed = true;
          }
        }
      }
      if (!blocks.has("frontend") && packageFile) addService("frontend", ["build:", "  context: ./frontend", "  args:", "    NEXT_PUBLIC_API_URL: http://127.0.0.1:8000/api", 'ports: ["127.0.0.1:3000:3000"]', "depends_on:", "  backend:", "    condition: service_healthy", "healthcheck:", `  test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]`, "  interval: 5s", "  timeout: 3s", "  retries: 20"]);
      const volumesIndex = lines.findIndex((line) => /^volumes\s*:\s*$/.test(line));
      if (volumesIndex < 0) lines.push("", "volumes:", "  postgres_data:");
      else if (!lines.some((line, index) => index > volumesIndex && /^  postgres_data:\s*$/.test(line))) lines.splice(volumesIndex + 1, 0, "  postgres_data:");
      if (changed) generated.push({ path: file.originalPath ?? key, action: actionFor(file.originalPath ?? key), content: `${lines.join("\n")}\n` });
    }
  }

  if (!has(".env.example")) generated.push({ path: ".env.example", action: "create", content: "# Copy to .env and replace every placeholder with unique local values. Never commit secrets.\nPOSTGRES_DB=onboarding\nPOSTGRES_USER=onboarding\nPOSTGRES_PASSWORD=\nSECRET_KEY=\nCORS_ORIGINS=http://127.0.0.1:3000,http://localhost:3000\n" });
  if (!has("readme.md")) generated.push({ path: "README.md", action: "create", content: `# Generated application\n\n## Run locally with Docker Compose\n\nCopy \`.env.example\` to \`.env\`, replace each secret placeholder, then run \`docker compose up --build\`. The frontend binds to \`127.0.0.1:3000\`; the API binds to \`127.0.0.1:8000\`; PostgreSQL stays on the private Compose network. Compose waits for database health before starting the API and for API health before starting the frontend.\n\nDatabase migration command: \`${migrationCommand}\` (run from the repository root). Follow the generated backend migration files for schema updates.\n` });
  return { edits: generated, changed: generated.map((edit) => edit.path) };
}

/** Replace literal credentials in generated Compose environment mappings with required env references. */
export function normalizeComposeCredentialDefaults(edits: ProposedEdit[]): { edits: ProposedEdit[]; changed: string[] } {
  const changed: string[] = [];
  const normalized = edits.map((edit) => {
    if (!/(^|\/)(?:docker-compose|compose)\.ya?ml$/i.test(edit.path.replaceAll("\\", "/"))) return edit;
    let touched = false;
    const content = edit.content.split(/\r?\n/).map((line) => {
      const mapping = line.match(/^(\s*)([A-Z][A-Z0-9_]*)(\s*:\s*)(.*)$/i);
      const listItem = line.match(/^(\s*-\s*)([A-Z][A-Z0-9_]*)=(.*)$/i);
      const match = mapping ?? listItem;
      if (!match) return line;
      const prefix = mapping ? `${match[1]}${match[2]}${match[3]}` : `${match[1]}${match[2]}=`;
      const rawValue = mapping ? match[4] : match[3];
      const key = match[2];
      if (!/(?:PASSWORD|SECRET|TOKEN|API_KEY|DATABASE_URL|DB_URL)$/i.test(key)) return line;
      const value = rawValue.trim();
      const safeRequiredReference = /^['"]?\$\{[A-Z_][A-Z0-9_]*:\?[^}]+\}['"]?$/.test(value);
      const unsafeUrlCredential = /(?:postgres(?:ql)?|mysql|redis):\/\/[^/@\s:]+:[^/@\s]+@/i.test(value);
      if (safeRequiredReference && !unsafeUrlCredential) return line;
      const reference = `\${${key}:?Set ${key} in your environment}`;
      touched = true;
      return `${prefix}${reference}`;
    }).join("\n");
    if (!touched) return edit;
    changed.push(edit.path);
    return { ...edit, content };
  });
  return { edits: normalized, changed };
}

/** Wire generated FastAPI APIRouter modules into the generated application entry point. */
export function registerGeneratedFastApiRouters(
  stageId: BuildStage["id"],
  edits: ProposedEdit[],
  context?: ProjectContext,
  architecture?: ProjectArchitectureContract,
): { edits: ProposedEdit[]; registered: string[]; changed: boolean } {
  if (stageId !== "backend" && stageId !== "transactions") return { edits, registered: [], changed: false };
  const candidates = filesWithEdits(context, edits);
  const main = candidates.get("backend/main.py");
  if (!main || !/\bapp\s*=\s*FastAPI\s*\(/.test(main.content)) return { edits, registered: [], changed: false };
  const registrations: string[] = [];
  const routeFiles = [...candidates.entries()].filter(([path, file]) =>
    /^backend\/routes\/.+\.py$/i.test(path) && /\bAPIRouter\s*\(/.test(file.content),
  );
  let content = main.content;
  const configuredCors = candidates.get("backend/config.py")?.content ?? "";
  const hasWebFrontend = architecture
    ? architecture.stack.backend === "fastapi" && ["react", "nextjs"].includes(architecture.stack.frontend)
    : [...candidates.keys()].some((path) => /^(?:frontend|client|web)\/package\.json$/i.test(path)) && /\bcors_origins\b/.test(configuredCors);
  let corsChanged = false;
  if (hasWebFrontend && !/app\.add_middleware\(\s*CORSMiddleware\b/.test(content)) {
    if (!/^from\s+fastapi\.middleware\.cors\s+import\s+CORSMiddleware\s*$/m.test(content)) {
      content = `from fastapi.middleware.cors import CORSMiddleware\n${content}`;
    }
    if (!/^from\s+backend\.config\s+import\s+settings\s*$/m.test(content)) content = `from backend.config import settings\n${content}`;
    const appDeclaration = content.match(/^app\s*=\s*FastAPI\([^\n]*\)\s*$/m);
    if (appDeclaration) {
      const middleware = [
        "app.add_middleware(",
        "    CORSMiddleware,",
        "    allow_origins=[origin.strip() for origin in settings.cors_origins.split(\",\") if origin.strip()],",
        "    allow_credentials=False,",
        "    allow_methods=[\"GET\", \"POST\", \"PUT\", \"PATCH\", \"DELETE\", \"OPTIONS\"],",
        "    allow_headers=[\"Authorization\", \"Content-Type\"],",
        ")",
      ].join("\n");
      content = content.replace(appDeclaration[0], `${appDeclaration[0]}\n\n${middleware}`);
      corsChanged = true;
    }
  }
  let normalizedExistingRegistration = false;
  const availableRouteModules = new Set(routeFiles.map(([path]) => path.slice("backend/routes/".length, -3).replaceAll("/", ".").split(".").at(-1)!));
  content = content.replace(/^from\s+(?:backend\.)?routes\s+import\s+([^\n]+)$/gm, (line, imports: string) => {
    const normalized: string[] = [];
    for (const item of imports.split(",").map((value) => value.trim())) {
      const moduleImport = item.match(/^([A-Za-z_]\w*)\s+as\s+([A-Za-z_]\w*)$/);
      if (moduleImport && availableRouteModules.has(moduleImport[1])) {
        normalized.push(`from backend.routes.${moduleImport[1]} import router as ${moduleImport[2]}`);
        normalizedExistingRegistration = true;
      } else normalized.push(item);
    }
    return normalized.length === 1 && normalized[0].startsWith("from backend.routes.") ? normalized[0] : normalized.join("\n");
  });
  for (const [path] of routeFiles) {
    const module = path.slice("backend/routes/".length, -3).replaceAll("/", ".");
    const alias = `mobiusx_${module.replaceAll(".", "_")}_router`;
    let seen = false;
    const include = new RegExp(`^\\s*app\\.include_router\\(\\s*${alias}\\s*\\)\\s*$`, "gm");
    content = content.replace(include, (line) => {
      if (!seen) { seen = true; return line; }
      normalizedExistingRegistration = true;
      return "";
    });
  }
  for (const [path, file] of routeFiles) {
    const routerName = file.content.match(/^\s*([A-Za-z_]\w*)\s*=\s*APIRouter\s*\(/m)?.[1];
    if (!routerName) continue;
    const module = path.slice("backend/routes/".length, -3).replaceAll("/", ".");
    const alias = `mobiusx_${module.replaceAll(".", "_")}_router`;
    const importPattern = new RegExp(`from\\s+(?:\\.routes\\.${module.replaceAll(".", "\\.")}|routes\\.${module.replaceAll(".", "\\.")})\\s+import\\s+${routerName}(?:\\s+as\\s+([A-Za-z_]\\w*))?`);
    const existingImport = content.match(importPattern);
    const importedName = existingImport?.[1] ?? routerName;
    if (existingImport && new RegExp(`\\bapp\\.include_router\\s*\\(\\s*${importedName}\\b`).test(content)) continue;
    if (!existingImport && new RegExp(`\\bapp\\.include_router\\s*\\(\\s*${alias}\\b`).test(content)) continue;
    const importBlock = existingImport
      ? `app.include_router(${importedName})`
      : `if __package__:\n    from .routes.${module} import ${routerName} as ${alias}\nelse:\n    from routes.${module} import ${routerName} as ${alias}\napp.include_router(${alias})`;
    content = `${content.trimEnd()}\n\n${importBlock}\n`;
    registrations.push(path);
  }
  if (registrations.length === 0 && !normalizedExistingRegistration && !corsChanged) return { edits, registered: [], changed: false };
  const mainEdit = edits.find((edit) => edit.path.toLowerCase() === "backend/main.py");
  const mainPathInContext = context?.relevantFiles?.some((file) => file.relPath.replaceAll("\\", "/").toLowerCase() === "backend/main.py") ?? false;
  const updated: ProposedEdit = {
    path: mainEdit?.path ?? "backend/main.py",
    action: mainEdit?.action ?? (mainPathInContext ? "modify" : "create"),
    content,
  };
  return {
    edits: [...edits.filter((edit) => edit.path.toLowerCase() !== "backend/main.py"), updated],
    registered: registrations,
    changed: registrations.length > 0 || normalizedExistingRegistration || corsChanged,
  };
}

function emitStep(emit: (event: TaskEvent) => void, label: string, status: "in_progress" | "completed" | "failed", startedAt: string, completedAt?: string, id: string = randomUUID()): string {
  emit({ type: "step", step: { id, label, status, startedAt, ...(completedAt ? { completedAt } : {}) } });
  return id;
}

interface StageRunResult {
  edits: ProposedEdit[];
  errors: string[];
  failed?: boolean;
}

async function runStage(
  runner: AgentRunner,
  input: RunnerInput,
  prompt: string,
  context: ProjectContext,
  stageMeta: NonNullable<RunnerInput["stagedBuild"]>,
  emit: (event: TaskEvent) => void,
  deadlineAt: number,
  repair = false,
): Promise<StageRunResult> {
  const edits: ProposedEdit[] = [];
  const errors: string[] = [];
  let failed = false;
  const attemptController = new AbortController();
  const signal = AbortSignal.any([...(input.signal ? [input.signal] : []), attemptController.signal]);
  const remainingMs = deadlineAt - Date.now();
  try {
    if (input.signal?.aborted) {
      const error = new Error("staged Build was cancelled");
      error.name = "AbortError";
      throw error;
    }
    if (remainingMs <= 0) throw new Error("staged Build exceeded its end-to-end deadline");
    const modelContext = repair ? context : contextForBuildStage(stageMeta.id as BuildStageId, context);
    const operation = runner.run({ ...input, signal, mode: "build", prompt, projectContext: modelContext, stagedBuild: { ...stageMeta, repair } }, (event) => {
    if (event.type === "edits") edits.push(...event.edits);
    else if (event.type === "error" || event.type === "provider_failure") {
      failed = true;
      errors.push(event.message);
    } else if (event.type === "status") {
      if (event.status === "failed" || event.status === "cancelled") failed = true;
      // The outer task owns its terminal state; stage terminal events are
      // intentionally withheld until every capability gate has passed.
    } else if (event.type === "done") {
      // A stage completion is not a whole-task completion.
    } else {
      emit(event);
    }
    });
    await new Promise<void>((resolve, reject) => {
      const onParentAbort = () => {
        attemptController.abort();
        const error = new Error("staged Build was cancelled");
        error.name = "AbortError";
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onParentAbort);
      };
      const timer = setTimeout(() => {
        attemptController.abort();
        cleanup();
        reject(new Error("staged Build exceeded its end-to-end deadline"));
      }, remainingMs);
      input.signal?.addEventListener("abort", onParentAbort, { once: true });
      operation.then(
        () => { cleanup(); resolve(); },
        (error: unknown) => { cleanup(); reject(error); },
      );
    });
  } catch (error) {
    failed = true;
    errors.push(input.signal?.aborted ? "generation was cancelled" : (error as Error).message);
  }
  if (edits.length === 0 && !failed) {
    failed = true;
    errors.push("the model returned no file edits for this generation stage");
  }
  return { edits, errors, failed };
}

/**
 * Generate blank multi-tier applications through a sequence of bounded,
 * capability-checked calls to the already selected provider. Other project
 * shapes and all other inference modes continue through their normal runner.
 */
export function createBuildPipelineRunner(selected: AgentRunner, timeoutMs = DEFAULT_STAGED_BUILD_TIMEOUT_MS): AgentRunner {
  return {
    name: selected.name,
    listModels: () => selected.listModels(),
    async run(input, emit) {
      if (input.mode !== "build" || (!input.resumeCheckpoint && !shouldUseStagedBuild(input.prompt, input.projectContext))) {
        await selected.run(input, emit);
        return;
      }

      // The stage runner consumes the selected provider's running/terminal
      // events so a stage cannot accidentally finish the parent task. Emit
      // the parent transition explicitly so clients do not show "queued"
      // while the first local inference request is already running.
      emit({ type: "status", status: "running" });
      const stages = buildStages(input.prompt);
      const requirementsHash = createHash("sha256").update(input.prompt).digest("hex");
      const suppliedResume = input.resumeCheckpoint;
      const architectureFiles = [
        ...(input.projectContext?.relevantFiles ?? []).filter((file) => typeof file.content === "string").map((file) => ({ path: file.relPath, content: file.content! })),
        ...(suppliedResume?.artifacts ?? []).map(({ path, content }) => ({ path, content })),
      ];
      const baseArchitecture = suppliedResume?.projectArchitecture ?? resolveProjectArchitecture(input.prompt, architectureFiles);
      const applyReviewScopeEvolution = Boolean(suppliedResume && !baseArchitecture.reviewScope && /review[\s_-]*scope/i.test(input.prompt));
      const architecture = applyReviewScopeEvolution ? approveReviewScopeArchitectureChange(baseArchitecture) : baseArchitecture;
      const architectureIssues = validateProjectArchitectureContract(architecture);
      if (architectureIssues.length) {
        emit({ type: "error", message: `Cannot start generation safely: ${architectureIssues.join("; ")}` });
        emit({ type: "status", status: "failed" });
        emit({ type: "done" });
        return;
      }
      const evolvedResume = suppliedResume && applyReviewScopeEvolution ? evolveReviewScopeCheckpoint(suppliedResume, architecture) : suppliedResume;
      const repairedResume = evolvedResume ? repairDatabaseCheckpointArtifacts(evolvedResume, architecture) : undefined;
      const snapshotRepair = repairedResume?.checkpoint ? repairIncompleteCheckpointStageSnapshot(repairedResume.checkpoint) : undefined;
      let resume = snapshotRepair?.checkpoint ?? repairedResume?.checkpoint;
      const savedLogin = resume?.businessOperations?.find((item) => item.operationId === "auth.login");
      let savedLoginVersion: unknown;
      try { savedLoginVersion = savedLogin ? (JSON.parse(savedLogin.content) as { schemaVersion?: unknown }).schemaVersion : undefined; } catch { savedLoginVersion = undefined; }
      if (resume && savedLogin && savedLoginVersion !== "2.0") {
        const authStageIndex = stages.findIndex((stage) => stage.id === "backend");
        if (authStageIndex >= 0 && resume.completedStageIds.length > authStageIndex) {
          resume = {
            ...resume,
            completedStageIds: resume.completedStageIds.slice(0, authStageIndex),
            stages: resume.stages.slice(0, authStageIndex),
            updatedAt: new Date().toISOString(),
          };
          emit({ type: "output", delta: "\nSaved auth.login is a legacy contract without request/response metadata. Reopening only the backend contract stage to version the login operation from its validated FastAPI schemas; existing scaffold, database, and business-operation artifacts remain checksummed and reusable." });
        }
      }
      const resumeFiles = new Map((resume?.artifacts ?? []).map((artifact) => [artifact.path.replaceAll("\\", "/").toLowerCase(), artifact.content]));
      const needsBrowserCors = !!resume
        && !!resumeFiles.get("frontend/package.json")
        && /\bcors_origins\b/.test(resumeFiles.get("backend/config.py") ?? "")
        && !/app\.add_middleware\(\s*CORSMiddleware\b/.test(resumeFiles.get("backend/main.py") ?? "");
      if (needsBrowserCors && resume) {
        const backendStageIndex = stages.findIndex((stage) => stage.id === "backend");
        if (backendStageIndex >= 0 && resume.completedStageIds.length > backendStageIndex) {
          resume = {
            ...resume,
            completedStageIds: resume.completedStageIds.slice(0, backendStageIndex),
            stages: resume.stages.slice(0, backendStageIndex),
            updatedAt: new Date().toISOString(),
          };
          emit({ type: "output", delta: "\nReopening the backend integration checkpoint to add the PAC-configured CORS middleware required for the generated browser client; database, authentication, and business-operation artifacts remain reusable." });
        }
      }
      if (snapshotRepair?.changed) emit({ type: "output", delta: "\nResume reconciled incomplete legacy stage snapshots from the checksum-verified artifact manifest; generated application files were not changed." });
      if (applyReviewScopeEvolution) emit({ type: "output", delta: "\nApproved additive PAC 1.1 evolution: ReviewScope assignment is persisted, manager reads are restricted by matching scope, and a checksummed Alembic backfill was staged without regenerating the validated application scaffold." });
      if (repairedResume?.changedPaths.length) {
        emit({ type: "output", delta: `\nResume applied deterministic, PAC-matched SQLAlchemy normalization to checksummed checkpoint artifacts: ${repairedResume.changedPaths.join(", ")}.` });
      }
      const resumeFailure = resume ? validateResumeCheckpoint(resume, input, requirementsHash, stages, selected.name, architecture) : undefined;
      if (resumeFailure) {
        emit({ type: "error", message: `Cannot resume generation safely: ${resumeFailure}` });
        emit({ type: "status", status: "failed" });
        emit({ type: "done" });
        return;
      }
      let resumeStartIndex = resume?.completedStageIds.length ?? 0;
      let resumeValidationIssues: string[] = [];
      const beganAt = new Date().toISOString();
      const initialCheckpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = resume ? {
        ...resume,
        projectArchitecture: architecture,
        updatedAt: beganAt,
      } : {
        version: 1,
        taskId: input.taskId,
        requirementsHash,
        provider: selected.name,
        modelId: input.modelId ?? "unknown",
        ...(input.projectContext?.projectPath ? { projectPath: input.projectContext.projectPath } : {}),
        completedStageIds: [],
        stages: [],
        artifacts: [],
        baseFiles: (input.projectContext?.relevantFiles ?? []).map((file) => ({ path: file.relPath, sha256: createHash("sha256").update(file.content ?? file.snippet).digest("hex") })),
        pendingStageIds: stages.map((stage) => stage.id),
        pendingDependencies: [],
        repairHistory: [],
        projectArchitecture: architecture,
        updatedAt: beganAt,
      };
      const initialBasePaths = new Set(initialCheckpoint.baseFiles.map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
      const normalizeCheckpointAction = <T extends { path: string; action: ProposedEdit["action"] }>(artifact: T): T =>
        initialBasePaths.has(artifact.path.replaceAll("\\", "/").toLowerCase()) ? { ...artifact, action: "modify" } : artifact;
      const normalizedInitialCheckpoint: typeof initialCheckpoint = {
        ...initialCheckpoint,
        artifacts: initialCheckpoint.artifacts.map(normalizeCheckpointAction),
        stages: initialCheckpoint.stages.map((stage) => ({
          ...stage,
          ...(stage.artifacts ? { artifacts: stage.artifacts.map(normalizeCheckpointAction) } : {}),
        })),
      };
      normalizedInitialCheckpoint.artifactOwnership = buildArtifactOwnershipManifest(normalizedInitialCheckpoint);
      emit({ type: "generation_checkpoint", checkpoint: normalizedInitialCheckpoint });
      let resumeState: typeof initialCheckpoint | undefined = normalizedInitialCheckpoint;
      let resumeDatabaseSubtasks = [...(resume?.databaseSubtasks ?? [])];
      let businessOperations = [...(resume?.businessOperations ?? [])];
      let businessOperationHistory = [...(resume?.businessOperationHistory ?? [])];
      let uiContracts = [...(resume?.uiContracts ?? [])];
      let testSpecifications = [...(resume?.testSpecifications ?? [])];
      let testSubtasks = [...(resume?.testSubtasks ?? [])];
      if (resume) {
        for (let index = 0; index < resumeStartIndex; index += 1) {
          const prefix = replayStageSnapshots(resume.stages, index + 1);
          const stageArtifacts = prefix ?? resume.artifacts.map(({ path, action, content }) => ({ path, action, content }));
          // Keys are normalized for lookup, but preserve the checkpoint's
          // spelling for filesystem materialization. Dropping the original
          // path here turns `App.tsx` into `app.tsx` on case-sensitive build
          // tools and can make a previously valid frontend fail TS1261.
          const savedFiles = new Map(stageArtifacts.map((artifact) => [artifact.path.replaceAll("\\", "/").toLowerCase(), {
            content: artifact.content,
            action: artifact.action,
            originalPath: artifact.path.replaceAll("\\", "/"),
          }]));
          const priorStageValidationPassed = resume.stages[index]?.validation === "passed";
          const reusableDatabaseCheckpoint = stages[index].id === "database"
            && priorStageValidationPassed
            && validateDatabaseSubtaskCheckpoint(resume.databaseSubtasks ?? [], architecture).issues.length === 0;
          const issues = await validateGeneratedStage(stages[index].id, input.prompt, savedFiles, architecture, {
            // Checkpoint hashes, PAC compatibility, Python syntax, and the prior
            // successful gate are rechecked above/below. Reinstalling the same
            // dependencies during resume only repeats network work and can
            // incorrectly send a valid database stage back to generation.
            skipRuntimeImports: reusableDatabaseCheckpoint,
          });
          if (stages[index].id === "database") {
            issues.push(...validateDatabaseSubtaskCheckpoint(resume.databaseSubtasks ?? [], architecture).issues);
            if (issues.length === 0) {
              const checkpointed = checkpointValidatedDatabaseSubtasks(resumeDatabaseSubtasks, stageArtifacts, architecture, resume.stages[index]?.completedAt ?? beganAt);
              issues.push(...checkpointed.issues);
              if (issues.length === 0 && checkpointed.addedIds.length) {
                resumeDatabaseSubtasks = checkpointed.records;
                emit({ type: "output", delta: `\nResume recorded previously validated database outputs as checksummed subtasks: ${checkpointed.addedIds.join(", ")}.` });
              }
            }
          }
          if (issues.length > 0) {
            resumeValidationIssues = [...issues];
            emit({ type: "output", delta: `\nCheckpoint stage ${stages[index].id} no longer passes the current validation contract. Resuming at that stage: ${[...new Set(issues)].join("; ")}` });
            resumeStartIndex = index;
            const replayedPrefix = replayStageSnapshots(resume.stages, index);
            resumeState = {
              ...resume,
              completedStageIds: resume.completedStageIds.slice(0, index),
              stages: resume.stages.slice(0, index),
              ...(replayedPrefix ? { artifacts: replayedPrefix.map((edit) => ({ ...edit, sha256: createHash("sha256").update(edit.content).digest("hex") })) } : {}),
              pendingStageIds: stages.slice(index).map((stage) => stage.id),
            };
            break;
          }
        }
      }
      if (resumeState && resumeDatabaseSubtasks.length !== (resume?.databaseSubtasks?.length ?? 0)) {
        resumeState = { ...resumeState, databaseSubtasks: resumeDatabaseSubtasks };
        emit({ type: "generation_checkpoint", checkpoint: resumeState });
      }
      const deadlineAt = Date.now() + timeoutMs;
      let context: ProjectContext = input.projectContext ?? { indexedChunkCount: 0 };
      const checkpointArtifactPaths = new Set((resume?.artifacts ?? []).map((artifact) => artifact.path.replaceAll("\\", "/").toLowerCase()));
      const baseFilePaths = new Set((resume?.baseFiles ?? []).map((file) => file.path.replaceAll("\\", "/").toLowerCase()));
      // Resume contexts include a synthesized copy of checkpoint artifacts.
      // Remove that copy before replaying the validated prefix so a rewind
      // cannot accidentally retain files from a later invalid stage.
      if (resume) {
        context = {
          ...context,
          relevantFiles: (context.relevantFiles ?? []).filter((file) => {
            const path = file.relPath.replaceAll("\\", "/").toLowerCase();
            return !checkpointArtifactPaths.has(path) || baseFilePaths.has(path);
          }),
        };
      }
      // A model may only overwrite a file whose complete contents were part of
      // its project context. Snippet-only index results are never sufficient.
      const originalPaths = new Set((input.projectContext?.relevantFiles ?? [])
        .filter((file) => typeof file.content === "string")
        .filter((file) => !resume || !checkpointArtifactPaths.has(file.relPath.replaceAll("\\", "/").toLowerCase()) || baseFilePaths.has(file.relPath.replaceAll("\\", "/").toLowerCase()))
        .map((file) => file.relPath.replaceAll("\\", "/").toLowerCase()));
      if (resumeState) {
        const normalizeExisting = <T extends { path: string; action: ProposedEdit["action"] }>(artifact: T): T =>
          originalPaths.has(artifact.path.replaceAll("\\", "/").toLowerCase()) ? { ...artifact, action: "modify" } : artifact;
        resumeState = {
          ...resumeState,
          artifacts: resumeState.artifacts.map(normalizeExisting),
          stages: resumeState.stages.map((stage) => ({
            ...stage,
            ...(stage.artifacts ? { artifacts: stage.artifacts.map(normalizeExisting) } : {}),
          })),
        };
      }
      let accumulated: ProposedEdit[] = (resumeState?.artifacts ?? []).map(({ path, action, content }) => ({
        path,
        action,
        content,
      }));
      const repairedBackendCheckpoint = repairBackendCheckpointSubtasks(resume?.backendSubtasks, resume?.businessOperations);
      const backendSubtasks = [...(repairedBackendCheckpoint.records ?? [])];
      if (repairedBackendCheckpoint.changedPaths.length) emit({ type: "output", delta: `\nResume applied verified FastAPI/Pydantic compatibility corrections to checksummed backend checkpoint artifacts: ${repairedBackendCheckpoint.changedPaths.join(", ")}. ${repairedBackendCheckpoint.repairs.join("; ")}.` });
      let invalidBackendSubtaskId: string | undefined;
      const invalidatedBackendPaths = new Set<string>();
      if (resume && ["backend", "transactions"].includes(stages[resumeStartIndex]?.id ?? "") && backendSubtasks.length) {
        const plan = backendSubtaskPlan(architecture);
        const deterministicallyRepaired = new Set(repairedBackendCheckpoint.changedPaths.map((path) => path.replaceAll("\\", "/").toLowerCase()));
        const invalidatedPaths = new Set(resumeValidationIssues
          .map((issue) => issue.match(/((?:backend|server|api)\/[^\s:]+\.py)/i)?.[1]?.replaceAll("\\", "/").toLowerCase())
          .filter((path): path is string => typeof path === "string" && !deterministicallyRepaired.has(path)));
        const invalidIndex = backendSubtasks.findIndex((record) => {
          const subtask = plan.find((item) => item.id === record.id);
          if (!subtask) return true;
          const touchesFailedModule = record.artifacts.some((artifact) => invalidatedPaths.has(artifact.path.replaceAll("\\", "/").toLowerCase()));
          return touchesFailedModule || backendSubtaskIssues(subtask, record.artifacts.map(({ path, action, content }) => ({ path, action, content })), architecture).length > 0;
        });
        if (invalidIndex >= 0) {
          invalidBackendSubtaskId = backendSubtasks[invalidIndex].id;
          for (const discarded of backendSubtasks.splice(invalidIndex)) {
            for (const artifact of discarded.artifacts) invalidatedBackendPaths.add(artifact.path.replaceAll("\\", "/").toLowerCase());
          }
          emit({ type: "output", delta: `\nResume revalidation found backend subtask ${invalidBackendSubtaskId} does not satisfy its current security/interface contract. Earlier valid backend outputs are retained; generation resumes at ${invalidBackendSubtaskId}.` });
        }
      }
      const databaseSubtasks = [...resumeDatabaseSubtasks];
      if ((resume?.databaseSubtasks ?? []).some((record, index) => record.artifacts.some((artifact, artifactIndex) => artifact.sha256 !== databaseSubtasks[index]?.artifacts[artifactIndex]?.sha256))) {
        emit({ type: "output", delta: "\nResume applied a deterministic SQLAlchemy normalization to the checksum-verified database checkpoint; no model regeneration was needed for that correction." });
      }
      if (resume && stages[resumeStartIndex]?.id === "database" && databaseSubtasks.length) {
        const subtaskPlan = databaseSubtaskPlan(architecture);
        const invalidIndex = databaseSubtasks.findIndex((record) => {
          const subtask = subtaskPlan.find((item) => item.id === record.id);
          if (!subtask) return true;
          const artifacts = record.artifacts.map(({ path, action, content }) => ({ path, action, content }));
          return databaseSubtaskIssues(subtask, artifacts, architecture).length > 0;
        });
        if (invalidIndex >= 0) {
          const invalidId = databaseSubtasks[invalidIndex].id;
          databaseSubtasks.splice(invalidIndex);
          emit({ type: "output", delta: `\nResume revalidation found database subtask ${invalidId} no longer passes the current SQLAlchemy contract. Keeping earlier validated subtasks and regenerating from ${invalidId}.` });
        }
      }
      if (resume && ["backend", "transactions"].includes(stages[resumeStartIndex]?.id ?? "") && backendSubtasks.length) {
        if (invalidatedBackendPaths.size) {
          context = {
            ...context,
            relevantFiles: (context.relevantFiles ?? []).filter((file) => !invalidatedBackendPaths.has(file.relPath.replaceAll("\\", "/").toLowerCase())),
          };
          // A source path named by a compiler diagnostic is removed completely;
          // an earlier stage snapshot may contain the same bad bytes, so do not
          // reintroduce it as a fallback. The approved subtask can recreate it.
          accumulated = accumulated.filter((edit) => !invalidatedBackendPaths.has(edit.path.replaceAll("\\", "/").toLowerCase()));
        }
        const latestByPath = new Map<string, ProposedEdit>();
        for (const subtask of backendSubtasks) for (const artifact of subtask.artifacts) latestByPath.set(artifact.path.toLowerCase(), { path: artifact.path, action: artifact.action, content: artifact.content });
        const merged = new Map(accumulated.map((edit) => [edit.path.toLowerCase(), edit]));
        for (const [path, edit] of latestByPath) merged.set(path, edit);
        accumulated = [...merged.values()];
        context = addEditsToContext(context, accumulated);
      }
      if (resume && stages[resumeStartIndex]?.id === "database" && databaseSubtasks.length) {
        const latestByPath = new Map<string, ProposedEdit>();
        for (const subtask of databaseSubtasks) for (const artifact of subtask.artifacts) latestByPath.set(artifact.path.toLowerCase(), { path: artifact.path, action: artifact.action, content: artifact.content });
        const merged = new Map(accumulated.map((edit) => [edit.path.toLowerCase(), edit]));
        for (const [path, edit] of latestByPath) merged.set(path, edit);
        accumulated = [...merged.values()];
      }
      if (resume) context = addEditsToContext(context, accumulated);
      const repairHistory: Array<{ stageId: string; attempts: number; outcomes: string[] }> = [...(resumeState?.repairHistory ?? [])];
      let latestCheckpoint: NonNullable<RunnerInput["resumeCheckpoint"]> | undefined = resumeState;
      if (resumeState && (invalidBackendSubtaskId || repairedBackendCheckpoint.changedPaths.length)) {
        resumeState = { ...resumeState, backendSubtasks: [...backendSubtasks] };
        latestCheckpoint = resumeState;
        emit({ type: "generation_checkpoint", checkpoint: resumeState });
      }
      let resumeAttemptToRepair: { stageId: BuildStage["id"]; edits: ProposedEdit[] } | undefined;

      // A prior run can fail only because its gate was too strict or has since
      // been corrected. Revalidate its checksummed failed-stage artifacts
      // under the current contract before spending another model call. If they
      // now pass, promote them into the validated checkpoint; otherwise leave
      // them as historical diagnostics and regenerate the stage normally.
      if (resume && resumeStartIndex < stages.length) {
        const stage = stages[resumeStartIndex];
        const priorAttempt = [...(resume.attemptedStages ?? [])].reverse().find((attempt) => attempt.id === stage.id);
        const reusableUiContribution = stage.id === "frontend" && (resume.uiContracts ?? []).some((record) => hasReusableUiContributionCheckpoint(record, architecture.contractHash, input.modelId));
        const savedLoginRecord = resume.businessOperations?.find((item) => item.operationId === "auth.login");
        let savedLoginSchemaVersion: unknown;
        try { savedLoginSchemaVersion = savedLoginRecord ? (JSON.parse(savedLoginRecord.content) as { schemaVersion?: unknown }).schemaVersion : undefined; } catch { savedLoginSchemaVersion = undefined; }
        const requiresLoginContractUpgrade = stage.id === "backend" && !!savedLoginRecord && savedLoginSchemaVersion !== "2.0";
        const requiresBrowserIntegrationUpgrade = stage.id === "backend" && needsBrowserCors;
        // A current, checksummed model contribution is a newer recovery input
        // than a failed frontend attempt. Skip the old repair baseline so the
        // frontend stage can validate the PAC/API contract and render the
        // cached contribution without paying for another inference request.
        if (priorAttempt && !reusableUiContribution && !requiresLoginContractUpgrade && !requiresBrowserIntegrationUpgrade) {
          // A timed-out/truncated structured response may not yield any safe
          // file operations. Still resume from the last validated checkpoint
          // and focus on the persisted diagnostics instead of regenerating the
          // whole failed stage.
          let edits = priorAttempt.artifacts.map(({ path, action, content }) => ({ path, action, content }));
          let combined = combineBuildEdits(accumulated, edits, originalPaths);
          const recoveredDeployment = ensureWebDeploymentScaffold(stage.id, input.prompt, combined.edits, context, architecture.stack.migrations);
          if (recoveredDeployment.changed.length) {
            edits = [...edits, ...recoveredDeployment.edits];
            combined = combineBuildEdits(accumulated, edits, originalPaths);
            emit({ type: "output", delta: `\nMobiusX supplied reusable web-stack deployment artifacts: ${recoveredDeployment.changed.join(", ")}.` });
          }
          let testHarnessErrors: string[] = [];
          if (stage.testFramework === "playwright") {
            const harness = ensurePlaywrightHarness(combined.edits);
            testHarnessErrors = harness.errors;
            if (harness.edits.length) {
              edits = [...edits, ...harness.edits];
              combined = combineBuildEdits(accumulated, edits, originalPaths);
              emit({ type: "output", delta: `\nMobiusX staged the validated Playwright harness: ${harness.changedPaths.join(", ")}.` });
            }
          }
          let candidateFiles = filesWithEdits(context, combined.edits);
          const lockedPriorModules = restoreValidatedBackendSubtaskArtifacts(combined.edits, backendSubtasks);
          if (lockedPriorModules.restoredPaths.length) {
            combined = { ...combined, edits: lockedPriorModules.edits };
            candidateFiles = filesWithEdits(context, combined.edits);
            emit({ type: "output", delta: `\nMobiusX restored previously validated backend modules before repair: ${lockedPriorModules.restoredPaths.join(", ")}.` });
          }
          const resumedSubtaskIssues = ["backend", "transactions"].includes(stage.id)
            ? backendSubtaskPlan(architecture)
              .filter((subtask) => stage.id === "backend"
                ? !["customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api"].includes(subtask.id)
                : ["customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api"].includes(subtask.id))
              .flatMap((subtask) => {
                const file = candidateFiles.get(subtask.targetPaths[0].toLowerCase());
                return file
                  ? backendSubtaskIssues(subtask, [{ path: subtask.targetPaths[0], action: "modify", content: file.content }], architecture)
                  : [`${subtask.id} is missing its approved route module ${subtask.targetPaths[0]}`];
              })
            : [];
          let currentIssues = [...testHarnessErrors, ...combined.actionIssues, ...resumedSubtaskIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
          currentIssues.push(...validateStageArtifactOwnership(stage.id, accumulated, combined.edits));
          const syntaxRepair = promoteAwaitingPythonRoutes(combined.edits, currentIssues);
          if (syntaxRepair.changedPaths.length) {
            edits = syntaxRepair.edits;
            combined = combineBuildEdits(accumulated, edits, originalPaths);
            candidateFiles = filesWithEdits(context, combined.edits);
            currentIssues = [...combined.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
            emit({ type: "output", delta: `\nMobiusX corrected await-bearing FastAPI route declarations in: ${syntaxRepair.changedPaths.join(", ")}.` });
          }
          const knownImportRepair = repairKnownPythonNameErrors(combined.edits, currentIssues);
          if (knownImportRepair.changedPaths.length) {
            edits = knownImportRepair.edits;
            combined = combineBuildEdits(accumulated, edits, originalPaths);
            candidateFiles = filesWithEdits(context, combined.edits);
            currentIssues = [...combined.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
            emit({ type: "output", delta: `\nMobiusX added the verified FastAPI framework import in: ${knownImportRepair.changedPaths.join(", ")}.` });
          }
          const relativeImportRepair = repairResolvablePythonRelativeImports(combined.edits, context);
          if (relativeImportRepair.changedPaths.length) {
            edits = relativeImportRepair.edits;
            combined = combineBuildEdits(accumulated, edits, originalPaths);
            candidateFiles = filesWithEdits(context, combined.edits);
            currentIssues = [...combined.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
            emit({ type: "output", delta: `\nMobiusX corrected unambiguous Python package-relative imports in: ${relativeImportRepair.changedPaths.join(", ")}.` });
          }
          const knownFrontendRepair = repairKnownFrontendToolingIssues(combined.edits, currentIssues);
          if (knownFrontendRepair.changedPaths.length) {
            edits = [...edits, ...knownFrontendRepair.edits.filter((edit) => knownFrontendRepair.changedPaths.includes(edit.path))];
            combined = combineBuildEdits(accumulated, edits, originalPaths);
            candidateFiles = filesWithEdits(context, combined.edits);
            currentIssues = [...combined.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
            emit({ type: "output", delta: `\nMobiusX repaired verifiable frontend tooling issues from the isolated compiler diagnostics: ${knownFrontendRepair.changedPaths.join(", ")}.` });
          }
          if (currentIssues.length) emit({ type: "output", delta: `\nPreserved ${stage.id} attempt did not pass current validation and remains diagnostic-only: ${[...new Set(currentIssues)].join("; ")}` });
          if (currentIssues.length === 0) {
            const previousArtifacts = accumulated;
            accumulated = combined.edits;
            context = addEditsToContext(context, accumulated);
            const completedAt = new Date().toISOString();
            const artifactPaths = [...new Set(edits.map((edit) => edit.path))];
            const checkpointBase = resumeState ?? resume;
            const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = {
              ...checkpointBase,
              ...(businessOperations.length ? { businessOperations: [...businessOperations] } : {}),
              ...(businessOperationHistory.length ? { businessOperationHistory: [...businessOperationHistory] } : {}),
              ...(backendSubtasks.length ? { backendSubtasks: [...backendSubtasks] } : {}),
              ...(databaseSubtasks.length ? { databaseSubtasks: [...databaseSubtasks] } : {}),
              ...(uiContracts.length ? { uiContracts: [...uiContracts] } : {}),
              ...(testSpecifications.length ? { testSpecifications: [...testSpecifications] } : {}),
              ...(testSubtasks.length ? { testSubtasks: [...testSubtasks] } : {}),
              completedStageIds: [...checkpointBase.completedStageIds, stage.id],
              stages: [...checkpointBase.stages, { id: stage.id, completedAt, artifactPaths, artifacts: snapshotStageDelta(previousArtifacts, accumulated, originalPaths), validation: "passed" }],
              artifacts: accumulated.map((edit) => ({ path: edit.path, action: edit.action, content: edit.content, sha256: createHash("sha256").update(edit.content).digest("hex") })),
              pendingStageIds: stages.slice(resumeStartIndex + 1).map((item) => item.id),
              updatedAt: completedAt,
            };
            checkpoint.artifactOwnership = buildArtifactOwnershipManifest(checkpoint);
            latestCheckpoint = checkpoint;
            resumeState = checkpoint;
            emitStep(emit, `${stage.label} · preserved attempt passed current validation`, "completed", completedAt, completedAt);
            emit({ type: "output", delta: `\nThe preserved ${stage.id} attempt now passes the current validation contract; continuing from that checkpoint without regenerating it.` });
            emit({ type: "edits", edits: accumulated });
            emit({ type: "generation_checkpoint", checkpoint });
            resumeStartIndex += 1;
          } else {
            // Preserve the failed stage as the repair baseline. A resume should
            // diagnose and patch these exact files instead of asking the model
            // to regenerate the entire stage and discarding its prior work.
            resumeAttemptToRepair = { stageId: stage.id, edits };
          }
        }
      }

      for (let index = resumeStartIndex; index < stages.length; index += 1) {
        const stage = stages[index];
        const startedAt = new Date().toISOString();
        const stageStepId = emitStep(emit, stage.label, "in_progress", startedAt);
        const frontendApiIssues = stage.id === "frontend"
          ? validateFrontendBackendContract(filesWithEdits(context, accumulated), input.prompt)
          : [];
        if (frontendApiIssues.length > 0) {
          const completedAt = new Date().toISOString();
          const failure = `Frontend generation blocked by backend API contract mismatches: ${frontendApiIssues.join("; ")}`;
          emit({ type: "output", delta: `\n${failure}. No frontend model request was made; validated backend artifacts remain unchanged.` });
          emitStep(emit, `${stage.label} · blocked by backend API contract`, "failed", startedAt, completedAt, stageStepId);
          const checkpointBase = latestCheckpoint ?? resumeState ?? normalizedInitialCheckpoint;
          emit({ type: "generation_checkpoint", checkpoint: {
            ...checkpointBase,
            attemptedStages: [...(checkpointBase.attemptedStages ?? []), {
              id: stage.id,
              attemptedAt: completedAt,
              validation: "failed",
              issues: frontendApiIssues,
              repairOutcomes: ["frontend generation skipped before inference because required backend read contracts are missing or incompatible"],
              artifacts: [],
            }],
            pendingStageIds: stages.slice(index).map((pending) => pending.id),
            updatedAt: completedAt,
          } });
          emit({ type: "error", message: failure });
          emit({ type: "status", status: "failed" });
          emit({ type: "done" });
          return;
        }
        const isFinal = index === stages.length - 1;
        const stageMeta = { index: index + 1, total: stages.length, id: stage.id, final: isFinal };
        const basePrompt = stagePrompt(input.prompt, stage, index, stages.length, architecture, accumulated);
        let result: StageRunResult = { edits: [], errors: [], failed: true };
        let stageContextForRepair = context;
        let testStagePrompt: string | undefined;
        let testStageContext: ProjectContext | undefined;
        let providerRespondedInStage = false;
        const emitForStage = (event: TaskEvent) => {
          if (event.type === "model_diagnostic" && event.diagnostic.phase === "complete" && !event.diagnostic.errorCategory && !event.diagnostic.deadlineExceeded) providerRespondedInStage = true;
          emit(event);
        };
        const generatedScaffoldFromAdapter = shouldUseValidatedScaffoldOnly(stage.id, Boolean(resume), input.prompt, input.projectContext, architecture);
        let databaseSubtaskFailed = false;
        let uiContractPreflightFailed = false;
        if (resumeAttemptToRepair?.stageId === stage.id && ["backend", "transactions"].includes(stage.id)) {
          // Failed backend artifacts are diagnostic evidence, not a substitute
          // for a missing validated subtask. Resume at the first incomplete
          // PAC subtask; the existing loop skips every checksummed completion.
          emit({ type: "output", delta: `\nDiscarding failed backend-stage proposals as generation inputs and resuming from the first incomplete ${stage.id} subtask; validated backend subtask checkpoints remain available.` });
          resumeAttemptToRepair = undefined;
        }
        if (resumeAttemptToRepair?.stageId === stage.id && stage.id !== "database") {
          result = { edits: resumeAttemptToRepair.edits, errors: [] };
          resumeAttemptToRepair = undefined;
          emit({ type: "output", delta: `\nResuming the preserved ${stage.id} attempt as the repair baseline; MobiusX will request only the minimal changes required by its current diagnostics.` });
        } else if (generatedScaffoldFromAdapter) {
          // Stable package, database, and container scaffolding is supplied
          // by the validated stack adapter below. Save the selected model for
          // application-specific schema, API, transaction, UI, and tests.
          result = { edits: [], errors: [] };
          emit({ type: "output", delta: "\nMobiusX is creating the validated FastAPI/SQLAlchemy and React/Vite project scaffold from its stack adapter; application-specific stages will use the selected model." });
        } else if (stage.id === "database") {
          const plan = databaseSubtaskPlan(architecture);
          const completedSubtasks = new Set(databaseSubtasks.map((item) => item.id));
          const subtaskEdits: ProposedEdit[] = [];
          let taskContext = addEditsToContext(context, accumulated);
          for (let subtaskIndex = 0; subtaskIndex < plan.length; subtaskIndex += 1) {
            const subtask = plan[subtaskIndex];
            if (completedSubtasks.has(subtask.id)) {
              emit({ type: "output", delta: `\nResuming database generation: checksum-verified subtask ${subtask.id} is already complete.` });
              continue;
            }
            if (subtask.id === "role-authorization") {
              const authenticationRecord = backendSubtasks.find((record) => record.id === "authentication");
              const authArtifacts = authenticationRecord?.artifacts.map(({ path, action, content }) => ({ path, action, content })) ?? [];
              if (authArtifacts.length && backendSubtaskIssues(subtask, authArtifacts, architecture).length === 0) {
                const completedAt = new Date().toISOString();
                backendSubtasks.push({ id: subtask.id, completedAt, architectureHash: architecture.contractHash, artifacts: authenticationRecord!.artifacts });
                emitStep(emit, `Backend subtask ${subtask.id} · validated from authentication module (no additional inference)`, "completed", completedAt, completedAt);
                const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), backendSubtasks: [...backendSubtasks], updatedAt: completedAt };
                latestCheckpoint = checkpoint;
                emit({ type: "generation_checkpoint", checkpoint });
                continue;
              }
            }
            const validatedSubtaskFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
            const targetFileOperations = subtask.targetPaths.map((path) => {
              const existing = validatedSubtaskFiles.get(path.replaceAll("\\", "/").toLowerCase());
              return existing
                ? { path, action: "modify" as const, expectedContentSha256: createHash("sha256").update(existing.content).digest("hex"), completeContentRequired: true }
                : { path, action: "create" as const, completeContentRequired: true };
            });
            const targetActionInstructions = targetFileOperations.map((target) => target.action === "create"
              ? `${target.path} is absent from the validated checkpoint; return action "create" with the complete file contents. A "modify" proposal is normalized to create only for this exact manifest target.`
              : `${target.path} exists in the validated checkpoint at SHA-256 ${target.expectedContentSha256}; it was supplied in full and must be returned as action "modify" with complete replacement contents.`);
            const taskPrompt = [basePrompt, `\nDATABASE SUBTASK ${subtaskIndex + 1}/${plan.length} (${subtask.id})`, "Generate only the exact target path(s) below. Return complete file contents. Do not add unrelated paths.", "Target file operation contract (authoritative):", ...targetActionInstructions, JSON.stringify({ targetPaths: subtask.targetPaths, targetFileOperations, acceptanceCriteria: subtask.acceptanceCriteria, architecture: architecture.stack })].join("\n");
            emitStep(emit, `Database subtask ${subtaskIndex + 1}/${plan.length} · ${subtask.id}`, "in_progress", new Date().toISOString());
            let generated: StageRunResult;
            if (subtask.id === "review-scope-schema") {
              const currentModels = filesWithEdits(taskContext, subtaskEdits).get("backend/models.py")?.content;
              if (!currentModels) throw new Error("PAC review-scope subtask requires the validated SQLAlchemy models module");
              generated = { edits: ensureReviewScopeScaffold({ modelPath: "backend/models.py", modelSource: currentModels, migrationPath: "backend/migrations/versions/0002_review_scopes.py", migrationSource: filesWithEdits(taskContext, subtaskEdits).get("backend/migrations/versions/0002_review_scopes.py")?.content, previousRevision: "0001_initial" }), errors: [], failed: false };
              emit({ type: "output", delta: "\nMobiusX rendered the PAC-approved ReviewScope model and additive Alembic migration from the validated PostgreSQL scaffold." });
            } else {
              generated = await runStage(selected, input, taskPrompt, taskContext, { ...stageMeta, subtask }, emit, deadlineAt);
            }
            let unexpected = generated.edits.filter((edit) => !subtask.targetPaths.some((path) => path.toLowerCase() === edit.path.replaceAll("\\", "/").toLowerCase()));
            let allowed = generated.edits.filter((edit) => !unexpected.includes(edit));
            const modelSource = filesWithEdits(taskContext, allowed).get("backend/models.py")?.content ?? "";
            const initialEnumRepair = repairKnownSqlAlchemyModelIssues(allowed);
            const initialMigrationRepair = repairKnownPostgresEnumMigrationIssues(initialEnumRepair.edits, modelSource);
            allowed = initialMigrationRepair.edits;
            if (initialEnumRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX corrected unambiguous SQLAlchemy enum column declarations in: ${initialEnumRepair.changedPaths.join(", ")}.` });
            if (initialMigrationRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX added a stable PostgreSQL enum type name derived from the generated model in: ${initialMigrationRepair.changedPaths.join(", ")}.` });
            const databaseCandidate = filesWithEdits(taskContext, allowed);
            let subtaskIssues = [...generated.errors, ...unexpected.map((edit) => `unapproved generated path ${edit.path}`), ...databaseSubtaskIssues(subtask, allowed, architecture), ...await validatePythonSources(databaseCandidate), ...await validatePythonModuleSymbols(databaseCandidate)];
            const subtaskRepairOutcomes: string[] = [];
            for (let repairAttempt = 1; subtaskIssues.length > 0 && repairAttempt <= 2 && !input.signal?.aborted && deadlineAt > Date.now(); repairAttempt += 1) {
              const priorIssues = [...new Set(subtaskIssues)];
              emit({ type: "output", delta: `\nDatabase subtask ${subtask.id} failed validation: ${priorIssues.join("; ")}. Requesting focused repair ${repairAttempt}/2 for ${subtask.targetPaths.join(", ")}…` });
              const repairPrompt = [taskPrompt, `Focused repair ${repairAttempt}/2: return a minimal, complete replacement for only the exact target file(s).`, "Exact diagnostics:", ...priorIssues.map((issue) => `- ${issue}`), "Fix every listed issue. Preserve already-correct symbols and relationships. Do not change the PAC, ORM, module paths, or unrelated files."].join("\n");
              const repaired = await runStage(selected, input, repairPrompt, taskContext, { ...stageMeta, repair: true, subtask }, emit, deadlineAt, true);
              if (!repaired.edits.length) {
                subtaskRepairOutcomes.push(`attempt ${repairAttempt}: no usable in-scope repair edits`);
                if (repaired.errors.length) subtaskIssues = [...new Set([...subtaskIssues, ...repaired.errors])];
                break;
              }
              const repairedUnexpected = repaired.edits.filter((edit) => !subtask.targetPaths.some((path) => path.toLowerCase() === edit.path.replaceAll("\\", "/").toLowerCase()));
              const rawRepairedAllowed = repaired.edits.filter((edit) => !repairedUnexpected.includes(edit));
              const deterministicRepair = repairKnownSqlAlchemyModelIssues(rawRepairedAllowed);
              const repairedModelSource = filesWithEdits(taskContext, deterministicRepair.edits).get("backend/models.py")?.content ?? modelSource;
              const deterministicMigrationRepair = repairKnownPostgresEnumMigrationIssues(deterministicRepair.edits, repairedModelSource);
              const repairedAllowed = deterministicMigrationRepair.edits;
              if (deterministicRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX corrected unambiguous SQLAlchemy enum column declarations in: ${deterministicRepair.changedPaths.join(", ")}.` });
              if (deterministicMigrationRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX added a stable PostgreSQL enum type name derived from the generated model in: ${deterministicMigrationRepair.changedPaths.join(", ")}.` });
              const repairedCandidate = filesWithEdits(taskContext, repairedAllowed);
              const repairedIssues = [...repaired.errors, ...repairedUnexpected.map((edit) => `unapproved generated path ${edit.path}`), ...databaseSubtaskIssues(subtask, repairedAllowed, architecture), ...await validatePythonSources(repairedCandidate), ...await validatePythonModuleSymbols(repairedCandidate)];
              const madeProgress = repairedIssues.length === 0 || priorIssues.some((issue) => !repairedIssues.includes(issue));
              if (!madeProgress) {
                subtaskRepairOutcomes.push(`attempt ${repairAttempt}: rejected because the same diagnostics remained`);
                break;
              }
              generated = repaired;
              unexpected = repairedUnexpected;
              allowed = repairedAllowed;
              subtaskIssues = [...new Set(repairedIssues)];
              subtaskRepairOutcomes.push(`attempt ${repairAttempt}: ${subtaskIssues.length ? "diagnostics changed; remaining issues: " + subtaskIssues.join("; ") : "passed validation"}`);
              if (subtaskIssues.length && repairAttempt === 2) break;
            }
            if (subtaskIssues.length) {
              databaseSubtaskFailed = true;
              result = { edits: [...subtaskEdits, ...generated.edits], errors: [...new Set(subtaskIssues)] };
              if (subtaskRepairOutcomes.length) emit({ type: "output", delta: `\nDatabase subtask ${subtask.id} repair history: ${subtaskRepairOutcomes.join(" | ")}` });
              emitStep(emit, `Database subtask ${subtask.id} · failed: ${subtaskIssues.join("; ")}`, "failed", startedAt, new Date().toISOString());
              break;
            }
            const next = combineBuildEdits(accumulated, allowed, originalPaths);
            if (next.actionIssues.length) {
              databaseSubtaskFailed = true;
              result = { edits: [...subtaskEdits, ...allowed], errors: next.actionIssues };
              break;
            }
            const wholeModel = filesWithEdits(taskContext, next.edits);
            const syntaxIssues = await validatePythonSources(wholeModel);
            if (syntaxIssues.length) {
              databaseSubtaskFailed = true;
              result = { edits: [...subtaskEdits, ...allowed], errors: syntaxIssues };
              break;
            }
            subtaskEdits.push(...allowed);
            accumulated = next.edits;
            context = addEditsToContext(context, accumulated);
            taskContext = addEditsToContext(context, accumulated);
            const completedAt = new Date().toISOString();
            const snapshot = next.edits.filter((edit) => subtask.targetPaths.some((path) => path.toLowerCase() === edit.path.toLowerCase())).map((edit) => ({
              path: edit.path, action: edit.action, content: edit.content, sha256: createHash("sha256").update(edit.content).digest("hex"),
            }));
            databaseSubtasks.push({ id: subtask.id, completedAt, architectureHash: architecture.contractHash, artifacts: snapshot });
            emitStep(emit, `Database subtask ${subtask.id} · validated (${snapshot.length} artifact${snapshot.length === 1 ? "" : "s"})`, "completed", startedAt, completedAt);
            const subtaskCheckpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = {
              ...(latestCheckpoint ?? normalizedInitialCheckpoint),
              databaseSubtasks: [...databaseSubtasks],
              updatedAt: completedAt,
            };
            latestCheckpoint = subtaskCheckpoint;
            emit({ type: "generation_checkpoint", checkpoint: subtaskCheckpoint });
          }
          if (!result!) result = { edits: subtaskEdits, errors: [] };
        } else if (stage.id === "backend" || stage.id === "transactions") {
          const plan = backendSubtaskPlan(architecture).filter((subtask) => stage.id === "backend"
            ? !["customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api"].includes(subtask.id)
            : ["customer-registration-api", "submission-api", "manager-decision-api", "audit-history-api"].includes(subtask.id));
          const completedSubtasks = new Set(backendSubtasks.map((item) => item.id));
          const subtaskEdits: ProposedEdit[] = [];
          const restoredSubtaskArtifacts = restoreValidatedBackendSubtaskArtifacts(accumulated, backendSubtasks);
          if (restoredSubtaskArtifacts.restoredPaths.length) {
            accumulated = restoredSubtaskArtifacts.edits;
            context = addEditsToContext(context, accumulated);
            emit({ type: "output", delta: `\nMobiusX rebuilt its backend module view from checksum-verified subtask artifacts, preserving each operation's validated handler: ${restoredSubtaskArtifacts.restoredPaths.join(", ")}.` });
          }
          let taskContext = addEditsToContext(context, accumulated);
          for (let subtaskIndex = 0; subtaskIndex < plan.length; subtaskIndex += 1) {
            const subtask = plan[subtaskIndex];
            if (completedSubtasks.has(subtask.id)) {
              const priorIndex = backendSubtasks.findIndex((item) => item.id === subtask.id);
              const prior = backendSubtasks[priorIndex];
              const priorEdits = (prior?.artifacts ?? []).map(({ path, action, content }) => ({ path, action, content }));
              let priorIssues = prior ? backendSubtaskIssues(subtask, priorEdits, architecture) : ["validated subtask record is missing"];
              if (subtask.id === "customer-registration-api" && prior) {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const models = sourceFiles.get("backend/models.py")?.content;
                const schemas = sourceFiles.get("backend/schemas.py")?.content;
                const route = priorEdits.find((edit) => edit.path.toLowerCase() === "backend/routes/customers.py")?.content;
                const registrationRecord = businessOperations.find((item) => item.operationId === "customer.register");
                if (!models || !schemas || !route || !registrationRecord) {
                  priorIssues.push("saved registration checkpoint is missing its model, schema, route, or operation contract");
                } else {
                  try {
                    if (createHash("sha256").update(registrationRecord.content).digest("hex") !== registrationRecord.sha256 || registrationRecord.architectureHash !== architecture.contractHash) throw new Error("saved customer.register operation checksum or PAC hash is invalid");
                    const catalog = extractBusinessDomainCatalog(architecture, models, schemas, ["customer", "manager"], ["customer.register", "customer.submit", "manager.approve", "manager.reject"]);
                    const operation = JSON.parse(registrationRecord.content) as EntityCreateOperationSpec;
                    priorIssues.push(...validateEntityCreateOperationSpec(operation, architecture, catalog));
                    priorIssues.push(...validateEntityCreateRenderedOperation(route, operation, models));
                  } catch (error) {
                    priorIssues.push(`saved registration checkpoint could not be revalidated: ${(error as Error).message}`);
                  }
                }
              }
              if (subtask.id === "auth-api" && prior) {
                const authRecord = businessOperations.find((item) => item.operationId === "auth.login");
                const route = priorEdits.find((edit) => edit.path.toLowerCase() === "backend/routes/auth.py")?.content;
                if (!authRecord || !route) priorIssues.push("saved auth-api checkpoint is missing its route or auth.login operation contract");
                else {
                  try {
                    if (authRecord.architectureHash !== architecture.contractHash || createHash("sha256").update(authRecord.content).digest("hex") !== authRecord.sha256) throw new Error("saved auth.login checksum or PAC hash is invalid");
                    const saved = JSON.parse(authRecord.content) as AuthenticationLoginOperationSpec;
                    if (saved.schemaVersion !== "2.0") priorIssues.push("saved auth.login contract predates complete request/response metadata");
                    if (!/responses\s*=\s*\{\s*401\s*:/.test(route)) priorIssues.push("saved auth.login route does not expose its 401 response in OpenAPI");
                    priorIssues.push(...validateAuthenticationLoginOperationSpec(saved, architecture,
                      filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]).get("backend/auth.py")?.content ?? "",
                      filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]).get("backend/models.py")?.content ?? "",
                      filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]).get("backend/schemas.py")?.content ?? ""));
                  } catch (error) { priorIssues.push(`saved auth-api operation could not be revalidated: ${(error as Error).message}`); }
                }
              }
              if (subtask.id === "router-registration" && prior
                && ["react", "nextjs"].includes(architecture.stack.frontend)
                && !priorEdits.some((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "backend/main.py" && /app\.add_middleware\(\s*CORSMiddleware\b/.test(edit.content))) {
                priorIssues.push("saved FastAPI entry point is missing the PAC-configured browser CORS middleware for the frontend client");
              }
              if (!priorIssues.length) {
                emit({ type: "output", delta: `\nResuming backend generation: checksum-verified subtask ${subtask.id} is already complete.` });
                continue;
              }
              completedSubtasks.delete(subtask.id);
              if (priorIndex >= 0) backendSubtasks.splice(priorIndex, 1);
              emit({ type: "output", delta: `\nReopening prior backend subtask ${subtask.id}; its saved artifacts no longer satisfy the current operation contract: ${priorIssues.join("; ")}.` });
              const rewindCheckpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), backendSubtasks: [...backendSubtasks], updatedAt: new Date().toISOString() };
              latestCheckpoint = rewindCheckpoint;
              emit({ type: "generation_checkpoint", checkpoint: rewindCheckpoint });
            }
            const validatedSubtaskFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
            const targetFileOperations = subtask.targetPaths.map((path) => {
              const existing = validatedSubtaskFiles.get(path.replaceAll("\\", "/").toLowerCase());
              return existing
                ? { path, action: "modify" as const, expectedContentSha256: createHash("sha256").update(existing.content).digest("hex"), completeContentRequired: true }
                : { path, action: "create" as const, completeContentRequired: true };
            });
            const targetActionInstructions = targetFileOperations.map((target) => target.action === "create"
              ? `${target.path} does not exist in the validated stage/checkpoint artifacts. Return action "create" with complete file content; do not describe or patch an absent file.`
              : `${target.path} exists in validated context at SHA-256 ${target.expectedContentSha256} and is shown in full. Return action "modify" with a complete replacement.`);
            const taskPrompt = [
              "Approved application requirements (focused summary):", compactBackendRequirements(input.prompt),
              `Backend implementation subtask: ${subtask.id}.`,
              "PAC is immutable for this run. Use only its declared stack and exact target paths. Return complete file contents for the target file(s), with no unrelated files.",
              "Target file operation manifest (authoritative):", ...targetActionInstructions,
              JSON.stringify({ schemaVersion: architecture.schemaVersion, contractHash: architecture.contractHash, stack: architecture.stack, targetPaths: subtask.targetPaths, targetFileOperations, interfaces: architecture.modules.filter((module) => subtask.targetPaths.some((path) => path.toLowerCase() === module.path.toLowerCase())), acceptanceCriteria: subtask.acceptanceCriteria }),
              ...backendSubtaskExecutionRules(subtask, architecture),
              "Use the existing validated SQLAlchemy models and AsyncSession lifecycle. The PAC Settings module declares only database_url, secret_key, and cors_origins; use JWT algorithm HS256 as a constant. require_role must be a synchronous dependency factory returning an async inner dependency that returns the authenticated User. Never call async-generator get_db as a context manager. Never invent a module or dependency. Preserve all validated behavior in a modified file. Return structured edits only.",
            ].join("\n");
            const subtaskStartedAt = new Date().toISOString();
            emitStep(emit, `Backend subtask ${subtask.id}`, "in_progress", subtaskStartedAt);
            let generated: StageRunResult;
            if (subtask.id === "customer-registration-api") {
              const operationStartedAt = new Date().toISOString();
              const operationStepId = emitStep(emit, "Resolve and validate customer registration operation contract", "in_progress", operationStartedAt);
              try {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const models = sourceFiles.get("backend/models.py")?.content;
                const schemas = sourceFiles.get("backend/schemas.py")?.content;
                if (!models || !schemas) throw new Error("validated checkpoint is missing backend/models.py or backend/schemas.py");
                const catalog = extractBusinessDomainCatalog(architecture, models, schemas, ["customer", "manager"], ["customer.register", "customer.submit", "manager.approve", "manager.reject"]);
                const operationId = "customer.register";
                let operationRecord = businessOperations.find((item) => item.operationId === operationId);
                let operation: EntityCreateOperationSpec;
                if (operationRecord) {
                  if (operationRecord.architectureHash !== architecture.contractHash || createHash("sha256").update(operationRecord.content).digest("hex") !== operationRecord.sha256) throw new Error("saved customer.register operation has a PAC mismatch or checksum error");
                  operation = JSON.parse(operationRecord.content) as EntityCreateOperationSpec;
                } else {
                  const resolved = createEntityCreateOperationSpec({
                    architecture, catalog, modelSource: models, schemaSource: schemas,
                    operationId, targetModule: subtask.targetPaths[0], routePath: "/customers", functionName: "create_customer",
                    actorRole: "customer", permission: "customer.register", entity: "Customer", bodySchema: "CustomerCreate",
                    responseSchema: "CustomerResponse", auditEntity: "AuditEvent", auditAction: "created",
                    auditActorField: "user_id", auditSubjectField: "customer_id", auditActionField: "action",
                    ...(catalog.entities.Customer?.states?.includes("pending") ? { serverState: { field: "status", value: "pending" } } : {}),
                  });
                  operation = resolved.spec;
                  if (resolved.issues.length) throw new Error(`customer.register operation failed validation: ${resolved.issues.join("; ")}`);
                  const createdAt = new Date().toISOString();
                  const content = JSON.stringify(operation);
                  operationRecord = { operationId, architectureHash: architecture.contractHash, content, sha256: createHash("sha256").update(content).digest("hex"), createdAt };
                  businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), operationRecord];
                  const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations, updatedAt: createdAt };
                  latestCheckpoint = checkpoint;
                  emit({ type: "generation_checkpoint", checkpoint });
                }
                const operationIssues = validateEntityCreateOperationSpec(operation, architecture, catalog);
                if (operationIssues.length) throw new Error(`saved customer.register operation failed validation: ${operationIssues.join("; ")}`);
                const routeSource = sourceFiles.get(subtask.targetPaths[0].toLowerCase())?.content;
                if (!routeSource) throw new Error(`approved target file is unavailable: ${subtask.targetPaths[0]}`);
                const renderedRoute = appendEntityCreateOperation(routeSource, operation, models);
                const renderedIssues = validateEntityCreateRenderedOperation(renderedRoute, operation, models);
                if (renderedIssues.length) throw new Error(`rendered customer.register route failed validation: ${renderedIssues.join("; ")}`);
                generated = { edits: [{ path: subtask.targetPaths[0], action: "modify", content: renderedRoute }], errors: [], failed: false };
                emitStep(emit, "Resolve and validate customer registration operation contract", "completed", operationStartedAt, new Date().toISOString(), operationStepId);
              } catch (error) {
                const message = (error as Error).message;
                emitStep(emit, `Resolve customer registration operation contract · failed: ${message}`, "failed", operationStartedAt, new Date().toISOString(), operationStepId);
                databaseSubtaskFailed = true;
                generated = { edits: [], errors: [`customer.register operation contract failed: ${message}`], failed: true };
              }
            } else if (subtask.id === "audit-history-api" && architecture.reviewScope) {
              const operationStartedAt = new Date().toISOString();
              const operationStepId = emitStep(emit, "Resolve PAC 1.1 customer dashboard and review-scope read contracts", "in_progress", operationStartedAt);
              try {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const models = sourceFiles.get("backend/models.py")?.content;
                const schemas = sourceFiles.get("backend/schemas.py")?.content;
                const routeSource = sourceFiles.get("backend/routes/customers.py")?.content;
                if (!models || !schemas || !routeSource) throw new Error("validated checkpoint is missing models, schemas, or customer route source");
                let nextSchemas = appendAuditEventResponseSchema(schemas, models);
                nextSchemas = appendCustomerPageResponseSchema(nextSchemas);
                const contracts = createCustomerReadOperationContracts(architecture, models, nextSchemas, subtask.targetPaths[0]);
                const operationValues = Object.values(contracts);
                for (const operation of operationValues) {
                  const operationId = operation.operationId;
                  const content = JSON.stringify(operation);
                  const record = { operationId, architectureHash: architecture.contractHash, content, sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString() };
                  businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), record];
                }
                const nextRoute = appendEntityHistoryReadOperation(
                  appendEntityRecordReadOperation(
                    appendEntityCollectionReadOperation(routeSource, contracts.customerList),
                    contracts.customerDetail,
                  ),
                  contracts.auditHistory,
                );
                generated = { edits: [
                  { path: subtask.targetPaths[0], action: "modify", content: nextRoute },
                  { path: subtask.targetPaths[1], action: "modify", content: nextSchemas },
                ], errors: [], failed: false };
                const checkpointAt = new Date().toISOString();
                const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations, updatedAt: checkpointAt };
                latestCheckpoint = checkpoint;
                emit({ type: "generation_checkpoint", checkpoint });
                emit({ type: "output", delta: "\nMobiusX rendered checksummed customer.listOwn, customer.getOwn, manager.listReviewQueue, manager.getReviewable, and customer.audit.read v2 contracts. Reads are filtered in SQL by authenticated ownership or the manager's persisted scope." });
                emitStep(emit, "Resolve PAC 1.1 customer dashboard and review-scope read contracts", "completed", operationStartedAt, new Date().toISOString(), operationStepId);
              } catch (error) {
                const message = (error as Error).message;
                emitStep(emit, `Resolve PAC 1.1 read contracts · failed: ${message}`, "failed", operationStartedAt, new Date().toISOString(), operationStepId);
                databaseSubtaskFailed = true;
                generated = { edits: [], errors: [`PAC 1.1 read operation contracts failed: ${message}`], failed: true };
              }
            } else if (subtask.id === "audit-history-api") {
              const operationStartedAt = new Date().toISOString();
              const operationStepId = emitStep(emit, "Resolve and validate customer.audit.read operation contract", "in_progress", operationStartedAt);
              try {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const models = sourceFiles.get("backend/models.py")?.content;
                const schemas = sourceFiles.get("backend/schemas.py")?.content;
                const restoredRoutes = restoreValidatedBackendSubtaskArtifacts(accumulated, backendSubtasks).edits;
                const routeSource = restoredRoutes.find((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === "backend/routes/customers.py")?.content ?? sourceFiles.get("backend/routes/customers.py")?.content;
                if (!models || !schemas || !routeSource) throw new Error("validated checkpoint is missing models, schemas, or customer route source");
                let nextSchemas = appendAuditEventResponseSchema(schemas, models);
                const contracts = createCustomerReadOperationContracts(architecture, models, nextSchemas, subtask.targetPaths[0]);
                const operationValues = Object.values(contracts);
                for (const operation of operationValues) {
                  const operationId = operation.operationId;
                  const saved = businessOperations.find((item) => item.operationId === operationId);
                  if (saved && (saved.architectureHash !== architecture.contractHash || createHash("sha256").update(saved.content).digest("hex") !== saved.sha256)) throw new Error(`saved ${operationId} contract has a PAC mismatch or checksum error`);
                  if (operationId === "customer.audit.read") {
                    const reconciled = reconcileEntityHistoryReadOperation(saved ? JSON.parse(saved.content) as unknown : undefined, operation as EntityHistoryReadOperationSpec, architecture);
                    if (reconciled.replacedLegacyScope) emit({ type: "output", delta: "\nReplaced the stale scope-dependent audit operation with the approved global-manager contract; the PAC hash and schema remain unchanged." });
                  }
                  const content = JSON.stringify(operation);
                  const record = { operationId, architectureHash: architecture.contractHash, content, sha256: createHash("sha256").update(content).digest("hex"), createdAt: new Date().toISOString() };
                  businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), record];
                }
                nextSchemas = appendCustomerPageResponseSchema(nextSchemas);
                const nextRoute = appendEntityHistoryReadOperation(
                  appendEntityRecordReadOperation(
                    appendEntityCollectionReadOperation(routeSource, contracts.customerList),
                    contracts.customerDetail,
                  ),
                  contracts.auditHistory,
                );
                generated = { edits: [
                  { path: subtask.targetPaths[0], action: "modify", content: nextRoute },
                  { path: subtask.targetPaths[1], action: "modify", content: nextSchemas },
                ], errors: [], failed: false };
                const checkpointAt = new Date().toISOString();
                latestCheckpoint = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations, updatedAt: checkpointAt };
                emit({ type: "generation_checkpoint", checkpoint: latestCheckpoint });
                emit({ type: "output", delta: "\nMobiusX rendered checksummed customer-owned dashboard/detail reads and manager-global queue, detail, and audit reads from the unchanged PAC. Managers see submitted pending applications and all histories; customer queries remain owner-filtered." });
                emitStep(emit, "Resolve and validate customer.audit.read operation contract", "completed", operationStartedAt, new Date().toISOString(), operationStepId);
              } catch (error) {
                const message = (error as Error).message;
                emitStep(emit, `Resolve customer.audit.read operation contract · failed: ${message}`, "failed", operationStartedAt, new Date().toISOString(), operationStepId);
                databaseSubtaskFailed = true;
                generated = { edits: [], errors: [`customer.audit.read operation contract failed: ${message}`], failed: true };
              }
            } else if (subtask.id === "router-registration") {
              const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
              const existingMain = sourceFiles.get(subtask.targetPaths[0].toLowerCase());
              if (!existingMain) {
                generated = { edits: [], errors: [`approved application entry point is missing: ${subtask.targetPaths[0]}`], failed: true };
              } else {
                const registration = registerGeneratedFastApiRouters("backend", [], taskContext, architecture);
                const registeredMain = registration.edits.find((edit) => edit.path.replaceAll("\\", "/").toLowerCase() === subtask.targetPaths[0].toLowerCase());
                generated = { edits: [registeredMain ?? { path: subtask.targetPaths[0], action: "modify", content: existingMain.content }], errors: [], failed: false };
                emit({ type: "output", delta: "\nMobiusX used the validated FastAPI router-registration scaffold for the approved auth and customer routers." });
              }
            } else if (subtask.id === "auth-api") {
              const operationStartedAt = new Date().toISOString();
              const operationStepId = emitStep(emit, "Resolve and render PAC authentication login operation", "in_progress", operationStartedAt);
              try {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const authSource = sourceFiles.get("backend/auth.py")?.content;
                const modelSource = sourceFiles.get("backend/models.py")?.content;
                const schemaSource = sourceFiles.get("backend/schemas.py")?.content;
                if (!authSource || !modelSource || !schemaSource) throw new Error("validated authentication dependencies are missing from the checkpoint");
                const operationId = "auth.login";
                let operationRecord = businessOperations.find((item) => item.operationId === operationId);
                let operation: AuthenticationLoginOperationSpec;
                if (operationRecord) {
                  const migrated = upgradeAuthenticationLoginCheckpoint(operationRecord, architecture, modelSource, schemaSource, authSource, subtask.targetPaths[0]);
                  operationRecord = migrated.current;
                  operation = JSON.parse(operationRecord.content) as AuthenticationLoginOperationSpec;
                  if (migrated.upgraded) {
                    const createdAt = operationRecord.createdAt;
                    if (migrated.history) businessOperationHistory = [...businessOperationHistory, migrated.history];
                    businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), operationRecord];
                    const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations: [...businessOperations], businessOperationHistory: [...businessOperationHistory], updatedAt: createdAt };
                    latestCheckpoint = checkpoint;
                    emit({ type: "generation_checkpoint", checkpoint });
                  }
                } else {
                  operation = createAuthenticationLoginOperationSpec(architecture, modelSource, schemaSource, subtask.targetPaths[0], authSource);
                  const createdAt = new Date().toISOString();
                  const content = JSON.stringify(operation);
                  operationRecord = { operationId, architectureHash: architecture.contractHash, content, sha256: createHash("sha256").update(content).digest("hex"), createdAt };
                  businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), operationRecord];
                  const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations: [...businessOperations], updatedAt: createdAt };
                  latestCheckpoint = checkpoint;
                  emit({ type: "generation_checkpoint", checkpoint });
                }
                const operationIssues = validateAuthenticationLoginOperationSpec(operation, architecture, authSource, modelSource, schemaSource);
                if (operationIssues.length) throw new Error(`auth.login operation failed PAC validation: ${operationIssues.join("; ")}`);
                const action = targetFileOperations.find((target) => target.path.toLowerCase() === subtask.targetPaths[0].toLowerCase())?.action ?? "create";
                generated = { edits: [{ path: subtask.targetPaths[0], action, content: renderAuthenticationLoginOperation(operation) }], errors: [], failed: false };
                emit({ type: "output", delta: "\nMobiusX rendered the generic login route from a PAC-validated operation and the model-generated authenticator/token helpers; the route uses database identity and rejects invalid credentials with 401." });
                emitStep(emit, "Resolve and render PAC authentication login operation", "completed", operationStartedAt, new Date().toISOString(), operationStepId);
              } catch (error) {
                const message = (error as Error).message;
                emitStep(emit, `Resolve authentication operation · failed: ${message}`, "failed", operationStartedAt, new Date().toISOString(), operationStepId);
                databaseSubtaskFailed = true;
                generated = { edits: [], errors: [`authentication operation failed: ${message}`], failed: true };
              }
            } else if (["submission-api", "manager-decision-api"].includes(subtask.id)) {
              const operationStartedAt = new Date().toISOString();
              const operationLabel = subtask.id === "submission-api" ? "customer submission" : "manager approval and rejection";
              const operationStepId = emitStep(emit, `Generate and validate ${operationLabel} operation contracts`, "in_progress", operationStartedAt);
              let operationProposalEdits: ProposedEdit[] = [];
              try {
                const sourceFiles = filesWithEdits(taskContext, [...(latestCheckpoint?.artifacts ?? []), ...accumulated]);
                const models = sourceFiles.get("backend/models.py")?.content;
                const schemas = sourceFiles.get("backend/schemas.py")?.content;
                if (!models || !schemas) throw new Error("validated checkpoint is missing backend/models.py or backend/schemas.py");
                const managerDecisions = subtask.id === "manager-decision-api";
                const definitions = managerDecisions
                  ? [
                    { operationId: "manager.approve", role: "manager", permission: "manager.approve", routePath: "/customers/{customer_id}/approve", functionName: "approve_customer", toState: "approved", auditAction: "approved" },
                    { operationId: "manager.reject", role: "manager", permission: "manager.reject", routePath: "/customers/{customer_id}/reject", functionName: "reject_customer", toState: "rejected", auditAction: "rejected" },
                  ]
                  : [{ operationId: "customer.submit", role: "customer", permission: "customer.submit", routePath: "/customers/{customer_id}/submit", functionName: "submit_customer", toState: "pending", auditAction: "submitted" }];
                const catalog = extractBusinessDomainCatalog(architecture, models, schemas, ["customer", "manager"], ["customer.submit", "manager.approve", "manager.reject"]);
                let routeContent = sourceFiles.get(subtask.targetPaths[0].toLowerCase())?.content;
                if (!routeContent) throw new Error(`approved target file is unavailable: ${subtask.targetPaths[0]}`);
                for (const definition of definitions) {
                  const operationId = definition.operationId;
                  let operationRecord = businessOperations.find((item) => item.operationId === operationId);
                  let operation: BusinessOperationSpec;
                  if (operationRecord) {
                    if (operationRecord.architectureHash !== architecture.contractHash || createHash("sha256").update(operationRecord.content).digest("hex") !== operationRecord.sha256) throw new Error(`saved operation ${operationId} has a PAC mismatch or checksum error`);
                    operation = JSON.parse(operationRecord.content) as BusinessOperationSpec;
                  } else if (managerDecisions && operationId === "manager.reject" && businessOperations.some((item) => item.operationId === "manager.approve")) {
                    const approvalRecord = businessOperations.find((item) => item.operationId === "manager.approve")!;
                    if (approvalRecord.architectureHash !== architecture.contractHash || createHash("sha256").update(approvalRecord.content).digest("hex") !== approvalRecord.sha256) throw new Error("saved manager.approve operation has a PAC mismatch or checksum error");
                    const approval = JSON.parse(approvalRecord.content) as BusinessOperationSpec;
                    operation = deriveComplementaryDecisionOperation(approval, {
                      operationId: definition.operationId,
                      permission: definition.permission,
                      routePath: definition.routePath,
                      functionName: definition.functionName,
                      toState: definition.toState,
                      auditAction: definition.auditAction,
                    });
                    const issues = validateBusinessOperationSpec(operation, architecture, catalog);
                    if (issues.length) throw new Error(`derived manager.reject operation failed PAC validation: ${issues.join("; ")}`);
                    const createdAt = new Date().toISOString();
                    const content = JSON.stringify(operation);
                    operationRecord = { operationId, architectureHash: architecture.contractHash, content, sha256: createHash("sha256").update(content).digest("hex"), createdAt };
                    businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), operationRecord];
                  const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), businessOperations, businessOperationHistory, updatedAt: createdAt };
                    latestCheckpoint = checkpoint;
                    emit({ type: "generation_checkpoint", checkpoint });
                    emit({ type: "output", delta: "\nMobiusX resolved manager.reject from the PAC-validated manager.approve contract and validated the complementary terminal state, permission, route, and audit action." });
                  } else {
                    const operationTarget = `.mobiusx/operations/${operationId.replaceAll(".", "-")}.v1.json`;
                  const operationPrompt = businessOperationPrompt({
                    architecture,
                    operationId,
                    targetModule: subtask.targetPaths[0],
                    role: definition.role,
                    permission: definition.permission,
                    routePath: definition.routePath,
                    modelSource: models,
                    schemaSource: schemas,
                    functionName: definition.functionName,
                    fromState: "pending",
                    toState: definition.toState,
                    auditAction: definition.auditAction,
                    ...(managerDecisions ? { requiredAuditAction: "submitted", concurrency: "row-lock" as const } : {}),
                  });
                  const operationContext: ProjectContext = {
                    ...(taskContext.projectPath ? { projectPath: taskContext.projectPath } : {}),
                    indexedChunkCount: 0,
                    relevantFiles: ["backend/models.py", "backend/schemas.py"].map((path) => ({
                      relPath: path,
                      content: path === "backend/models.py" ? models : schemas,
                      snippet: path === "backend/models.py" ? models : schemas,
                    })),
                  };
                  const operationStageMeta = {
                    ...stageMeta,
                    subtask: { id: `business-operation-spec:${operationId}`, targetPaths: [operationTarget], acceptanceCriteria: ["Return one JSON operation specification", "Use only PAC-approved model entities and fields", "Declare an atomic SQLAlchemy async transaction", ...(managerDecisions ? ["Require a prior submitted audit event and a row lock"] : [])] },
                  };
                  const validateCandidate = (edits: ProposedEdit[], errors: string[]): { candidate?: BusinessOperationSpec; issues: string[] } => {
                    const edit = edits.find((item) => item.path.replaceAll("\\", "/") === operationTarget);
                    if (errors.length || !edit) return { issues: [...errors, ...(!edit ? ["model did not return the required operation JSON artifact"] : [])] };
                    try {
                      const candidate = JSON.parse(edit.content) as BusinessOperationSpec;
                      return { candidate, issues: validateBusinessOperationSpec(candidate, architecture, catalog) };
                    } catch (error) {
                      return { issues: [`operation artifact is not valid JSON: ${(error as Error).message}`] };
                    }
                  };
                  let operationResult = await runStage(selected, input, operationPrompt, operationContext, operationStageMeta, emit, deadlineAt);
                  operationProposalEdits = operationResult.edits;
                  let candidate = validateCandidate(operationResult.edits, operationResult.errors);
                  if (candidate.issues.length && !operationResult.errors.some((issue) => /response headers exceeded|provider timeout|stream idle timeout|end-to-end deadline|cancelled/i.test(issue)) && deadlineAt > Date.now() && !input.signal?.aborted) {
                    const priorContent = operationProposalEdits.find((edit) => edit.path.replaceAll("\\", "/") === operationTarget)?.content ?? "";
                    const repairPrompt = [
                      operationPrompt,
                      "Focused contract repair (one attempt only). Return the full corrected JSON operation artifact at the same exact path.",
                      "Validation diagnostics:",
                      ...candidate.issues.map((issue) => `- ${issue}`),
                      "The current artifact failed these checks. Copy the required shape and exact model identifiers from the contract; do not change architecture, entities, fields, status values, permissions, or transaction scope.",
                      priorContent ? `Current rejected artifact for correction:\n${priorContent}` : "No usable operation artifact was returned.",
                    ].join("\n");
                    const repairedOperation = await runStage(selected, input, repairPrompt, operationContext, operationStageMeta, emit, deadlineAt, true);
                    operationProposalEdits = repairedOperation.edits;
                    operationResult = repairedOperation;
                    candidate = validateCandidate(repairedOperation.edits, repairedOperation.errors);
                    if (priorContent && repairedOperation.edits.some((edit) => edit.path.replaceAll("\\", "/") === operationTarget && edit.content === priorContent)) throw new Error(`repeated no-progress operation repair: ${candidate.issues.join("; ")}`);
                  }
                  if (candidate.issues.length || !candidate.candidate) throw new Error(`operation specification failed validation: ${candidate.issues.join("; ")}`);
                    operation = candidate.candidate;
                    const createdAt = new Date().toISOString();
                    operationRecord = { operationId, architectureHash: architecture.contractHash, content: JSON.stringify(operation), sha256: createHash("sha256").update(JSON.stringify(operation)).digest("hex"), createdAt };
                    businessOperations = [...businessOperations.filter((item) => item.operationId !== operationId), operationRecord];
                    const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = {
                      ...(latestCheckpoint ?? normalizedInitialCheckpoint),
                      businessOperations,
                      updatedAt: createdAt,
                    };
                    latestCheckpoint = checkpoint;
                    emit({ type: "generation_checkpoint", checkpoint });
                  }
                  const operationIssues = validateBusinessOperationSpec(operation, architecture, catalog);
                  if (operationIssues.length) throw new Error(`saved operation ${operationId} failed validation: ${operationIssues.join("; ")}`);
                  routeContent = appendOperationRoute(routeContent, operation);
                }
                generated = { edits: [{ path: subtask.targetPaths[0], action: "modify", content: routeContent }], errors: [], failed: false };
                emitStep(emit, `Generate and validate ${operationLabel} operation contracts`, "completed", operationStartedAt, new Date().toISOString(), operationStepId);
              } catch (error) {
                const message = (error as Error).message;
                emitStep(emit, `Generate ${operationLabel} operation contracts · failed: ${message}`, "failed", operationStartedAt, new Date().toISOString(), operationStepId);
                databaseSubtaskFailed = true;
                generated = { edits: operationProposalEdits, errors: [`business-operation contract failed: ${message}`], failed: true };
              }
            } else {
              generated = await runStage(selected, input, taskPrompt, backendSubtaskContext(subtask, taskContext), { ...stageMeta, subtask: { ...subtask, targetFileOperations } }, emit, deadlineAt);
            }
            const scope = () => {
              const authRepair = repairKnownFastApiAuthIssues(generated.edits);
              const schemaRepair = repairPydanticResponseAttributes(authRepair.edits);
              const enumRepair = repairPythonEnumMemberReferences(schemaRepair.edits, filesWithEdits(taskContext, schemaRepair.edits));
              generated = { ...generated, edits: enumRepair.edits };
              if (authRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX applied verified FastAPI auth corrections in ${authRepair.changedPaths.join(", ")}: ${authRepair.repairs.join("; ")}.` });
              if (schemaRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX enabled Pydantic ORM response serialization in ${schemaRepair.changedPaths.join(", ")}.` });
              if (enumRepair.changedPaths.length) emit({ type: "output", delta: `\nMobiusX matched Enum member references to the validated workspace declarations in: ${enumRepair.changedPaths.join(", ")}.` });
              const unexpected = generated.edits.filter((edit) => !subtask.targetPaths.some((path) => path.toLowerCase() === edit.path.replaceAll("\\", "/").toLowerCase()));
              const allowed = generated.edits.filter((edit) => !unexpected.includes(edit));
              const issues = [...generated.errors, ...unexpected.map((edit) => `unapproved generated path ${edit.path}`), ...backendSubtaskIssues(subtask, allowed, architecture)];
              return { allowed, issues: [...new Set(issues)] };
            };
            let checked = scope();
            const validateSubtaskPython = async () => {
              const candidate = filesWithEdits(taskContext, checked.allowed);
              return [...await validatePythonSources(candidate), ...await validatePythonModuleSymbols(candidate)];
            };
            let pythonIssues = await validateSubtaskPython();
            const initialSyntaxRepair = promoteAwaitingPythonRoutes(checked.allowed, pythonIssues);
            if (initialSyntaxRepair.changedPaths.length) {
              generated = { ...generated, edits: initialSyntaxRepair.edits };
              checked = scope();
              pythonIssues = await validateSubtaskPython();
              emit({ type: "output", delta: `\nMobiusX corrected await-bearing FastAPI route declarations in: ${initialSyntaxRepair.changedPaths.join(", ")}.` });
            }
            const repairOutcomes: string[] = [];
            const providerTimedOut = (errors: string[]) => errors.some((issue) => /response headers exceeded|provider timeout|stream idle timeout|end-to-end deadline/i.test(issue));
            if (providerTimedOut(generated.errors)) repairOutcomes.push("provider timeout: stopped automatic retries to avoid duplicate long-running inference");
            for (let attempt = 1; checked.issues.length && !providerTimedOut(generated.errors) && attempt <= 2 && deadlineAt > Date.now() && !input.signal?.aborted; attempt += 1) {
              const priorIssues = [...checked.issues];
              const repairPrompt = [taskPrompt, `Focused repair ${attempt}/2. Return the complete target file using its required action from the target file operation contract.`, "Exact diagnostics:", ...priorIssues.map((issue) => `- ${issue}`), repairGuidance(priorIssues, backendSubtaskContext(subtask, taskContext)), "Preserve validated database contracts, names, and symbols. Use only the exact targets already present in the manifest; do not change the PAC."].filter(Boolean).join("\n");
              const repaired = await runStage(selected, input, repairPrompt, backendSubtaskContext(subtask, taskContext), { ...stageMeta, repair: true, subtask: { ...subtask, targetFileOperations } }, emit, deadlineAt, true);
              if (!repaired.edits.length) { repairOutcomes.push(`attempt ${attempt}: no usable in-scope repair edits`); break; }
              generated = repaired;
              const next = scope();
              if (next.issues.length >= priorIssues.length && priorIssues.every((issue) => next.issues.includes(issue))) { repairOutcomes.push(`attempt ${attempt}: rejected no-progress repair`); break; }
              checked = next;
              repairOutcomes.push(`attempt ${attempt}: ${checked.issues.length ? "diagnostics improved" : "passed"}`);
            }
            if (checked.issues.length) {
              databaseSubtaskFailed = true;
              result = { edits: [...subtaskEdits, ...generated.edits], errors: checked.issues };
              emitStep(emit, `Backend subtask ${subtask.id} · failed: ${checked.issues.join("; ")}`, "failed", subtaskStartedAt, new Date().toISOString());
              break;
            }
            const merged = combineBuildEdits(accumulated, checked.allowed, originalPaths);
            if (merged.actionIssues.length) { databaseSubtaskFailed = true; result = { edits: [...subtaskEdits, ...checked.allowed], errors: merged.actionIssues }; break; }
            const candidateFiles = filesWithEdits(taskContext, merged.edits);
            const finalPythonIssues = [...await validatePythonSources(candidateFiles), ...await validatePythonModuleSymbols(candidateFiles)];
            if (finalPythonIssues.length) { databaseSubtaskFailed = true; result = { edits: [...subtaskEdits, ...checked.allowed], errors: finalPythonIssues }; break; }
            subtaskEdits.push(...checked.allowed);
            accumulated = merged.edits;
            context = addEditsToContext(context, accumulated);
            taskContext = addEditsToContext(context, accumulated);
            const completedAt = new Date().toISOString();
            const snapshot = merged.edits.filter((edit) => subtask.targetPaths.some((path) => path.toLowerCase() === edit.path.toLowerCase())).map((artifact) => ({ ...artifact, sha256: createHash("sha256").update(artifact.content).digest("hex") }));
            backendSubtasks.push({ id: subtask.id, completedAt, architectureHash: architecture.contractHash, artifacts: snapshot });
            emitStep(emit, `Backend subtask ${subtask.id} · validated (${snapshot.length} artifact${snapshot.length === 1 ? "" : "s"})`, "completed", subtaskStartedAt, completedAt);
            const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), backendSubtasks: [...backendSubtasks], updatedAt: completedAt };
            latestCheckpoint = checkpoint;
            emit({ type: "generation_checkpoint", checkpoint });
          }
          if (!result!) result = { edits: subtaskEdits, errors: [] };
        } else if (stage.id === "frontend") {
          const approvedFiles = filesWithEdits(context, accumulated);
          const uiOperationSet = uiOperationsFromCheckpoint(latestCheckpoint ?? normalizedInitialCheckpoint, architecture, approvedFiles);
          // Fail closed before spending inference on UI intent when the
          // generated backend cannot support the requested customer and
          // manager views. A structurally plausible skeleton is not enough:
          // its operations must match real, authorized API routes.
          uiOperationSet.issues.push(...validateFrontendBackendContract(approvedFiles, input.prompt));
          const modelSource = approvedFiles.get("backend/models.py")?.content ?? "";
          const schemaSource = approvedFiles.get("backend/schemas.py")?.content ?? "";
          let uiContract: UiContract | undefined;
          let uiModelResponse: string | undefined;
          let uiContribution: UiContractContribution | undefined;
          let uiModelRequestId: string | undefined;
          const contractIssues = (candidate: unknown) => [
            ...uiOperationSet.issues,
            ...validateUiContract(candidate, architecture, uiOperationSet.operations, modelSource, schemaSource),
          ];
          const savedUiContract = [...uiContracts].reverse().find((record) => record.architectureHash === architecture.contractHash);
          if (savedUiContract) {
            if (savedUiContract.sha256 !== createHash("sha256").update(savedUiContract.content).digest("hex")) {
              emit({ type: "output", delta: "\nSaved UI contract checksum did not match; the contract will be regenerated from the current PAC and operation contracts." });
              uiContracts = uiContracts.filter((record) => record !== savedUiContract);
            } else {
              try {
                const savedContributionContent = savedUiContract.contribution;
                const savedContribution = savedContributionContent ? JSON.parse(savedContributionContent) as UiContractContribution : undefined;
                const parsedContract = JSON.parse(savedUiContract.content) as UiContract;
                if (savedContribution && savedUiContract.modelResponse && savedUiContract.modelRequestId && savedContributionContent && savedUiContract.contributionSha256 === createHash("sha256").update(savedContributionContent).digest("hex")) {
                  const customerDashboard = parsedContract.routes.find((screen) => screen.roles.includes("customer") && screen.dataOperation?.startsWith("customer."));
                  const contributionIssues = customerDashboard ? validateUiContractContribution(savedContribution, parsedContract, customerDashboard.id, architecture, modelSource, schemaSource) : ["saved UI contract has no customer dashboard target"];
                  if (!contributionIssues.length && !contractIssues(parsedContract).length) {
                    uiContract = parsedContract;
                    uiContribution = savedContribution;
                    uiModelResponse = savedUiContract.modelResponse;
                    uiModelRequestId = savedUiContract.modelRequestId;
                    emit({ type: "output", delta: `\nReused the validated selected-model UI contribution from checkpoint request ${uiModelRequestId}.` });
                  } else {
                    emit({ type: "output", delta: `\nSaved UI contribution failed validation: ${contributionIssues.concat(contractIssues(parsedContract)).join("; ")}. Regenerating only the UI intent.` });
                    uiContracts = uiContracts.filter((record) => record !== savedUiContract);
                  }
                } else {
                  emit({ type: "output", delta: "\nSaved UI record predates compact contribution metadata; regenerating only the UI intent." });
                  uiContracts = uiContracts.filter((record) => record !== savedUiContract);
                }
              } catch { uiContracts = uiContracts.filter((record) => record !== savedUiContract); }
            }
          }
          if (uiContract && contractIssues(uiContract).length) {
            emit({ type: "output", delta: `\nSaved UI contract is incompatible with the verified PAC/API contract: ${contractIssues(uiContract).join("; ")}. Regenerating only the UI contract.` });
            uiContract = undefined;
          }
          if (!uiContract && uiOperationSet.issues.length === 0) {
            try {
              const skeleton = createUiContractSkeleton(architecture, uiOperationSet.operations, modelSource, schemaSource);
              const target = skeleton.routes.find((screen) => screen.roles.includes("customer") && screen.dataOperation?.startsWith("customer."));
              if (!target?.table) throw new Error("deterministic UI skeleton has no customer-owned dashboard table");
              const domainStates = extractBusinessDomainCatalog(architecture, modelSource, schemaSource, ["customer", "manager"], []).entities[target.table.entity]?.states ?? [];
              const specPrompt = uiContributionPrompt(skeleton, target.id, domainStates);
              const modelResult = await runCompactUiContribution(selected, input, stageMeta, specPrompt, emit, deadlineAt);
              uiModelResponse = modelResult.rawResponse;
              uiModelRequestId = modelResult.requestId;
              const parsed = parseUiContributionResponse(modelResult.rawResponse);
              if (modelResult.error || !modelResult.requestId || parsed.error || !parsed.contribution) {
                result = { edits: [], failed: true, errors: [modelResult.error, !modelResult.requestId ? "selected model request did not emit a correlation identifier" : undefined, parsed.error].filter((item): item is string => Boolean(item)) };
              } else {
                uiContribution = parsed.contribution;
                const contributionIssues = validateUiContractContribution(uiContribution, skeleton, target.id, architecture, modelSource, schemaSource);
                if (contributionIssues.length) {
                  result = { edits: [], failed: true, errors: [`selected-model UI contribution failed PAC/API validation: ${contributionIssues.join("; ")}`] };
                } else {
                  const contributedContract = mergeUiContractContribution(skeleton, target.id, uiContribution);
                  const issues = contractIssues(contributedContract);
                  if (issues.length) {
                    result = { edits: [], failed: true, errors: [`model-influenced UI contract failed PAC/API validation: ${issues.join("; ")}`] };
                  } else {
                    uiContract = contributedContract;
                    const content = JSON.stringify(uiContract, null, 2) + "\n";
                    const contributionContent = JSON.stringify(uiContribution);
                    const createdAt = new Date().toISOString();
                    const saved = {
                      architectureHash: architecture.contractHash,
                      content,
                      sha256: createHash("sha256").update(content).digest("hex"),
                      modelId: input.modelId ?? "unknown",
                      modelRequestId: uiModelRequestId!,
                      modelResponse: uiModelResponse,
                      contribution: contributionContent,
                      contributionSha256: createHash("sha256").update(contributionContent).digest("hex"),
                      requestMetadata: {
                        requestId: uiModelRequestId!,
                        provider: modelResult.diagnostic?.provider ?? selected.name,
                        endpoint: modelResult.diagnostic?.endpoint ?? "unknown",
                        modelId: modelResult.diagnostic?.modelId ?? input.modelId ?? "unknown",
                        promptSha256: createHash("sha256").update(specPrompt).digest("hex"),
                        promptCharacters: specPrompt.length,
                        ...(modelResult.diagnostic?.serializedRequestSha256 ? { serializedRequestSha256: modelResult.diagnostic.serializedRequestSha256 } : {}),
                        ...(modelResult.diagnostic?.serializedRequestBytes !== undefined ? { serializedRequestBytes: modelResult.diagnostic.serializedRequestBytes } : {}),
                        ...(modelResult.diagnostic?.serializedRequestRedacted ? { serializedRequestRedacted: modelResult.diagnostic.serializedRequestRedacted } : {}),
                        ...(modelResult.diagnostic?.startedAt ? { startedAt: modelResult.diagnostic.startedAt } : {}),
                        ...(modelResult.diagnostic?.endedAt ? { endedAt: modelResult.diagnostic.endedAt } : {}),
                        ...(modelResult.diagnostic?.durationMs !== undefined ? { durationMs: modelResult.diagnostic.durationMs } : {}),
                        ...(modelResult.diagnostic?.timeToHeadersMs !== undefined ? { timeToHeadersMs: modelResult.diagnostic.timeToHeadersMs } : {}),
                        ...(modelResult.diagnostic?.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: modelResult.diagnostic.timeToFirstTokenMs } : {}),
                        ...(modelResult.diagnostic?.promptTokens !== undefined ? { promptTokens: modelResult.diagnostic.promptTokens } : {}),
                        ...(modelResult.diagnostic?.generatedTokens !== undefined ? { generatedTokens: modelResult.diagnostic.generatedTokens } : {}),
                        ...(modelResult.diagnostic?.cancelled !== undefined ? { cancelled: modelResult.diagnostic.cancelled } : {}),
                        ...(modelResult.diagnostic?.deadlineExceeded !== undefined ? { deadlineExceeded: modelResult.diagnostic.deadlineExceeded } : {}),
                        ...(uiModelResponse !== undefined ? { responseSha256: createHash("sha256").update(uiModelResponse).digest("hex"), responseCharacters: uiModelResponse.length } : {}),
                      },
                      createdAt,
                    };
                    uiContracts = [...uiContracts.filter((record) => record.architectureHash !== architecture.contractHash), saved];
                    const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), uiContracts: [...uiContracts], updatedAt: saved.createdAt };
                    latestCheckpoint = checkpoint;
                    emit({ type: "generation_checkpoint", checkpoint });
                    emit({ type: "output", delta: `\nSelected model ${saved.modelId} contributed validated title, column order, status labels, and empty-state copy for ${target.id}; request ${saved.modelRequestId}; contract checksum ${saved.sha256.slice(0, 12)}.` });
                  }
                }
              }
            } catch (error) {
              uiContractPreflightFailed = /UI skeleton|customer collection-read operation|customer dashboard target|frontend is not connected to its backend API|approved auth\.login request schema/i.test((error as Error).message);
              result = { edits: [], failed: true, errors: [`UI skeleton/contribution generation failed: ${(error as Error).message}`] };
            }
          } else if (!uiContract && uiOperationSet.issues.length) {
            uiContractPreflightFailed = true;
            result = { edits: [], failed: true, errors: [`UI contract generation requires complete verified API operations: ${uiOperationSet.issues.join("; ")}`] };
          }
          if (uiContract) {
            const rendered = renderReactUi(uiContract, uiOperationSet.operations);
            result = { edits: rendered, failed: false, errors: [] };
          }
        } else if (stage.id === "tests") {
          const operationRecords: TestOperationMetadata[] = businessOperations.map((item) => ({ operationId: item.operationId, sha256: item.sha256, content: item.content }));
          const roles = [...new Set(operationRecords.flatMap((record) => {
            try {
              const parsed = JSON.parse(record.content) as { actor?: Record<string, unknown>; principal?: Record<string, unknown> };
              return [parsed.actor?.role, parsed.actor?.customerRole, parsed.actor?.managerRole, parsed.actor?.privilegedRole, parsed.principal?.role].filter((value): value is string => typeof value === "string");
            } catch { return []; }
          }))];
          let specification: TestSpecification | undefined;
          const savedTest = [...testSpecifications].reverse().find((record) => record.architectureHash === architecture.contractHash && record.modelId === (input.modelId ?? "unknown"));
          if (savedTest && createHash("sha256").update(savedTest.content).digest("hex") === savedTest.sha256) {
            try {
              const parsed = JSON.parse(savedTest.content) as TestSpecification;
              const deterministic = deriveTestSpecification(architecture.contractHash, operationRecords, parsed.createdAt);
              const contributionText = savedTest.contribution;
              const contributionValid = Boolean(savedTest.modelRequestId && savedTest.modelResponse && contributionText
                && savedTest.contributionSha256 === createHash("sha256").update(contributionText).digest("hex")
                && savedTest.requestMetadata?.requestId === savedTest.modelRequestId
                && savedTest.requestMetadata.modelId === savedTest.modelId);
              const contribution = contributionValid ? JSON.parse(contributionText!) as unknown : undefined;
              const checked = validateTestContribution(contribution, deterministic, operationRecords, roles);
              const merged = checked.contribution ? mergeTestContribution(deterministic, checked.contribution) : undefined;
              if (validateTestSpecification(parsed, architecture.contractHash, operationRecords, roles).length === 0
                && merged && JSON.stringify(parsed.cases) === JSON.stringify(merged.cases)) specification = parsed;
            } catch { /* Invalid saved spec falls through to a fresh small contribution. */ }
          }
          if (!specification) {
            const deterministic = deriveTestSpecification(architecture.contractHash, operationRecords);
            const deterministicIssues = validateTestSpecification(deterministic, architecture.contractHash, operationRecords, roles);
            if (deterministicIssues.length) {
              result = { edits: [], failed: true, errors: [`test contract preflight failed: ${deterministicIssues.join("; ")}`] };
            } else {
              const contributionPrompt = testContributionPrompt(deterministic, operationRecords);
              let contributionPromptUsed = contributionPrompt;
              let promptBudget = estimateTestPromptBudget(contributionPromptUsed, selected.name === "ollama" ? ollamaContextTokens() : 32_768);
              emit({ type: "output", delta: `\nTest contribution prompt budget preflight: ${promptBudget.promptBytes} UTF-8 bytes, sha256 ${promptBudget.promptSha256}, ${promptBudget.estimatedPromptTokens} estimated prompt tokens + ${promptBudget.expectedOutputTokens} output + ${promptBudget.structuredOutputOverheadTokens} structured-output overhead + ${promptBudget.safetyMarginTokens} safety margin = ${promptBudget.estimatedTotalTokens}/${promptBudget.contextTokens} context tokens.` });
              if (!promptBudget.fits) {
                result = { edits: [], failed: true, errors: [`test contribution request exceeds selected model context budget (${promptBudget.estimatedTotalTokens} estimated tokens including system instructions, structured-output overhead, expected response, and safety margin; context ${promptBudget.contextTokens}; prompt ${promptBudget.promptBytes} bytes; sha256 ${promptBudget.promptSha256}). Reduce contract slices without dropping requirements or authorization constraints.`] };
              }
              let modelResult: Awaited<ReturnType<typeof runCompactUiContribution>> | undefined = promptBudget.fits
                ? await runCompactUiContribution(selected, input, stageMeta, contributionPrompt, emitForStage, deadlineAt)
                : undefined;
              const parseContribution = (raw: string) => {
                const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
                let parsed: unknown;
                let parseError: string | undefined;
                try { parsed = JSON.parse(text); } catch (error) { parseError = `model test contribution is not valid JSON: ${(error as Error).message}`; }
                return { text, parseError, checked: validateTestContribution(parsed, deterministic, operationRecords, roles) };
              };
              let contributionResult = parseContribution(modelResult?.rawResponse ?? "");
              const firstResponseIssues = [contributionResult.parseError, ...contributionResult.checked.issues].filter((issue): issue is string => Boolean(issue));
              if (modelResult && !modelResult.error && modelResult.requestId && firstResponseIssues.length) {
                emit({ type: "output", delta: `\nSelected model response was received (${Buffer.byteLength(modelResult.rawResponse, "utf8")} bytes; sha256 ${createHash("sha256").update(modelResult.rawResponse).digest("hex")}) but failed the test contribution contract: ${firstResponseIssues.join("; ")}. Requesting one focused schema correction from the same selected model.` });
                contributionPromptUsed = [
                  contributionPrompt,
                  "The previous response was rejected by the test contribution validator.",
                  ...firstResponseIssues.map((issue) => `Validation diagnostic: ${issue}`),
                  "Return exactly one corrected case. The action must be a concrete 30–240 character test action with an observable assertion. Return JSON only; do not explain.",
                ].join("\n");
                promptBudget = estimateTestPromptBudget(contributionPromptUsed, selected.name === "ollama" ? ollamaContextTokens() : 32_768);
                emit({ type: "output", delta: `\nFocused contribution correction budget: ${promptBudget.promptBytes} UTF-8 bytes, sha256 ${promptBudget.promptSha256}, ${promptBudget.estimatedTotalTokens}/${promptBudget.contextTokens} estimated tokens.` });
                if (promptBudget.fits) {
                  modelResult = await runCompactUiContribution(selected, input, stageMeta, contributionPromptUsed, emitForStage, deadlineAt);
                  contributionResult = parseContribution(modelResult.rawResponse);
                } else {
                  modelResult = { rawResponse: "", error: `focused contribution correction exceeds the model context budget (${promptBudget.estimatedTotalTokens}/${promptBudget.contextTokens} tokens)` };
                }
              }
              if (modelResult) {
              const { parseError, checked } = contributionResult;
              if (modelResult.error || !modelResult.requestId || parseError || checked.issues.length || !checked.contribution) {
                result = { edits: [], failed: true, errors: [modelResult.error, !modelResult.requestId ? "selected model test contribution has no request ID" : undefined, parseError, ...checked.issues].filter((issue): issue is string => Boolean(issue)) };
              } else {
                specification = mergeTestContribution(deterministic, checked.contribution);
                const content = JSON.stringify(specification, null, 2) + "\n";
                const contribution = JSON.stringify(checked.contribution);
                const createdAt = new Date().toISOString();
                const saved = {
                  architectureHash: architecture.contractHash,
                  content,
                  sha256: createHash("sha256").update(content).digest("hex"),
                  modelId: input.modelId ?? "unknown",
                  createdAt,
                  modelRequestId: modelResult.requestId,
                  modelResponse: modelResult.rawResponse,
                  contribution,
                  contributionSha256: createHash("sha256").update(contribution).digest("hex"),
                  requestMetadata: {
                    requestId: modelResult.requestId,
                    provider: modelResult.diagnostic?.provider ?? selected.name,
                    endpoint: modelResult.diagnostic?.endpoint ?? "unknown",
                    modelId: modelResult.diagnostic?.modelId ?? input.modelId ?? "unknown",
                    promptSha256: createHash("sha256").update(contributionPromptUsed).digest("hex"),
                    promptCharacters: contributionPromptUsed.length,
                    promptBytes: promptBudget.promptBytes,
                    estimatedPromptTokens: promptBudget.estimatedPromptTokens,
                    expectedOutputTokens: promptBudget.expectedOutputTokens,
                    structuredOutputOverheadTokens: promptBudget.structuredOutputOverheadTokens,
                    safetyMarginTokens: promptBudget.safetyMarginTokens,
                    contextTokens: promptBudget.contextTokens,
                    estimatedTotalTokens: promptBudget.estimatedTotalTokens,
                    ...(modelResult.diagnostic?.serializedRequestSha256 ? { serializedRequestSha256: modelResult.diagnostic.serializedRequestSha256 } : {}),
                    ...(modelResult.diagnostic?.serializedRequestBytes !== undefined ? { serializedRequestBytes: modelResult.diagnostic.serializedRequestBytes } : {}),
                    ...(modelResult.diagnostic?.startedAt ? { startedAt: modelResult.diagnostic.startedAt } : {}),
                    ...(modelResult.diagnostic?.endedAt ? { endedAt: modelResult.diagnostic.endedAt } : {}),
                    ...(modelResult.diagnostic?.durationMs !== undefined ? { durationMs: modelResult.diagnostic.durationMs } : {}),
                    ...(modelResult.diagnostic?.timeToHeadersMs !== undefined ? { timeToHeadersMs: modelResult.diagnostic.timeToHeadersMs } : {}),
                    ...(modelResult.diagnostic?.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: modelResult.diagnostic.timeToFirstTokenMs } : {}),
                    ...(modelResult.diagnostic?.promptTokens !== undefined ? { promptTokens: modelResult.diagnostic.promptTokens } : {}),
                    ...(modelResult.diagnostic?.generatedTokens !== undefined ? { generatedTokens: modelResult.diagnostic.generatedTokens } : {}),
                    ...(modelResult.diagnostic?.cancelled !== undefined ? { cancelled: modelResult.diagnostic.cancelled } : {}),
                    ...(modelResult.diagnostic?.deadlineExceeded !== undefined ? { deadlineExceeded: modelResult.diagnostic.deadlineExceeded } : {}),
                    responseSha256: createHash("sha256").update(modelResult.rawResponse).digest("hex"),
                    responseCharacters: modelResult.rawResponse.length,
                  },
                };
                testSpecifications = [...testSpecifications.filter((record) => record.architectureHash !== architecture.contractHash), saved];
                const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = { ...(latestCheckpoint ?? normalizedInitialCheckpoint), testSpecifications: [...testSpecifications], updatedAt: createdAt };
                latestCheckpoint = checkpoint;
                emit({ type: "generation_checkpoint", checkpoint });
                emit({ type: "output", delta: `\nSelected model ${saved.modelId} contributed one validated test case (${checked.contribution.cases[0].id}); request ${saved.modelRequestId}. Contract-derived cases retain deterministic provenance.` });
              }
              }
            }
          }
          if (specification) {
            const uiContent = [...uiContracts].reverse().find((record) => record.architectureHash === architecture.contractHash)?.content;
            const topologyFiles = (context.relevantFiles ?? []).filter((file) => typeof file.content === "string").map((file) => ({ path: file.relPath, content: file.content! }));
            const topology = discoverTestApplicationTopology(topologyFiles);
            const operationsPrompt = testImplementationPrompt(input.prompt, specification, operationRecords, uiContent, testTopologyPromptSummary(topology));
            const compactContext: ProjectContext = { ...context, relevantFiles: (context.relevantFiles ?? []).filter((file) => /^(?:frontend|client|web)\/(?:package\.json|playwright\.config\.[cm]?[jt]s|ui-contract\.v1\.json)$|^backend\/requirements\.txt$|^(?:pytest|playwright)\.config\./i.test(file.relPath.replaceAll("\\", "/"))) };
            testStagePrompt = operationsPrompt;
            stageContextForRepair = compactContext;
            testStageContext = compactContext;
            result = await runStage(selected, input, operationsPrompt, compactContext, stageMeta, emitForStage, deadlineAt);
            const renderedContracts = renderTestContractArtifacts(specification, operationRecords, topology);
            const rendererPaths = new Set(renderedContracts.map((edit) => edit.path.toLowerCase()));
            result.edits = [...result.edits.filter((edit) => !rendererPaths.has(edit.path.toLowerCase())), ...renderedContracts];
            result.edits = reuseValidatedTestSliceArtifacts(result.edits, testSubtasks, architecture.contractHash);
            emit({ type: "output", delta: `\nMobiusX rendered the deterministic operation/OpenAPI test contract: ${renderedContracts.map((edit) => edit.path).join(", " )}.` });
          }
        } else {
          result = await runStage(selected, input, basePrompt, context, stageMeta, emit, deadlineAt);
        }
        // Check raw model file operations before deterministic renderers
        // consolidate authorized same-stage infrastructure updates.
        const modelProposalPathIssues = validateStageArtifactOwnership(stage.id, [], result.edits);
        const architectureScaffold = ensureArchitectureScaffold(stage.id, input.prompt, architecture, result.edits, context);
        if (architectureScaffold !== result.edits) {
          const changedPaths = architectureScaffold.filter((candidate) => {
            const before = result.edits.find((edit) => edit.path.toLowerCase() === candidate.path.toLowerCase());
            return !before || before.content !== candidate.content || before.action !== candidate.action;
          }).map((edit) => edit.path);
          result.edits = architectureScaffold;
          if (changedPaths.length) emit({ type: "output", delta: `\nMobiusX applied reusable ${architecture.stack.backend}/${architecture.stack.orm} infrastructure scaffolding: ${changedPaths.join(", ")}.` });
        }
        const editsBeforeInfrastructureCheck = result.edits.length;
        result.edits = ensurePostgresServiceScaffold(stage.id, input.prompt, result.edits, context);
        if (result.edits.length > editsBeforeInfrastructureCheck) {
          emit({ type: "output", delta: "\nMobiusX added the generic loopback-only PostgreSQL service scaffold required by the selected stack." });
        }
        const deploymentScaffold = ensureWebDeploymentScaffold(stage.id, input.prompt, result.edits, context, architecture.stack.migrations);
        if (deploymentScaffold.changed.length) {
          result.edits = [...result.edits, ...deploymentScaffold.edits];
          emit({ type: "output", delta: `\nMobiusX supplied reusable web-stack deployment artifacts: ${deploymentScaffold.changed.join(", ")}.` });
        }
        if (input.signal?.aborted) {
          emitStep(emit, `${stage.label} · cancelled`, "failed", startedAt, new Date().toISOString(), stageStepId);
          emit({ type: "status", status: "cancelled" });
          emit({ type: "done" });
          return;
        }
        let merged = combineBuildEdits(accumulated, result.edits, originalPaths);
        const lockedBackendModules = restoreValidatedBackendSubtaskArtifacts(merged.edits, backendSubtasks);
        if (lockedBackendModules.restoredPaths.length) {
          merged = { ...merged, edits: lockedBackendModules.edits };
          emit({ type: "output", delta: `\nMobiusX preserved previously validated backend modules: ${lockedBackendModules.restoredPaths.join(", ")}.` });
        }
        const portSafetyRepair = bindComposePortsToLoopback(merged.edits);
        if (portSafetyRepair.mappings.length > 0) {
          merged = { ...merged, edits: portSafetyRepair.edits };
          emit({ type: "output", delta: `\nMobiusX bound development ports to loopback automatically: ${portSafetyRepair.mappings.join(", ")}.` });
        }
        const composeSecretRepair = normalizeComposeCredentialDefaults(merged.edits);
        if (composeSecretRepair.changed.length > 0) {
          merged = { ...merged, edits: composeSecretRepair.edits };
          emit({ type: "output", delta: `\nMobiusX replaced literal Compose credentials with required environment references in: ${composeSecretRepair.changed.join(", ")}.` });
        }
        const routerWiring = registerGeneratedFastApiRouters(stage.id, merged.edits, context, architecture);
        if (routerWiring.changed) {
          merged = { ...merged, edits: routerWiring.edits };
          emit({ type: "output", delta: routerWiring.registered.length > 0
            ? `\nMobiusX registered generated FastAPI routers in backend/main.py: ${routerWiring.registered.join(", ")}.`
            : "\nMobiusX applied the PAC-configured browser CORS middleware to the FastAPI entry point." });
        }
        let testHarnessErrors: string[] = [];
        if (stage.testFramework === "playwright") {
          const harness = ensurePlaywrightHarness(merged.edits);
          testHarnessErrors = harness.errors;
          if (harness.edits.length) {
            merged = combineBuildEdits(accumulated, [...result.edits, ...harness.edits], originalPaths);
            emit({ type: "output", delta: `\nMobiusX staged the validated Playwright harness: ${harness.changedPaths.join(", ")}.` });
          }
        }
        // A failed ordered database subtask is authoritative. Deterministic
        // repairs below may rebuild the general stage diagnostics, but must
        // never erase the subtask's contract failure and let the stage pass.
        const authoritativeSubtaskErrors = databaseSubtaskFailed ? [...result.errors] : [];
        let candidateFiles = filesWithEdits(context, merged.edits);
        let issues = [
          ...authoritativeSubtaskErrors,
          ...(!databaseSubtaskFailed ? result.errors : []),
          ...testHarnessErrors,
          ...merged.actionIssues,
          ...modelProposalPathIssues,
          ...(!databaseSubtaskFailed ? await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture) : []),
        ];
        if (stage.id === "tests" && stage.testFramework === "playwright") {
          const topologyFiles = [...candidateFiles.entries()].map(([path, value]) => ({ path, content: value.content }));
          const topology = discoverTestApplicationTopology(topologyFiles);
          const topologyIssues = validateGeneratedTestsAgainstTopology(topologyFiles, topology);
          if (topologyIssues.length) emit({ type: "output", delta: `\nTest artifacts do not match the discovered application topology: ${topologyIssues.join("; ")}` });
          issues.push(...topologyIssues);
        }
        const initialSyntaxRepair = promoteAwaitingPythonRoutes(merged.edits, issues);
        if (initialSyntaxRepair.changedPaths.length) {
          merged = { ...merged, edits: initialSyntaxRepair.edits };
          candidateFiles = filesWithEdits(context, merged.edits);
          issues = [...authoritativeSubtaskErrors, ...(!databaseSubtaskFailed ? result.errors : []), ...merged.actionIssues, ...(!databaseSubtaskFailed ? await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture) : [])];
          emit({ type: "output", delta: `\nMobiusX corrected await-bearing FastAPI route declarations in: ${initialSyntaxRepair.changedPaths.join(", ")}.` });
        }
        const initialKnownImportRepair = repairKnownPythonNameErrors(merged.edits, issues);
        if (initialKnownImportRepair.changedPaths.length) {
          merged = { ...merged, edits: initialKnownImportRepair.edits };
          candidateFiles = filesWithEdits(context, merged.edits);
          issues = [...authoritativeSubtaskErrors, ...(!databaseSubtaskFailed ? result.errors : []), ...merged.actionIssues, ...(!databaseSubtaskFailed ? await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture) : [])];
          emit({ type: "output", delta: `\nMobiusX added the verified FastAPI framework import in: ${initialKnownImportRepair.changedPaths.join(", ")}.` });
        }
        const initialRelativeImportRepair = repairResolvablePythonRelativeImports(merged.edits, context);
        if (initialRelativeImportRepair.changedPaths.length) {
          merged = { ...merged, edits: initialRelativeImportRepair.edits };
          candidateFiles = filesWithEdits(context, merged.edits);
          issues = [...authoritativeSubtaskErrors, ...(!databaseSubtaskFailed ? merged.actionIssues : []), ...(!databaseSubtaskFailed ? await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture) : [])];
          emit({ type: "output", delta: `\nMobiusX corrected unambiguous Python package-relative imports in: ${initialRelativeImportRepair.changedPaths.join(", ")}.` });
        }
        const initialKnownFrontendRepair = repairKnownFrontendToolingIssues(merged.edits, issues);
        if (initialKnownFrontendRepair.changedPaths.length) {
          merged = { ...merged, edits: combineBuildEdits(accumulated, initialKnownFrontendRepair.edits, originalPaths).edits };
          candidateFiles = filesWithEdits(context, merged.edits);
          issues = [...authoritativeSubtaskErrors, ...(!databaseSubtaskFailed ? merged.actionIssues : []), ...(!databaseSubtaskFailed ? await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture) : [])];
          emit({ type: "output", delta: `\nMobiusX repaired verifiable frontend tooling issues from the isolated compiler diagnostics: ${initialKnownFrontendRepair.changedPaths.join(", ")}.` });
        }
        let priorRepairEdits: ProposedEdit[] = [];
        const repairOutcomes: string[] = [];
        const repairFingerprints: Array<{ fingerprint: string; diagnosticHash: string; targetPath: string; relevantCodeHash: string; proposedPatchHash: string; outcome: "applied" | "duplicate" | "no-progress" }> = [];

        if (issues.length > 0 && !input.signal?.aborted) {
          if (databaseSubtaskFailed) {
            repairOutcomes.push("database subtask failed its bounded repair gate; no stage-wide retry was issued");
          } else {
          emit({ type: "output", delta: `\n\n${stage.label} did not pass validation: ${[...new Set(issues)].join("; ")}. Starting a bounded repair for ${selected.name}/${input.modelId ?? "selected model"}.` });
          // Repairs are bounded across task resumes, not just within one HTTP
          // request. Keep a monotonically increasing attempt number across
          // persisted failed-stage records so repeated resumes cannot reset
          // the budget. A repair can expose a distinct later import failure,
          // so seven targeted calls is the hard cap for one stage lineage. The
          // final bounded allowance covers distinct import failures exposed
          // only after a preceding import is corrected.
          const maxRepairAttempts = 7;
          const priorAttemptNumbers = (latestCheckpoint?.attemptedStages ?? [])
            .filter((attempt) => attempt.id === stage.id)
            .flatMap((attempt) => attempt.repairOutcomes)
            .map((outcome) => Number(outcome.match(/^attempt (\d+):/)?.[1] ?? 0));
          const usedRepairAttempts = Math.max(0, ...priorAttemptNumbers);
          const priorRepairOutcomes = (latestCheckpoint?.attemptedStages ?? []).filter((attempt) => attempt.id === stage.id).flatMap((attempt) => attempt.repairOutcomes);
          const focusedFallbackUsed = priorRepairOutcomes.some((outcome) => outcome.includes("strategy: focused-function fallback"));
          const compactFallbackUsed = priorRepairOutcomes.some((outcome) => outcome.includes("strategy: compact-contract fallback"));
          // The legacy seven-call budget is never reopened. If it is exhausted,
          // allow one separately labelled function-regeneration strategy to
          // recover cases where earlier retries were repetitive or ineffective.
          const hasFocusedFallback = usedRepairAttempts >= maxRepairAttempts && !focusedFallbackUsed;
          const hasCompactFallback = usedRepairAttempts >= maxRepairAttempts + 1 && focusedFallbackUsed && !compactFallbackUsed;
          const priorProviderTimeout = priorRepairOutcomes.some((outcome) => /provider timeout: stopped automatic retries/i.test(outcome));
          const initialProviderTimeout = result.errors.some((error) => /Ollama response headers exceeded|local model request exceeded its deadline|provider timeout/i.test(error));
          const unrecoveredProviderTimeout = priorProviderTimeout && !providerRespondedInStage;
          const runtimeValidationUnavailable = issues.some((issue) => /isolated FastAPI dependency\/import validation failed.*(?:timed out|timeout|network|pull)/is.test(issue));
          const remainingRepairAttempts = unrecoveredProviderTimeout || initialProviderTimeout || databaseSubtaskFailed || uiContractPreflightFailed || runtimeValidationUnavailable ? 0 : Math.max(0, maxRepairAttempts - usedRepairAttempts) + (hasFocusedFallback ? 1 : 0) + (hasCompactFallback ? 1 : 0);
          if (uiContractPreflightFailed) repairOutcomes.push("UI generation preflight failed because the approved backend read contract is missing; skipped model repair rather than inventing an endpoint");
          if (runtimeValidationUnavailable) repairOutcomes.push("runtime validation unavailable; skipped model repair because a container dependency-install timeout is not a source-code diagnostic");
          if (initialProviderTimeout) repairOutcomes.push("provider timeout: stopped automatic retries after the initial stage returned no response headers; resume only after the local inference issue is addressed");
          if (unrecoveredProviderTimeout) issues = [...new Set([...issues, "The selected local provider previously timed out and has not returned a successful response in this resumed stage; automatic retries are paused until provider readiness is demonstrated."])];
          const repairAttemptStart = usedRepairAttempts;
          const seenRepairFingerprints = new Set((latestCheckpoint?.attemptedStages ?? [])
            .filter((attempt) => attempt.id === stage.id)
            .flatMap((attempt) => attempt.repairFingerprints ?? [])
            .map((entry) => entry.fingerprint));
          let switchToFocusedFunction = false;
          let focusedFallbackAttempted = false;
          for (let repairAttempt = 1; repairAttempt <= remainingRepairAttempts && issues.length > 0 && !input.signal?.aborted; repairAttempt += 1) {
            const globalRepairAttempt = repairAttemptStart + repairAttempt;
            const isFocusedFallback = globalRepairAttempt > maxRepairAttempts;
            const isCompactFallback = globalRepairAttempt > maxRepairAttempts + 1;
            if (isFocusedFallback) switchToFocusedFunction = true;
            if (isCompactFallback) switchToFocusedFunction = true;
            const isNoProgressFallback = switchToFocusedFunction && !focusedFallbackAttempted;
            if (isNoProgressFallback) focusedFallbackAttempted = true;
            let stopAfterNoProgressFallback = false;
            repairOutcomes.push(`attempt ${globalRepairAttempt}: ${isCompactFallback ? "strategy: compact-contract fallback started" : isFocusedFallback ? "strategy: focused-function fallback started" : "started"}`);
            const repairStartedAt = new Date().toISOString();
            const repairStrategyLabel = isCompactFallback ? "single compact-contract fallback" : isFocusedFallback ? "single focused-function fallback" : `focused repair (${globalRepairAttempt}/${maxRepairAttempts})`;
            const repairStepId = emitStep(emit, `${stage.label} · ${repairStrategyLabel}`, "in_progress", repairStartedAt);
            let failureContext: ProjectContext;
            if (stage.id === "tests" && testStageContext) {
              failureContext = testStageRepairContext(testStageContext, context, merged.edits);
            } else {
              failureContext = focusRepairContext(stageContextForRepair, merged.edits, issues);
            }
            const diagnosticText = [...new Set(issues)].map((issue) => `- ${issue}`).join("\n");
            const focusedGuidance = repairGuidance(issues, failureContext);
            const allowedRepairPaths = repairAllowedPathsForStage(stage.id, issues, failureContext, [...merged.edits, ...accumulated]);
            const repairTaskSpec = architectureTaskSpecification(
              architecture,
              stage.id,
              accumulated.map(({ path, content }) => ({ path, content })),
            );
            const missingApprovedPaths = missingApprovedStagePaths(
              repairTaskSpec.exactTargetPaths as string[],
              failureContext,
            );
            for (const path of missingApprovedPaths) allowedRepairPaths.add(path.toLowerCase());
            const allowedScopeText = allowedRepairPaths.size > 0
              ? `\nAllowed edit paths (strict allowlist): ${[...allowedRepairPaths].join(", ")}. Do not return edits for any other path; out-of-scope edits will be discarded.${missingApprovedPaths.length > 0 ? ` Create only these missing PAC-approved stage targets: ${missingApprovedPaths.join(", ")}.` : ""}`
              : "\nOnly modify complete files implicated by these diagnostics; do not regenerate unrelated project components.";
            failureContext.failingVerification = [{ label: stage.label, command: "MobiusX generated-stage contract validation", output: diagnosticText }];
            const retryDirection = isCompactFallback
              ? `Use a compact contract response. Implement only the missing business state transition and audit write in the smallest exact route file identified by the diagnostics. Return the complete changed file as a structured edit now; no status summary, no explanation, and no unchanged files. Diagnostics:\n${diagnosticText}${focusedGuidance ? `\nRequired behavior:\n${focusedGuidance}` : ""}`
              : !switchToFocusedFunction
              ? `Return only the minimal complete files needed to fix these diagnostics. Make a meaningful change; do not repeat unchanged files.${focusedGuidance ? `\nRequired correction:\n${focusedGuidance}` : ""}`
              : `Switch strategy: regenerate only the smallest affected function or route handler in the exact failing file. Preserve all unrelated code and do not repeat any prior patch. Exact diagnostics:\n${diagnosticText}${focusedGuidance ? `\nRequired correction:\n${focusedGuidance}` : ""}`;
            const repair = await runStage(
              selected,
              input,
              `${stage.id === "tests" && testStagePrompt ? `Approved test-generation contract and inventory:\n${testStagePrompt}\n\n` : ""}Focused repair for the existing ${stage.label} output. Preserve the original application requirements and all files outside the diagnosed scope.\n\nFocused repair attempt ${globalRepairAttempt}/${maxRepairAttempts + 2}. Exact diagnostics:\n${diagnosticText}${allowedScopeText}\n${retryDirection}${focusedGuidance ? `\nRequired correction:\n${focusedGuidance}` : ""}\nUse the Build structured output contract exactly: one JSON object with a summary string and edits array. Each edit must contain a project-relative path, action, and complete file content. Return no prose-only answer.`,
              failureContext,
              stageMeta,
              emit,
              deadlineAt,
              true,
            );
            if (repair.failed && repair.edits.length === 0 && repair.errors.some((error) => /Ollama response headers exceeded|local model request exceeded its deadline|provider timeout/i.test(error))) {
              const timeoutOutcome = `attempt ${globalRepairAttempt}: provider timeout: stopped automatic retries after a no-response deadline`;
              repairOutcomes.push(timeoutOutcome);
              issues = [...new Set([...issues, ...repair.errors, "The selected provider returned no response before its inference deadline; no identical repair will be retried automatically."])];
              emitStep(emit, `${stage.label} · provider timeout; retry paused`, "failed", repairStartedAt, new Date().toISOString(), repairStepId);
              break;
            }
            const inScopeRepairEdits = repair.edits.filter((edit) => allowedRepairPaths.size === 0 || allowedRepairPaths.has(edit.path.replaceAll("\\", "/").toLowerCase()));
            const discardedRepairPaths = repair.edits.filter((edit) => !inScopeRepairEdits.includes(edit)).map((edit) => edit.path);
            if (discardedRepairPaths.length > 0) emit({ type: "output", delta: `\nFocused repair discarded edits outside the diagnostic scope: ${discardedRepairPaths.join(", ")}.` });
            const currentFiles = filesWithEdits(context, merged.edits);
            const fingerprintEntries = inScopeRepairEdits.map((edit) => repairFingerprint({
              diagnostics: issues,
              targetPath: edit.path,
              relevantCode: currentFiles.get(edit.path.replaceAll("\\", "/").toLowerCase())?.content ?? "",
              proposedPatch: edit.content,
            }));
            const duplicateIndexes = new Set(fingerprintEntries.flatMap((entry, index) => seenRepairFingerprints.has(entry.fingerprint) ? [index] : []));
            for (const index of duplicateIndexes) {
              repairFingerprints.push({ ...fingerprintEntries[index], outcome: "duplicate" });
              repairOutcomes.push(`attempt ${globalRepairAttempt}: rejected duplicate repair fingerprint for ${fingerprintEntries[index].targetPath}`);
              switchToFocusedFunction = true;
            }
            const uniqueRepairEdits = inScopeRepairEdits.filter((_edit, index) => !duplicateIndexes.has(index));
            if (uniqueRepairEdits.length > 0) {
              const issuesBeforeRepair = [...issues];
              merged = combineBuildEdits(accumulated, [...result.edits, ...priorRepairEdits, ...uniqueRepairEdits], originalPaths);
              const repairedPortBindings = bindComposePortsToLoopback(merged.edits);
              if (repairedPortBindings.mappings.length > 0) {
                merged = { ...merged, edits: repairedPortBindings.edits };
                emit({ type: "output", delta: `\nMobiusX bound development ports to loopback automatically: ${repairedPortBindings.mappings.join(", ")}.` });
              }
              const repairedComposeSecrets = normalizeComposeCredentialDefaults(merged.edits);
              if (repairedComposeSecrets.changed.length > 0) {
                merged = { ...merged, edits: repairedComposeSecrets.edits };
                emit({ type: "output", delta: `\nMobiusX replaced literal Compose credentials with required environment references in: ${repairedComposeSecrets.changed.join(", ")}.` });
              }
              const repairedRouterWiring = registerGeneratedFastApiRouters(stage.id, merged.edits, context, architecture);
              if (repairedRouterWiring.changed) {
                merged = { ...merged, edits: repairedRouterWiring.edits };
                emit({ type: "output", delta: repairedRouterWiring.registered.length > 0
                  ? `\nMobiusX registered generated FastAPI routers in backend/main.py: ${repairedRouterWiring.registered.join(", ")}.`
                  : "\nMobiusX restored PAC-configured browser CORS middleware after focused repair." });
              }
              const repairedDeploymentScaffold = ensureWebDeploymentScaffold(stage.id, input.prompt, merged.edits, context, architecture.stack.migrations);
              if (repairedDeploymentScaffold.changed.length) {
                merged = combineBuildEdits(accumulated, [...merged.edits, ...repairedDeploymentScaffold.edits], originalPaths);
                emit({ type: "output", delta: `\nMobiusX restored reusable web-stack deployment artifacts during repair: ${repairedDeploymentScaffold.changed.join(", ")}.` });
              }
              const syntaxRepairFiles = filesWithEdits(context, merged.edits);
              const syntaxRepair = promoteAwaitingPythonRoutes(merged.edits, [
                ...repair.errors,
                ...merged.actionIssues,
                ...validateBuildStage(stage.id, input.prompt, syntaxRepairFiles),
                ...await validatePythonSources(syntaxRepairFiles),
                ...validateTypeScriptSyntax(syntaxRepairFiles),
              ]);
              if (syntaxRepair.changedPaths.length) {
                merged = { ...merged, edits: syntaxRepair.edits };
                emit({ type: "output", delta: `\nMobiusX corrected await-bearing FastAPI route declarations in: ${syntaxRepair.changedPaths.join(", ")}.` });
              }
              const knownImportRepair = repairKnownPythonNameErrors(merged.edits, issues);
              if (knownImportRepair.changedPaths.length) {
                merged = { ...merged, edits: knownImportRepair.edits };
                emit({ type: "output", delta: `\nMobiusX added the verified FastAPI framework import in: ${knownImportRepair.changedPaths.join(", ")}.` });
              }
              const relativeImportRepair = repairResolvablePythonRelativeImports(merged.edits, context);
              if (relativeImportRepair.changedPaths.length) {
                merged = { ...merged, edits: relativeImportRepair.edits };
                emit({ type: "output", delta: `\nMobiusX corrected unambiguous Python package-relative imports in: ${relativeImportRepair.changedPaths.join(", ")}.` });
              }
              if (stage.testFramework === "playwright") {
                const harness = ensurePlaywrightHarness(merged.edits);
                testHarnessErrors = harness.errors;
                if (harness.edits.length) {
                  merged = combineBuildEdits(accumulated, [...result.edits, ...priorRepairEdits, ...uniqueRepairEdits, ...harness.edits], originalPaths);
                  emit({ type: "output", delta: `\nMobiusX restored the validated Playwright harness after the focused repair: ${harness.changedPaths.join(", ")}.` });
                }
              }
              const lockedRepairedBackend = restoreValidatedBackendSubtaskArtifacts(merged.edits, backendSubtasks);
              if (lockedRepairedBackend.restoredPaths.length) {
                merged = { ...merged, edits: lockedRepairedBackend.edits };
                emit({ type: "output", delta: `\nMobiusX restored validated backend modules after focused repair: ${lockedRepairedBackend.restoredPaths.join(", ")}.` });
              }
              candidateFiles = filesWithEdits(context, merged.edits);
              issues = [...testHarnessErrors, ...repair.errors, ...merged.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
              const knownFrontendRepair = repairKnownFrontendToolingIssues(merged.edits, issues);
              if (knownFrontendRepair.changedPaths.length) {
                merged = { ...merged, edits: combineBuildEdits(accumulated, knownFrontendRepair.edits, originalPaths).edits };
                candidateFiles = filesWithEdits(context, merged.edits);
                issues = [...repair.errors, ...merged.actionIssues, ...await validateGeneratedStage(stage.id, input.prompt, candidateFiles, architecture)];
                emit({ type: "output", delta: `\nMobiusX repaired verifiable frontend tooling issues from the isolated compiler diagnostics: ${knownFrontendRepair.changedPaths.join(", ")}.` });
              }
              const changed = uniqueRepairEdits.some((edit) => {
                const prior = [...priorRepairEdits, ...result.edits, ...accumulated].find((item) => item.path.toLowerCase() === edit.path.toLowerCase());
                return !prior || prior.content !== edit.content;
              });
              const madeProgress = issues.length === 0 || (changed && repairProgress(issuesBeforeRepair, issues)) || syntaxRepair.changedPaths.length > 0 || knownImportRepair.changedPaths.length > 0 || relativeImportRepair.changedPaths.length > 0 || knownFrontendRepair.changedPaths.length > 0;
              if (!changed && !syntaxRepair.changedPaths.length && !knownImportRepair.changedPaths.length && !relativeImportRepair.changedPaths.length) issues.push("focused repair repeated the same file contents without a meaningful change");
              if (!madeProgress && issues.length > 0) {
                for (const index of fingerprintEntries.flatMap((_entry, i) => duplicateIndexes.has(i) ? [] : [i])) {
                  repairFingerprints.push({ ...fingerprintEntries[index], outcome: "no-progress" });
                  seenRepairFingerprints.add(fingerprintEntries[index].fingerprint);
                }
                merged = combineBuildEdits(accumulated, [...result.edits, ...priorRepairEdits], originalPaths);
                candidateFiles = filesWithEdits(context, merged.edits);
                switchToFocusedFunction = true;
              } else {
                for (const index of fingerprintEntries.flatMap((_entry, i) => duplicateIndexes.has(i) ? [] : [i])) {
                  repairFingerprints.push({ ...fingerprintEntries[index], outcome: "applied" });
                  seenRepairFingerprints.add(fingerprintEntries[index].fingerprint);
                }
                priorRepairEdits = [...priorRepairEdits, ...uniqueRepairEdits];
              }
              repairOutcomes.push(`attempt ${globalRepairAttempt}: ${issues.length === 0 ? "passed" : "incomplete"}; ${uniqueRepairEdits.length} unique in-scope edit(s)${discardedRepairPaths.length ? `; discarded ${discardedRepairPaths.length} out-of-scope edit(s)` : ""}${syntaxRepair.changedPaths.length ? `; deterministic syntax repair: ${syntaxRepair.changedPaths.join(", ")}` : ""}${!madeProgress ? "; proposal discarded because diagnostics did not improve" : ""}`);
              if (!madeProgress && isNoProgressFallback && issues.length > 0) {
                repairOutcomes.push(`attempt ${globalRepairAttempt}: stopped after focused fallback made no measurable progress`);
                stopAfterNoProgressFallback = true;
              }
            } else {
              if (duplicateIndexes.size === 0) repairOutcomes.push(`attempt ${globalRepairAttempt}: no in-scope edits`);
              switchToFocusedFunction = true;
              issues = [...new Set([...issues, ...repair.errors, "focused repair returned no usable in-scope file edits"])];
              if (isNoProgressFallback) {
                repairOutcomes.push(`attempt ${globalRepairAttempt}: stopped after focused fallback returned no in-scope edits`);
                stopAfterNoProgressFallback = true;
              }
            }
            emitStep(emit, `${stage.label} · focused repair ${issues.length === 0 ? "passed" : "did not resolve the gate"}`, issues.length === 0 ? "completed" : "failed", repairStartedAt, new Date().toISOString(), repairStepId);
            if (stopAfterNoProgressFallback) break;
          }
          }
          if (stage.id === "tests" && stage.testFramework === "playwright") {
            candidateFiles = filesWithEdits(context, merged.edits);
            const topologyFiles = [...candidateFiles.entries()].map(([path, value]) => ({ path, content: value.content }));
            const finalTopologyIssues = validateGeneratedTestsAgainstTopology(topologyFiles, discoverTestApplicationTopology(topologyFiles));
            issues = [...new Set([...issues, ...finalTopologyIssues])];
          }
          issues.push(...validateStageArtifactOwnership(stage.id, accumulated, merged.edits));
          if (issues.length === 0 && stage.id === "database") {
            const completedAt = new Date().toISOString();
            const checkpointed = checkpointValidatedDatabaseSubtasks(databaseSubtasks, merged.edits, architecture, completedAt);
            if (checkpointed.issues.length) issues.push(...checkpointed.issues);
            else if (checkpointed.addedIds.length) {
              databaseSubtasks.splice(0, databaseSubtasks.length, ...checkpointed.records);
              emit({ type: "output", delta: `\nMobiusX checkpointed database artifacts validated with the completed PostgreSQL stage: ${checkpointed.addedIds.join(", ")}.` });
            }
          }
          if (issues.length > 0) {
            const endedAt = new Date().toISOString();
            emitStep(emit, `${stage.label} · incomplete: ${[...new Set(issues)].join("; ")}`, "failed", startedAt, endedAt, stageStepId);
            const failedPaths = new Set([...result.edits, ...priorRepairEdits].map((edit) => edit.path.replaceAll("\\", "/").toLowerCase()));
            const failedArtifacts = merged.edits.filter((edit) => failedPaths.has(edit.path.replaceAll("\\", "/").toLowerCase()));
            const attemptedStages = [...(latestCheckpoint?.attemptedStages ?? []), {
              id: stage.id,
              attemptedAt: endedAt,
              validation: "failed" as const,
              issues: [...new Set(issues)],
              repairOutcomes: [...repairOutcomes],
              ...(repairFingerprints.length ? { repairFingerprints: [
                ...(latestCheckpoint?.attemptedStages ?? []).filter((attempt) => attempt.id === stage.id).flatMap((attempt) => attempt.repairFingerprints ?? []),
                ...repairFingerprints,
              ] } : {}),
              artifacts: failedArtifacts.map((edit) => ({
                path: edit.path,
                action: edit.action,
                content: edit.content,
                sha256: createHash("sha256").update(edit.content).digest("hex"),
              })),
            }];
            // Keep the last passed checkpoint as the resume boundary while
            // durably preserving the failed stage's proposed content and
            // diagnostics for inspection. Failed artifacts are intentionally
            // kept out of `artifacts`, which remains the validated set.
            const updatedRepairHistory = repairOutcomes.length
              ? [...repairHistory, { stageId: stage.id, attempts: repairOutcomes.filter((outcome) => /: (?:passed|incomplete|empty or invalid response)/.test(outcome)).length, outcomes: [...repairOutcomes] }]
              : repairHistory;
            emit({ type: "generation_checkpoint", checkpoint: {
              version: 1,
              taskId: input.taskId,
              requirementsHash,
              provider: selected.name,
              modelId: input.modelId ?? "unknown",
              ...(input.projectContext?.projectPath ? { projectPath: input.projectContext.projectPath } : {}),
              completedStageIds: latestCheckpoint?.completedStageIds ?? [],
              stages: latestCheckpoint?.stages ?? [],
              artifacts: latestCheckpoint?.artifacts ?? [],
              ...(databaseSubtasks.length ? { databaseSubtasks: [...databaseSubtasks] } : {}),
              ...(backendSubtasks.length ? { backendSubtasks: [...backendSubtasks] } : {}),
              ...(businessOperations.length ? { businessOperations: [...businessOperations] } : {}),
              ...(businessOperationHistory.length ? { businessOperationHistory: [...businessOperationHistory] } : {}),
              ...(uiContracts.length ? { uiContracts: [...uiContracts] } : {}),
              ...(testSpecifications.length ? { testSpecifications: [...testSpecifications] } : {}),
              ...(testSubtasks.length ? { testSubtasks: [...testSubtasks] } : {}),
              attemptedStages,
              baseFiles: latestCheckpoint?.baseFiles ?? (input.projectContext?.relevantFiles ?? []).map((file) => ({
                path: file.relPath,
                sha256: createHash("sha256").update(file.content ?? file.snippet).digest("hex"),
              })),
              pendingStageIds: stages.slice(index).map((item) => item.id),
              pendingDependencies: latestCheckpoint?.pendingDependencies ?? [],
              repairHistory: updatedRepairHistory,
              projectArchitecture: architecture,
              updatedAt: endedAt,
            } });
            const message = `Build stopped at ${stage.id}; the generated application is incomplete. ${[...new Set(issues)].join("; ")}`;
            emit({ type: "error", message });
            emit({ type: "status", status: input.signal?.aborted ? "cancelled" : "failed" });
            emit({ type: "done" });
            return;
          }
        }

        accumulated = merged.edits;
        context = addEditsToContext(context, accumulated);
        const completedAt = new Date().toISOString();
        const paths = [...new Set([...result.edits, ...priorRepairEdits].map((edit) => edit.path))];
        emitStep(emit, `${stage.label} · passed (${paths.length} file change${paths.length === 1 ? "" : "s"})`, "completed", startedAt, completedAt, stageStepId);
        // Surface the complete accumulated draft after each successful gate so
        // users can inspect stage output even if a later gate fails. This only
        // proposes edits; the Desktop Agent still requires explicit Apply.
        emit({ type: "edits", edits: accumulated });
        if (repairOutcomes.length) repairHistory.push({ stageId: stage.id, attempts: repairOutcomes.length, outcomes: repairOutcomes });
        const checkpoint: NonNullable<RunnerInput["resumeCheckpoint"]> = {
          version: 1,
          taskId: input.taskId,
          requirementsHash,
          provider: selected.name,
          modelId: input.modelId ?? "unknown",
          ...(input.projectContext?.projectPath ? { projectPath: input.projectContext.projectPath } : {}),
          completedStageIds: [...(resumeState?.completedStageIds ?? []), stage.id],
          stages: [...(resumeState?.stages ?? []), {
            id: stage.id,
            completedAt,
            artifactPaths: paths,
            artifacts: snapshotStageDelta(resumeState?.artifacts.map(({ path, action, content }) => ({ path, action, content })) ?? [], accumulated, originalPaths),
            validation: "passed" as const,
          }],
          artifacts: accumulated.map((edit) => ({
            path: edit.path,
            action: edit.action,
            content: edit.content,
            sha256: createHash("sha256").update(edit.content).digest("hex"),
          })),
          ...(latestCheckpoint?.attemptedStages?.length ? { attemptedStages: [...latestCheckpoint.attemptedStages] } : {}),
          ...(databaseSubtasks.length ? { databaseSubtasks: [...databaseSubtasks] } : {}),
          ...(backendSubtasks.length ? { backendSubtasks: [...backendSubtasks] } : {}),
          ...(businessOperations.length ? { businessOperations: [...businessOperations] } : {}),
          ...(businessOperationHistory.length ? { businessOperationHistory: [...businessOperationHistory] } : {}),
          ...(uiContracts.length ? { uiContracts: [...uiContracts] } : {}),
          ...(testSpecifications.length ? { testSpecifications: [...testSpecifications] } : {}),
          ...(testSubtasks.length ? { testSubtasks: [...testSubtasks] } : {}),
          projectArchitecture: architecture,
          baseFiles: resumeState?.baseFiles ?? (input.projectContext?.relevantFiles ?? []).map((file) => ({
            path: file.relPath,
            sha256: createHash("sha256").update(file.content ?? file.snippet).digest("hex"),
          })),
          pendingStageIds: stages.slice(index + 1).map((item) => item.id),
          pendingDependencies: [
            ...(stages.slice(index + 1).some((item) => item.id === "frontend") ? ["frontend dependency installation", "TypeScript semantic checking", "framework production build"] : []),
            ...(stages.slice(index + 1).some((item) => item.id === "backend") ? ["backend dependency installation", "FastAPI startup/import validation"] : []),
            ...(stages.slice(index + 1).some((item) => item.id === "database") ? ["isolated PostgreSQL startup", "migration execution"] : []),
            ...(stages.slice(index + 1).some((item) => item.id === "tests") ? ["API integration and browser E2E execution"] : []),
          ],
          repairHistory: [...repairHistory],
          updatedAt: completedAt,
        };
        checkpoint.artifactOwnership = buildArtifactOwnershipManifest(checkpoint);
        latestCheckpoint = checkpoint;
        resumeState = checkpoint;
        emit({ type: "generation_checkpoint", checkpoint });
      }

      if (accumulated.length === 0) {
        emit({ type: "error", message: "Build contract failed: no files were generated; no partial application was proposed." });
        emit({ type: "status", status: "failed" });
        emit({ type: "done" });
        return;
      }
      emit({ type: "output", delta: `\n\nAll requested generation stages passed their static capability gates. MobiusX has not yet run the generated app; apply the proposal, then run Build/Preview verification for compile, migration, API, and browser acceptance.` });
      emit({ type: "status", status: "completed" });
      emit({ type: "done" });
    },
  };
}
