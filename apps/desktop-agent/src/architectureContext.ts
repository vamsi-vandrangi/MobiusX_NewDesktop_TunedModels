import { readFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";
import type { ArchitectureEvidence, DetectedExternalIntegration, DetectedRoute } from "@mobiusx/protocol";
import { detectProjectContext } from "./projectContext.js";
import { checkDatabaseConsistency } from "./dbOps.js";

/**
 * Architecture Generation (roadmap Phase 9, source requirement §7).
 *
 * The direct trigger for this module: a beta tester reported that
 * generated architecture diagrams were "very basic level." Investigating
 * *why* an LLM produces a basic diagram -- rather than assuming it's a
 * prompt-wording problem -- the answer is almost always the same one this
 * codebase has already run into for Database mode (see Phase 8's
 * phase-notes): a model asked to draw an architecture diagram from a
 * one-line request and no real project facts has nothing to draw *but*
 * "Frontend -> Backend -> Database" boxes, because that is the only
 * information it actually has. A better prompt cannot fix a missing-facts
 * problem. So this module's entire job is gathering more real facts --
 * the same "evidence, not intention" discipline as projectContext.ts and
 * dbOps.ts, extended to two things they don't cover: real HTTP routes
 * (for a Sequence/Component diagram to trace an actual request through),
 * and real third-party integrations (for a System Context diagram's
 * external systems). Architecture mode's prompt (promptShared.ts) is then
 * instructed to render this bundle faithfully, not to invent around gaps
 * in it -- gaps get an honest note in the generated doc instead.
 */

const MAX_DEPTH = 5;

async function listFilesRecursive(dir: string, depth: number, exts: Set<string>, results: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await listFilesRecursive(full, depth + 1, exts, results);
    } else if (exts.has(extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
}

// FastAPI (`@app.get("/x")` / `@router.post("/x")`) and Express
// (`app.get("/x", ...)` / `router.post("/x", ...)`) share close to the
// same shape once the optional leading `@` (Python decorator syntax) is
// made optional -- one regex covers both real conventions this codebase
// has evidenced (GreenThumbGarden's FastAPI backend; Express is in
// projectContext.ts's JS_DEP_SIGNALS as a supported backend framework).
const ROUTE_DECORATOR_RE = /^\s*@?(?:app|router)\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/i;

async function detectPythonOrExpressRoutes(root: string, location: string): Promise<DetectedRoute[]> {
  const dir = join(root, location);
  const files: string[] = [];
  await listFilesRecursive(dir, 0, new Set([".py", ".js", ".ts"]), files);
  const routes: DetectedRoute[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const rel = file.slice(root.length + 1);
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(ROUTE_DECORATOR_RE);
      if (m) routes.push({ method: m[1].toUpperCase(), path: m[2], source: rel, line: i + 1 });
    }
  }
  return routes;
}

// Next.js API routes are file-based, not decorator-based: a file's own
// path under pages/api/ or app/**/api/**/route.(js|ts) IS the route path.
// Method is only knowable without executing the file when the App Router
// convention (`export async function GET(...)`) is used -- the older
// Pages Router convention (one default-export handler that branches on
// `req.method` at runtime) genuinely can't be resolved statically, so it
// is reported as "HANDLER" rather than guessed.
const APP_ROUTER_METHOD_RE = /^export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/;

function nextApiPathFromFile(relPath: string): string | null {
  const pagesMatch = relPath.match(/^pages\/api\/(.+)\.(js|ts)x?$/);
  if (pagesMatch) return `/api/${pagesMatch[1].replace(/\/index$/, "")}`;
  const appMatch = relPath.match(/^app\/(.*?)\/?api\/(.+)\/route\.(js|ts)x?$/);
  if (appMatch) return `/api/${appMatch[2]}`;
  return null;
}

async function detectNextApiRoutes(root: string, location: string): Promise<DetectedRoute[]> {
  const dir = join(root, location);
  const files: string[] = [];
  await listFilesRecursive(dir, 0, new Set([".js", ".ts", ".jsx", ".tsx"]), files);
  const routes: DetectedRoute[] = [];
  for (const file of files) {
    const rel = file.slice(root.length + 1);
    const withinLocation = location === "." ? rel : rel.slice(location.length + 1);
    const apiPath = nextApiPathFromFile(withinLocation);
    if (!apiPath) continue;
    let content: string;
    try {
      content = await readFile(file, "utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const methods: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(APP_ROUTER_METHOD_RE);
      if (m) routes.push({ method: m[1], path: apiPath, source: rel, line: i + 1 });
      if (m) methods.push(i);
    }
    if (methods.length === 0) {
      routes.push({ method: "HANDLER", path: apiPath, source: rel, line: 1 });
    }
  }
  return routes;
}

// A conservative, curated list of well-known third-party service SDKs --
// same "known signals only, never a heuristic guess" approach as
// projectContext.ts's JS_DEP_SIGNALS/PY_DEP_SIGNALS. A project's own
// first-party code is never listed here; this is specifically for
// *external* systems a System Context diagram needs to show.
const EXTERNAL_INTEGRATION_SIGNALS: Array<[RegExp, string]> = [
  [/^stripe$/, "Stripe"],
  [/^twilio$/, "Twilio"],
  [/^@sendgrid\/mail$/, "SendGrid"],
  [/^(@aws-sdk\/|aws-sdk$)/, "AWS"],
  [/^boto3/i, "AWS (boto3)"],
  [/^openai$/, "OpenAI API"],
  [/^@anthropic-ai\/sdk$/, "Anthropic API"],
  [/^anthropic/i, "Anthropic API"],
  [/^(ioredis|redis)$/, "Redis"],
  [/^@elastic\/elasticsearch$/, "Elasticsearch"],
  [/^algoliasearch$/, "Algolia"],
  [/^cloudinary$/, "Cloudinary"],
  [/^firebase-admin$/, "Firebase"],
  [/^@sentry\//, "Sentry"],
  [/^stripe-python/i, "Stripe"],
  [/^twilio-python/i, "Twilio"],
];

async function readTextIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function detectExternalIntegrations(root: string, locations: string[]): Promise<DetectedExternalIntegration[]> {
  const found: DetectedExternalIntegration[] = [];
  const seen = new Set<string>();
  for (const loc of locations) {
    const dir = join(root, loc);
    const pkgRaw = await readTextIfExists(join(dir, "package.json"));
    if (pkgRaw) {
      try {
        const pkg = JSON.parse(pkgRaw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
        const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
        for (const [pattern, name] of EXTERNAL_INTEGRATION_SIGNALS) {
          if (seen.has(name)) continue;
          const match = Object.keys(deps).find((d) => pattern.test(d));
          if (match) {
            found.push({ name, evidence: `${loc === "." ? "" : loc + "/"}package.json: dependency "${match}"@${deps[match]}` });
            seen.add(name);
          }
        }
      } catch {
        // malformed package.json -- skip, not this module's concern
      }
    }
    const reqRaw = (await readTextIfExists(join(dir, "requirements.txt"))) ?? (await readTextIfExists(join(dir, "pyproject.toml")));
    if (reqRaw) {
      const lines = reqRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const [pattern, name] of EXTERNAL_INTEGRATION_SIGNALS) {
        if (seen.has(name)) continue;
        const match = lines.find((l) => pattern.test(l));
        if (match) {
          found.push({ name, evidence: `${loc === "." ? "" : loc + "/"}requirements.txt: "${match}"` });
          seen.add(name);
        }
      }
    }
  }
  return found;
}

// Real CORS allow_origins entries (FastAPI/Express both commonly declare
// this) -- the single most direct piece of on-disk evidence for "which
// port/host does the frontend actually call the backend on," which is
// exactly the kind of concrete label ("HTTPS, CORS: http://localhost:3000")
// that turns a generic unlabeled arrow into a real one.
const CORS_ORIGIN_RE = /https?:\/\/[A-Za-z0-9.\-]+(?::\d+)?/g;

async function detectFrontendBackendLinks(root: string, backendLocations: string[]): Promise<string[]> {
  const found = new Set<string>();
  for (const loc of backendLocations) {
    const dir = join(root, loc);
    const files: string[] = [];
    await listFilesRecursive(dir, 0, new Set([".py", ".js", ".ts"]), files);
    for (const file of files) {
      const content = await readTextIfExists(file);
      if (!content || !/allow_origins|cors\(/i.test(content)) continue;
      const matches = content.match(CORS_ORIGIN_RE);
      if (matches) for (const m of matches) found.add(m);
    }
  }
  return [...found];
}

export async function gatherArchitectureEvidence(projectRoot: string): Promise<ArchitectureEvidence> {
  const projectContext = await detectProjectContext(projectRoot);
  const database = await checkDatabaseConsistency(projectRoot);

  const backendLocations = [...new Set(projectContext.components.filter((c) => c.category === "backend").map((c) => c.location))];
  const frontendLocations = [...new Set(projectContext.components.filter((c) => c.category === "frontend").map((c) => c.location))];
  const isNextJs = projectContext.components.some((c) => c.category === "frontend" && c.name === "Next.js");

  const routes: DetectedRoute[] = [];
  for (const loc of backendLocations.length > 0 ? backendLocations : ["."]) {
    routes.push(...(await detectPythonOrExpressRoutes(projectRoot, loc)));
  }
  if (isNextJs) {
    for (const loc of frontendLocations) {
      routes.push(...(await detectNextApiRoutes(projectRoot, loc)));
    }
  }

  const allLocations = [...new Set([...backendLocations, ...frontendLocations, "."])];
  const externalIntegrations = await detectExternalIntegrations(projectRoot, allLocations);
  const frontendBackendLinks = await detectFrontendBackendLinks(projectRoot, backendLocations.length > 0 ? backendLocations : ["."]);

  return {
    projectPath: projectRoot,
    generatedAt: new Date().toISOString(),
    projectContext,
    database,
    routes,
    externalIntegrations,
    frontendBackendLinks,
  };
}
