import { createHash } from "node:crypto";

export interface TestTopologyFile { path: string; content: string }
export interface TestApplicationTopology {
  schemaVersion: "1.0";
  backend: { entrypoint?: string; packageRoot?: string; modules: string[]; routes: Array<{ method: string; path: string }>; databaseSessionModule?: string; ormModels: Array<{ module: string; className: string; table: string }>; migrationConfig?: string; requirementsFile?: string };
  authentication: { module?: string; routeModule?: string; routes: Array<{ method: string; path: string }>; loginRequestContentType?: string; usernameField?: string; passwordField?: string };
  frontend: { entrypoint?: string; routes: string[]; labels: string[]; fields: string[]; actions: string[]; apiBaseUrlEnv?: string; playwrightPackage?: string };
  test: { pytestConfig?: string; playwrightConfig?: string; backendTestFiles: string[]; browserTestFiles: string[]; pythonTestDependencies?: string[] };
  sourceManifest: Array<{ path: string; sha256: string }>;
}

const norm = (path: string) => path.replaceAll("\\", "/").replace(/^\.\//, "");
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const routePattern = (route: string) => route.split(/(\{[^}]+\})/g).map((part) => /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
function topLevelClassBodies(source: string): Array<{ name: string; body: string }> {
  const lines = source.split(/\r?\n/);
  const result: Array<{ name: string; body: string }> = [];
  for (let index = 0; index < lines.length; index++) {
    const declaration = lines[index].match(/^class\s+(\w+)\b[^\n]*:/);
    if (!declaration) continue;
    let end = index + 1;
    while (end < lines.length && !/^(?:class|def|async\s+def|@)\b/.test(lines[end])) end++;
    result.push({ name: declaration[1], body: lines.slice(index + 1, end).join("\n") });
  }
  return result;
}

/** Inspect the checked-out/generated files. No framework/package name is guessed. */
export function discoverTestApplicationTopology(files: TestTopologyFile[]): TestApplicationTopology {
  const normalized = files.map((file) => ({ ...file, path: norm(file.path) }));
  const byPath = new Map(normalized.map((file) => [file.path, file.content]));
  const backendFiles = normalized.filter((file) => /\.py$/i.test(file.path) && !/(^|\/)(\.venv|venv|site-packages|tests)(\/|$)/.test(file.path));
  const pythonSymbols = new Map(backendFiles.map(({ path, content }) => [path.replace(/\.py$/i, "").replaceAll("/", ".").replace(/\.__init__$/, ""), new Set([
    ...[...content.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)\b/gm)].map((match) => match[1] ?? match[2]),
    ...[...content.matchAll(/^([A-Za-z_]\w*)\s*=/gm)].map((match) => match[1]),
    ...[...content.matchAll(/^from\s+[\w.]+\s+import\s+([^\n]+)/gm)].flatMap((match) => match[1].split(",").map((item) => item.trim().split(/\s+as\s+/)[1] ?? item.trim().split(".").at(-1)!)),
  ])]));
  const packageRoots = [...new Set(backendFiles.flatMap(({ path }) => {
    const pieces = path.split("/");
    return pieces.slice(0, -1).map((_, index) => pieces.slice(0, index + 1).join("/")).filter((dir) => byPath.has(`${dir}/__init__.py`));
  }))].sort((a, b) => a.length - b.length);
  const mainFile = backendFiles.find(({ path, content }) => /(^|\/)main\.py$/i.test(path) && /\b(?:FastAPI\s*\(|app\s*=\s*FastAPI\s*\()/s.test(content));
  const entrypoint = mainFile ? `${mainFile.path.replace(/\.py$/i, "").replaceAll("/", ".")}:app` : undefined;
  const pythonModules = backendFiles.map(({ path }) => path.replace(/\.py$/i, "").replaceAll("/", ".").replace(/\.__init__$/, ""));
  const apiRoutes: Array<{ method: string; path: string }> = [];
  for (const { content } of backendFiles) {
    for (const match of content.matchAll(/@\w+\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/gi)) {
      const item = { method: match[1].toUpperCase(), path: match[2] };
      if (!apiRoutes.some((route) => route.method === item.method && route.path === item.path)) apiRoutes.push(item);
    }
  }
  const databaseFile = backendFiles.find(({ content }) => /(?:async\s+)?def\s+get_db\s*\(/.test(content));
  const databaseSessionModule = databaseFile?.path.replace(/\.py$/i, "").replaceAll("/", ".");
  const ormModels = backendFiles.flatMap(({ path, content }) => {
    const module = path.replace(/\.py$/i, "").replaceAll("/", ".");
    return topLevelClassBodies(content).flatMap(({ name, body }) => {
      const table = body.match(/__tablename__\s*=\s*["']([^"']+)["']/)?.[1];
      return table ? [{ module, className: name, table }] : [];
    });
  });
  const migrationConfig = normalized.find(({ path }) => /(^|\/)alembic\.ini$/i.test(path))?.path;
  const requirementsFile = normalized.find(({ path }) => /(^|\/)requirements\.txt$/i.test(path))?.path;
  const authFile = backendFiles.find(({ content }) => /def\s+(?:get_current_user|require_role|authenticate_user)\s*\(/.test(content));
  const authModule = authFile?.path.replace(/\.py$/i, "").replaceAll("/", ".");
  const authRouteFile = backendFiles.find(({ content }) => /(?:async\s+)?def\s+login\s*\(/.test(content) && /@\w+\.(?:post|get)\(/i.test(content));
  const authRouteModule = authRouteFile?.path.replace(/\.py$/i, "").replaceAll("/", ".");
  const authRoutes = apiRoutes.filter((route) => authRouteFile?.content.includes(`"${route.path}"`) || authRouteFile?.content.includes(`'${route.path}'`));
  const loginSchema = backendFiles.flatMap(({ content }) => topLevelClassBodies(content).filter(({ name }) => /(?:Login|Auth)/i.test(name)))[0];
  const requestBodyType = authRouteFile?.content.match(/(?:async\s+)?def\s+login\s*\(\s*\w+\s*:\s*(\w+)/)?.[1];
  let ui: { routes?: Array<Record<string, any>> } = {};
  const uiFile = normalized.find(({ path }) => /(^|\/)ui-contract(?:\.v\d+)?\.json$/i.test(path));
  if (uiFile) { try { ui = JSON.parse(uiFile.content) as typeof ui; } catch { /* surfaced as missing UI routes */ } }
  const uiEnv = uiFile?.content.match(/"apiBaseUrlEnv"\s*:\s*"([^"]+)"/)?.[1];
  const frontendEntrypoint = normalized.find(({ path }) => !/(^|\/)node_modules\//i.test(path) && /(^|\/)src\/main\.[jt]sx?$/i.test(path))?.path
    ?? normalized.find(({ path }) => !/(^|\/)node_modules\//i.test(path) && /(^|\/)src\/index\.[jt]sx?$/i.test(path))?.path;
  const uiRoutes = (ui.routes ?? []).flatMap((route) => typeof route.route === "string" ? [route.route] : []);
  const labels = (ui.routes ?? []).flatMap((route) => [route.title, ...(route.navigation ?? []).map((item: any) => item.label), ...(route.form?.fields ?? []).map((field: any) => field.label), ...(route.actions ?? []).map((action: any) => action.label)].filter((value): value is string => typeof value === "string"));
  const fields = (ui.routes ?? []).flatMap((route) => [...(route.form?.fields ?? []).map((field: any) => field.name), ...(route.table?.columns ?? []), ...(route.detailFields ?? [])].filter((value): value is string => typeof value === "string"));
  const actions = (ui.routes ?? []).flatMap((route) => [
    ...(route.actions ?? []).map((action: any) => action.label),
    ...(route.form ? ["Continue"] : []),
  ].filter((value: unknown): value is string => typeof value === "string"));
  const renderedFrontend = normalized.filter(({ path }) => /\.[jt]sx?$/i.test(path) && !/(^|\/)node_modules\//i.test(path)).map(({ content }) => content).join("\n");
  if (/>(?:\s|\{[^}]*\})*Sign out\s*</i.test(renderedFrontend)) actions.push("Sign out");
  let packageManifest: Record<string, any> = {};
  const manifestFile = normalized.find(({ path }) => /(^|\/)package\.json$/i.test(path) && /(^|\/)frontend\//i.test(path));
  if (manifestFile) { try { packageManifest = JSON.parse(manifestFile.content); } catch { /* package absence is explicit */ } }
  const pythonRequirements = normalized.filter(({ path }) => /(^|\/)requirements(?:[-_.][\w-]+)?\.txt$/i.test(path) || /(^|\/)pyproject\.toml$/i.test(path)).map(({ content }) => content).join("\n");
  return {
    schemaVersion: "1.0",
    backend: { ...(entrypoint ? { entrypoint } : {}), ...(packageRoots[0] ? { packageRoot: packageRoots[0] } : {}), modules: pythonModules, routes: apiRoutes.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method)), ...(databaseSessionModule ? { databaseSessionModule } : {}), ormModels, ...(migrationConfig ? { migrationConfig } : {}), ...(requirementsFile ? { requirementsFile } : {}) },
    authentication: { ...(authModule ? { module: authModule } : {}), ...(authRouteModule ? { routeModule: authRouteModule } : {}), routes: authRoutes, ...(requestBodyType ? { loginRequestContentType: "application/json" } : {}), ...(loginSchema?.body.match(/^\s*(\w+)\s*:/m)?.[1] ? { usernameField: loginSchema.body.match(/^\s*(\w+)\s*:/m)![1] } : {}), ...(loginSchema?.body.match(/^\s*\w+\s*:[^\n]*\n\s*(\w+)\s*:/m)?.[1] ? { passwordField: loginSchema.body.match(/^\s*\w+\s*:[^\n]*\n\s*(\w+)\s*:/m)![1] } : {}) },
    frontend: { ...(frontendEntrypoint ? { entrypoint: frontendEntrypoint } : {}), routes: [...new Set(uiRoutes)], labels: [...new Set(labels)], fields: [...new Set(fields)], actions: [...new Set(actions)], ...(uiEnv ? { apiBaseUrlEnv: uiEnv } : {}), ...(typeof packageManifest.devDependencies?.["@playwright/test"] === "string" ? { playwrightPackage: packageManifest.devDependencies["@playwright/test"] } : typeof packageManifest.dependencies?.["@playwright/test"] === "string" ? { playwrightPackage: packageManifest.dependencies["@playwright/test"] } : {}) },
    test: { ...(normalized.some(({ path }) => /(^|\/)(pytest\.ini|pyproject\.toml)$/i.test(path)) ? { pytestConfig: normalized.find(({ path }) => /(^|\/)(pytest\.ini|pyproject\.toml)$/i.test(path))!.path } : {}), ...(normalized.some(({ path }) => /(^|\/)playwright\.config\.[cm]?[jt]s$/i.test(path)) ? { playwrightConfig: normalized.find(({ path }) => /(^|\/)playwright\.config\.[cm]?[jt]s$/i.test(path))!.path } : {}), backendTestFiles: normalized.filter(({ path }) => /(^|\/)backend\/tests\/.*\.py$/i.test(path)).map(({ path }) => path), browserTestFiles: normalized.filter(({ path }) => /(^|\/)(?:frontend\/)?(?:e2e|tests\/e2e)\/.*\.spec\.[cm]?[jt]sx?$/i.test(path)).map(({ path }) => path), ...(pythonRequirements ? { pythonTestDependencies: pythonRequirements.split(/\r?\n/).map((line) => line.trim()).filter((line) => /^(pytest|httpx|pytest-asyncio)(?:[<=>~[]|$)/i.test(line)) } : {}) },
    sourceManifest: normalized.filter(({ path }) => /\.(?:py|tsx?|jsx?|json|ini|toml)$/i.test(path) && !/(^|\/)(node_modules|dist|e2e|tests|\.venv|venv|site-packages)(\/|$)/.test(path) && !/(^|\/)p0(?:\.|-)/i.test(path)).map(({ path, content }) => ({ path, sha256: digest(content) })).sort((a, b) => a.path.localeCompare(b.path)),
  };
}

/** Reject test code that targets topology that does not exist in this project. */
export function validateGeneratedTestsAgainstTopology(files: TestTopologyFile[], topology = discoverTestApplicationTopology(files)): string[] {
  const issues: string[] = [];
  const backendFiles = files.filter((file) => /\.py$/i.test(norm(file.path)) && !/(^|\/)(\.venv|venv|site-packages)(\/|$)/.test(norm(file.path)));
  const pythonSymbols = new Map(backendFiles.map(({ path, content }) => [norm(path).replace(/\.py$/i, "").replaceAll("/", ".").replace(/\.__init__$/, ""), new Set([
    ...[...content.matchAll(/^(?:async\s+)?def\s+(\w+)\s*\(|^class\s+(\w+)\b/gm)].map((match) => match[1] ?? match[2]),
    ...[...content.matchAll(/^([A-Za-z_]\w*)\s*=/gm)].map((match) => match[1]),
    ...[...content.matchAll(/^from\s+[\w.]+\s+import\s+([^\n]+)/gm)].flatMap((match) => match[1].split(",").map((item) => item.trim().split(/\s+as\s+/)[1] ?? item.trim().split(".").at(-1)!)),
  ])]));
  const allPythonTestCode = files.filter((file) => /(^|\/)backend\/tests\/.*\.py$/i.test(norm(file.path))).map((file) => file.content).join("\n");
  const declaredFixtures = new Set([...allPythonTestCode.matchAll(/@pytest\.fixture(?:\([^)]*\))?\s*\n(?:async\s+)?def\s+(\w+)/g)].map((match) => match[1]));
  const knownPytestFixtures = new Set(["request", "tmp_path", "tmp_path_factory", "monkeypatch", "caplog", "capfd", "capsys", "pytestconfig", "record_property", "recwarn", "cache"]);
  const knownModules = new Set(topology.backend.modules);
  const knownTopLevel = new Set([...knownModules].map((module) => module.split(".")[0]));
  const frontendRouteMatches = (candidate: string) => topology.frontend.routes.some((route) => new RegExp(`^${routePattern(route)}$`).test(candidate));
  const apiRouteMatches = (candidate: string) => topology.backend.routes.some((route) => new RegExp(`^${routePattern(route.path)}$`).test(candidate));
  for (const file of files.map((item) => ({ ...item, path: norm(item.path) }))) {
    if (/^backend\/tests\/.*\.py$/i.test(file.path)) {
      for (const match of file.content.matchAll(/^\s*(?:from|import)\s+([A-Za-z_][\w.]*)/gm)) {
        const name = match[1];
        const top = name.split(".")[0];
        if (knownModules.size > 0 && ([...knownTopLevel, "app", "backend", "src"].includes(top)) && !knownTopLevel.has(top)) issues.push(`${file.path} imports missing local package/module '${name}'`);
        else if (knownTopLevel.has(top) && ![...knownModules].some((module) => module === name || module.startsWith(`${name}.`) || name.startsWith(`${module}.`)) && ![...knownModules].some((module) => module.startsWith(`${name}.`))) issues.push(`${file.path} imports unresolved local module '${name}'`);
      }
      for (const match of file.content.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\s+([^\n]+)/gm)) {
        const module = match[1];
        if (knownModules.size === 0 || !knownTopLevel.has(module.split(".")[0])) continue;
        const symbols = pythonSymbols.get(module);
        if (!symbols) continue;
        for (const entry of match[2].split(",")) {
          const symbol = entry.trim().split(/\s+as\s+/)[0];
          if (symbol && symbol !== "*" && !symbols.has(symbol)) issues.push(`${file.path} imports missing symbol '${symbol}' from '${module}'`);
        }
      }
      for (const match of file.content.matchAll(/(?:async\s+)?def\s+test_\w+\(([^)]*)\)/g)) {
        for (const raw of match[1].split(",")) {
          const fixture = raw.trim().split(":", 1)[0].trim();
          if (fixture && !declaredFixtures.has(fixture) && !knownPytestFixtures.has(fixture)) issues.push(`${file.path} test references undefined pytest fixture '${fixture}'`);
        }
      }
      if (/@pytest\.mark\.asyncio/.test(file.content) && !topology.test.pythonTestDependencies?.some((dependency) => /^pytest-asyncio(?:[<=>~[]|$)/i.test(dependency))) issues.push(`${file.path} uses asyncio pytest tests but pytest-asyncio is not declared`);
    }
    if (/\.(?:spec|test)\.[cm]?[jt]sx?$/i.test(file.path)) {
      for (const match of file.content.matchAll(/(?:page\.)?goto\(\s*["']([^"']+)["']/g)) {
        const raw = match[1];
        if (/^https?:\/\//i.test(raw)) { try { if (topology.frontend.routes.length && !frontendRouteMatches(new URL(raw).pathname)) issues.push(`${file.path} navigates to unregistered frontend route '${new URL(raw).pathname}'`); } catch { issues.push(`${file.path} contains an invalid navigation URL`); } }
        else if (raw.startsWith("/") && topology.frontend.routes.length && !frontendRouteMatches(raw.split(/[?#]/, 1)[0])) issues.push(`${file.path} navigates to unregistered frontend route '${raw}'`);
      }
      for (const match of file.content.matchAll(/(?:waitForResponse|request\.(?:get|post|put|patch|delete))\(\s*["'](?:https?:\/\/[^/]+)?(\/[\w{}./-]+)["']/g)) if (topology.backend.routes.length && !apiRouteMatches(match[1])) issues.push(`${file.path} calls unregistered API route '${match[1]}'`);
      for (const match of file.content.matchAll(/(?:page\.)?getByLabel\(\s*["']([^"']+)["']/g)) if (topology.frontend.labels.length && !topology.frontend.labels.includes(match[1])) issues.push(`${file.path} uses unknown accessible label '${match[1]}'`);
      for (const match of file.content.matchAll(/(?:page\.)?getByRole\(\s*["']button["']\s*,\s*\{\s*name:\s*["']([^"']+)["']/g)) if (topology.frontend.actions.length && !topology.frontend.actions.includes(match[1]) && !topology.frontend.labels.includes(match[1])) issues.push(`${file.path} uses unknown button name '${match[1]}'`);
      for (const match of file.content.matchAll(/(?:page\.)?fill\(\s*["']input\[name=["']([^\]"']+)["']\]["']\s*,/g)) if (topology.frontend.fields.length && !topology.frontend.fields.includes(match[1])) issues.push(`${file.path} fills unknown form field '${match[1]}'`);
      const fixedPasswordFill = /fill\(\s*'[^']*password[^']*'\s*,\s*'[^']+'/i.test(file.content) || /fill\(\s*"[^"]*password[^"]*"\s*,\s*"[^"]+"/i.test(file.content);
      if ((/password\s*[=:]\s*["'][^"']+["']/i.test(file.content) || fixedPasswordFill) && !/process\.env\.|process\.env\[/i.test(file.content)) issues.push(`${file.path} embeds a fixed credential instead of using test-data provisioning or environment configuration`);
    }
  }
  return [...new Set(issues)];
}

export function testTopologyPromptSummary(topology: TestApplicationTopology): string {
  return JSON.stringify({ backend: topology.backend, authentication: topology.authentication, frontend: topology.frontend, test: topology.test });
}
