import type { ProposedEdit } from "@mobiusx/protocol";
import type { UiContract, UiOperation } from "./uiContract.js";

const quote = (value: unknown) => JSON.stringify(value);
const operationData = (operations: UiOperation[]) => Object.fromEntries(operations.map((operation) => [operation.operationId, {
  method: operation.route.method,
  path: operation.route.path,
  ...(operation.operationId === "auth.login" && "requestFields" in operation ? {
    usernameField: operation.usernameField,
    passwordField: operation.passwordField,
    requestContentType: operation.requestContentType,
    responseContentType: operation.responseContentType,
    sessionScheme: operation.sessionScheme,
    tokenField: operation.tokenField,
    tokenTypeField: operation.tokenTypeField,
    expirationSeconds: operation.expirationSeconds,
  } : {}),
}]));

/** Renders only a previously validated UI contract; all data remains API-backed. */
export function renderReactUi(contract: UiContract, operations: UiOperation[]): ProposedEdit[] {
  const ui = quote(contract);
  const api = quote(operationData(operations));
  const app = `import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import "./styles.css";

type UiField = { name: string; label: string; type: string; required?: boolean; options?: string[] };
type UiScreen = { id: string; route: string; purpose: string; roles: string[]; title: string; loginRole?: "customer" | "manager"; dataOperation?: string; form?: { operationId: string; fields: UiField[]; navigateTo?: string }; table?: { entity: string; columns: string[]; filters?: string[]; filterOptions?: Record<string, string[]>; statusLabels?: Record<string, string> }; detailEntity?: string; detailFields?: string[]; relatedData?: Array<{ title: string; operationId: string; columns: string[] }>; actions: Array<{ label: string; operationId: string; confirm?: boolean; navigateTo?: string }>; navigation: Array<{ label: string; route: string }>; states: { loading: string; empty: string; success: string; error: string }; accessibility: { heading: boolean; labels: boolean; keyboard: boolean }; responsive: boolean };
type UiSpec = { title: string; routes: UiScreen[] };
type Session = { token: string; role: string; username: string };
type ApiOperation = { method: string; path: string; usernameField?: string; passwordField?: string; requestContentType?: string; responseContentType?: string; sessionScheme?: string; tokenField?: string; tokenTypeField?: string; expirationSeconds?: number };
type ApiResult = { response: Response; data: unknown };
const ui = ${ui} as UiSpec;
const operations = ${api} as Record<string, ApiOperation>;
const apiBase = (import.meta as ImportMeta & { env: Record<string, string | undefined> }).env.VITE_API_BASE_URL || "http://127.0.0.1:8000";
const routeMatches = (pattern: string, path: string) => { const expected = pattern.split("/"); const actual = path.split("/"); return expected.length === actual.length && expected.every((part, index) => part.startsWith("{") && part.endsWith("}") || part === actual[index]); };
function routeParams(pattern: string, path: string): Record<string, string> {
  const expected = pattern.split("/"); const actual = path.split("/"); const result: Record<string, string> = {};
  expected.forEach((part, index) => { const match = part.match(/^\\{([A-Za-z_][A-Za-z0-9_]*)\\}$/); if (match && actual[index] !== undefined) result[match[1]] = decodeURIComponent(actual[index]); });
  return result;
}
function fillRoute(pattern: string, record?: Record<string, unknown>) {
  return pattern.replace(/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_match, key: string) => encodeURIComponent(String(record?.[key] ?? record?.id ?? "")));
}
function currentScreen(path: string): UiScreen {
  return ui.routes.find((screen) => routeMatches(screen.route, path)) ?? ui.routes[0];
}
function operationPath(operationId: string, record?: Record<string, unknown>) {
  const operation = operations[operationId];
  if (!operation) throw new Error("This action is not available in the API contract.");
  return operation.path.replace(/\\{([A-Za-z_][A-Za-z0-9_]*)\\}/g, (_match, key: string) => {
    const value = record?.[key] ?? record?.id;
    if (value === undefined) throw new Error("The selected record is missing a required identifier.");
    return encodeURIComponent(String(value));
  });
}
async function apiRequest(operationId: string, token: string, options: { body?: unknown; record?: Record<string, unknown>; query?: URLSearchParams } = {}): Promise<ApiResult> {
  const operation = operations[operationId];
  const path = operationPath(operationId, options.record);
  const response = await fetch(new URL(path + (options.query?.size ? "?" + options.query.toString() : ""), apiBase), {
    method: operation.method,
    headers: { ...(options.body ? { "Content-Type": operations[operationId].requestContentType || "application/json" } : {}), ...(token ? { Authorization: "Bearer " + token } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data };
}
function messageFor(status: number, payload: unknown): string {
  if (status === 401) return "Your session has expired or the credentials were not accepted. Please sign in again.";
  if (status === 403) return "Your account does not have permission to perform this action.";
  if (status === 404) return "This record is not available to your account.";
  if (status === 409) return "This item has already changed. Refresh the page and try again.";
  if (status >= 500) return "The service could not complete the request. Please try again.";
  if (payload && typeof payload === "object" && "detail" in payload) return String((payload as { detail: unknown }).detail);
  return "The request could not be completed.";
}
export default function App() {
  const [path, setPath] = useState(window.location.pathname);
  const [session, setSession] = useState<Session | null>(() => { try { return JSON.parse(localStorage.getItem("mobiusx-session") || "null") as Session | null; } catch { return null; } });
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [selected, setSelected] = useState<Record<string, unknown> | undefined>();
  const [relatedRows, setRelatedRows] = useState<Record<string, Array<Record<string, unknown>>>>({});
  const [reloadVersion, setReloadVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const screen = useMemo(() => currentScreen(path), [path]);
  const navigate = useCallback((target: string) => { history.pushState({}, "", target); setPath(window.location.pathname); setError(""); setNotice(""); }, []);
  const loginRouteForRole = (role: string) => ui.routes.find((item) => item.form?.operationId === "auth.login" && item.loginRole === role)?.route ?? ui.routes.find((item) => item.roles.includes("public"))?.route ?? "/";
  const customerLoginRoute = loginRouteForRole("customer");
  const defaultRoleRoute = (role: string) => ui.routes.find((item) => item.roles.includes(role) && item.dataOperation)?.route ?? ui.routes.find((item) => item.roles.includes(role) && !item.roles.includes("public"))?.route ?? customerLoginRoute;
  useEffect(() => { const pop = () => setPath(window.location.pathname); window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  useEffect(() => {
    if (!screen.roles.includes("public") && (!session || !screen.roles.includes(session.role))) { navigate(session ? loginRouteForRole(session.role) : loginRouteForRole(screen.roles[0])); }
  }, [screen, session, navigate, customerLoginRoute]);
  const refresh = useCallback(async () => {
    if (!screen.dataOperation || !session) return;
    setLoading(true); setError("");
    try {
      const query = new URLSearchParams({ offset: "0", limit: "50" });
      for (const field of screen.table?.filters ?? []) if (filters[field]) query.set(field, filters[field]);
      const routeValues = routeParams(screen.route, path);
      const record = Object.keys(routeValues).length ? { ...routeValues, id: Object.values(routeValues)[0] } : undefined;
      const result = await apiRequest(screen.dataOperation, session.token, { query, ...(record ? { record } : {}) });
      if (!result.response.ok) throw Object.assign(new Error(messageFor(result.response.status, result.data)), { status: result.response.status });
      const payload = result.data as { items?: unknown[] } | unknown[] | null;
      const values = Array.isArray(payload) ? payload : payload && typeof payload === "object" && Array.isArray(payload.items) ? payload.items : payload ? [payload] : [];
      setRows(values.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object")));
    } catch (cause) { const e = cause as Error & { status?: number }; if (e.status === 401) { const role = session.role; localStorage.removeItem("mobiusx-session"); setSession(null); navigate(loginRouteForRole(role)); } else setError(e.message || screen.states.error); }
    finally { setLoading(false); }
  }, [screen, session, filters, navigate, customerLoginRoute, path]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const routeValues = routeParams(screen.route, path);
    if (!screen.detailEntity || !Object.keys(routeValues).length || !session || !screen.dataOperation) { setSelected(undefined); setRelatedRows({}); return; }
    const detailOp = screen.dataOperation;
    if (!operations[detailOp] || operations[detailOp].method !== "GET") return;
    let cancelled = false;
    void (async () => {
      try {
        const record = { ...routeValues, id: Object.values(routeValues)[0] };
        const detail = await apiRequest(detailOp, session.token, { record });
        if (!detail.response.ok) throw Object.assign(new Error(messageFor(detail.response.status, detail.data)), { status: detail.response.status });
        if (!cancelled) setSelected(detail.data as Record<string, unknown>);
        const grouped: Record<string, Array<Record<string, unknown>>> = {};
        for (const related of screen.relatedData ?? []) {
          const result = await apiRequest(related.operationId, session.token, { record });
          if (!result.response.ok) throw Object.assign(new Error(messageFor(result.response.status, result.data)), { status: result.response.status });
          const values = Array.isArray(result.data) ? result.data : [];
          grouped[related.operationId] = values.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"));
        }
        if (!cancelled) setRelatedRows(grouped);
      } catch (cause) {
        if (cancelled) return;
        const failure = cause as Error & { status?: number };
        if (failure.status === 401 && session) { localStorage.removeItem("mobiusx-session"); setSession(null); navigate(loginRouteForRole(session.role)); }
        else setError(failure.message || screen.states.error);
      }
    })();
    return () => { cancelled = true; };
  }, [path, screen, session, reloadVersion]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!screen.form) return;
    const values = Object.fromEntries(new FormData(event.currentTarget).entries()); setLoading(true); setError(""); setNotice("");
    try {
      const result = await apiRequest(screen.form.operationId, session?.token ?? "", { body: values });
      if (!result.response.ok) throw Object.assign(new Error(messageFor(result.response.status, result.data)), { status: result.response.status });
      if (screen.form.operationId === "auth.login") {
        const data = result.data as Record<string, unknown> | null;
        const authOperation = operations["auth.login"];
        const tokenValue = data?.[authOperation.tokenField ?? ""];
        if (typeof tokenValue !== "string" || !tokenValue) throw new Error("Login response did not contain the token declared by the API contract.");
        const role = screen.loginRole;
        if (!role) throw new Error("Select the correct sign-in portal. The server will enforce your actual permissions.");
        const next = { token: tokenValue, role, username: String(values[authOperation.usernameField ?? ""] ?? "") };
        localStorage.setItem("mobiusx-session", JSON.stringify(next)); setSession(next); navigate(defaultRoleRoute(role));
      } else {
        setNotice(screen.states.success);
        const created = result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
        if (created) setSelected(created);
        if (screen.form.navigateTo) navigate(fillRoute(screen.form.navigateTo, created));
        else { await refresh(); setReloadVersion((value) => value + 1); }
      }
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401 && session) { localStorage.removeItem("mobiusx-session"); setSession(null); navigate(loginRouteForRole(session.role)); }
      else setError(failure.message || screen.states.error);
    }
    finally { setLoading(false); }
  }
  async function act(action: UiScreen["actions"][number], row?: Record<string, unknown>) {
    if (action.confirm && !window.confirm("Are you sure you want to " + action.label.toLowerCase() + "?")) return;
    setLoading(true); setError(""); setNotice("");
    try {
      const result = await apiRequest(action.operationId, session?.token ?? "", { record: row ?? selected });
      if (!result.response.ok) throw Object.assign(new Error(messageFor(result.response.status, result.data)), { status: result.response.status });
      setNotice(action.label + " completed."); await refresh(); setReloadVersion((value) => value + 1);
      if (result.data && typeof result.data === "object") setSelected(result.data as Record<string, unknown>); else if (row) setSelected(row);
      if (action.navigateTo) navigate(fillRoute(action.navigateTo, row ?? selected));
    } catch (cause) {
      const failure = cause as Error & { status?: number };
      if (failure.status === 401 && session) { localStorage.removeItem("mobiusx-session"); setSession(null); navigate(loginRouteForRole(session.role)); }
      else setError(failure.message || screen.states.error);
    }
    finally { setLoading(false); }
  }
  const roleScreens = session ? ui.routes.filter((item) => item.roles.includes(session.role) && !item.roles.includes("public")) : ui.routes.filter((item) => item.roles.includes("public"));
  const detailRoute = ui.routes.find((item) => item.detailEntity === screen.table?.entity && Boolean(session && item.roles.includes(session.role)) && item.route.includes("{"))?.route;
  return <div className="app-shell"><header className="topbar"><a className="brand" href="/" onClick={(event) => { event.preventDefault(); navigate(session ? defaultRoleRoute(session.role) : customerLoginRoute); }}>{ui.title}</a><nav aria-label="Main navigation">{roleScreens.flatMap((item) => item.navigation).filter((item, index, all) => all.findIndex((candidate) => candidate.route === item.route) === index).map((item) => <a key={item.route} href={item.route} onClick={(event) => { event.preventDefault(); navigate(item.route); }}>{item.label}</a>)}</nav><div className="account">{session && <><span>{session.username} · {session.role}</span><button className="quiet" onClick={() => { const role = session.role; localStorage.removeItem("mobiusx-session"); setSession(null); navigate(loginRouteForRole(role)); }}>Sign out</button></>}</div></header>
    <main className="page" aria-busy={loading}><div className="page-heading"><div><p className="eyebrow">{screen.purpose}</p><h1>{screen.title}</h1></div>{screen.table?.filters?.map((field) => <label className="filter-label" key={field}>{field.replaceAll("_", " ")}{screen.table?.filterOptions?.[field]?.length ? <select aria-label={field} value={filters[field] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, [field]: event.target.value }))}><option value="">All</option>{screen.table.filterOptions[field].map((value) => <option key={value} value={value}>{value}</option>)}</select> : <input type="search" aria-label={field} value={filters[field] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, [field]: event.target.value }))} />}</label>)}</div>
    {error && <div role="alert" className="notice error">{error}<button className="notice-close" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}{notice && <div role="status" className="notice success">{notice}</div>}
    {screen.form && <form className="card form-card" onSubmit={submit}>{screen.form.fields.map((field) => <label className="field" key={field.name}>{field.label}{field.type === "textarea" ? <textarea name={field.name} required={field.required} rows={4} /> : field.type === "select" ? <select name={field.name} required={field.required}><option value="">Select…</option>{field.options?.map((option) => <option key={option}>{option}</option>)}</select> : <input name={field.name} type={field.type === "email" || field.type === "password" ? field.type : "text"} required={field.required} autoComplete={field.name === "password" ? "current-password" : undefined} />}</label>)}<button className="primary" disabled={loading}>{loading ? "Working…" : "Continue"}</button></form>}
    {screen.table && <section className="card table-card" aria-label={screen.table.entity + " records"}>{loading ? <p role="status">{screen.states.loading}</p> : rows.length === 0 ? <p className="empty">{screen.states.empty}</p> : <div className="table-scroll"><table><thead><tr>{screen.table.columns.map((column) => <th key={column} scope="col">{column.replaceAll("_", " ")}</th>)}<th scope="col">Actions</th></tr></thead><tbody>{rows.map((row, index) => <tr key={String(row.id ?? index)}>{screen.table!.columns.map((column) => <td key={column}>{column === "status" ? <span className={"status status-" + String(row[column]).toLowerCase()}>{screen.table?.statusLabels?.[String(row[column])] ?? String(row[column] ?? "—")}</span> : String(row[column] ?? "—")}</td>)}<td className="row-actions"><a href={detailRoute ? detailRoute.replace(/\\{[^}]+\\}/g, String(row.id)) : "#"} onClick={(event) => { event.preventDefault(); setSelected(row); if (detailRoute) navigate(detailRoute.replace(/\\{[^}]+\\}/g, String(row.id))); }}>{detailRoute ? "View" : "Select"}</a>{screen.actions.map((action) => <button key={action.operationId} className="inline-action" disabled={loading} onClick={() => void act(action, row)}>{action.label}</button>)}</td></tr>)}</tbody></table></div>}</section>}
    {screen.detailEntity && selected && <section className="card detail-card"><h2>Application details</h2><dl>{(screen.detailFields ?? Object.keys(selected)).filter((key) => key in selected).map((key) => <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{key === "status" ? screen.table?.statusLabels?.[String(selected[key])] ?? String(selected[key] ?? "—") : String(selected[key] ?? "—")}</dd></div>)}</dl><div className="actions">{screen.actions.map((action) => <button key={action.operationId} className={action.operationId.endsWith("approve") ? "primary" : "secondary"} disabled={loading} onClick={() => void act(action, selected)}>{action.label}</button>)}</div>{screen.relatedData?.map((related) => <section key={related.operationId}><h2>{related.title}</h2>{(relatedRows[related.operationId] ?? []).length === 0 ? <p>{screen.states.empty}</p> : <ol className="timeline">{relatedRows[related.operationId].map((item, index) => <li key={String(item.id ?? index)}>{related.columns.map((column) => <span key={column}><strong>{column === "action" ? String(item[column] ?? "—").replaceAll("_", " ") : String(item[column] ?? "—")}</strong> </span>)}</li>)}</ol>}</section>)}</section>}
    {!screen.form && !screen.table && !screen.detailEntity && <p className="card empty">{screen.states.empty}</p>}
    </main><footer>{screen.states.success}</footer></div>;
}
`;
  const styles = `:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#18231f;background:#f5f7f6;font-synthesis:none;text-rendering:optimizeLegibility}*{box-sizing:border-box}body{margin:0;min-width:320px}.app-shell{min-height:100vh;display:flex;flex-direction:column}.topbar{min-height:72px;background:#fff;border-bottom:1px solid #e2e9e5;display:flex;align-items:center;gap:32px;padding:0 clamp(18px,5vw,72px)}.brand{font-weight:750;color:#173e32;text-decoration:none;white-space:nowrap}.topbar nav{display:flex;gap:22px;flex:1}.topbar nav a,.row-actions a{color:#315d4e;text-decoration:none;font-weight:600}.account{display:flex;align-items:center;gap:14px;color:#5c6d65;font-size:.9rem}.page{width:min(1120px,100%);margin:0 auto;padding:48px 24px;flex:1}.page-heading{display:flex;justify-content:space-between;align-items:end;gap:20px;margin-bottom:25px}.eyebrow{margin:0 0 7px;color:#4c806b;text-transform:uppercase;letter-spacing:.1em;font-size:.74rem;font-weight:700}.page h1{font-size:clamp(1.8rem,4vw,2.6rem);line-height:1.1;margin:0;color:#193a30}.card{background:#fff;border:1px solid #e2e9e5;border-radius:16px;box-shadow:0 8px 28px #173e3209}.table-card{overflow:hidden}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;text-align:left}th,td{padding:15px 18px;border-bottom:1px solid #edf1ee;white-space:nowrap}th{font-size:.75rem;text-transform:uppercase;letter-spacing:.07em;color:#718077;background:#fafcfb}tbody tr:last-child td{border-bottom:0}.status{display:inline-flex;border-radius:99px;padding:5px 10px;font-size:.78rem;font-weight:700;background:#f1f3f2}.status-pending{color:#895c12;background:#fff4d8}.status-approved{color:#17633d;background:#e2f5e9}.status-rejected{color:#9b3434;background:#fde8e7}.row-actions{display:flex;align-items:center;gap:12px}.inline-action,.quiet{border:0;background:transparent;color:#315d4e;font:inherit;font-weight:650;cursor:pointer}.form-card{max-width:560px;padding:26px;display:grid;gap:18px}.field{display:grid;gap:7px;color:#42554b;font-size:.9rem;font-weight:650}input,textarea,select{width:100%;font:inherit;color:#18231f;background:#fff;border:1px solid #d5dfd9;border-radius:8px;padding:11px 12px}input:focus,textarea:focus,select:focus,button:focus-visible,a:focus-visible{outline:3px solid #a6d6bd;outline-offset:2px}.primary,.secondary{border:0;border-radius:8px;padding:11px 16px;font:inherit;font-weight:700;cursor:pointer}.primary{color:#fff;background:#267052}.secondary{color:#285740;background:#e8f2ec}.primary:disabled,.secondary:disabled{opacity:.55;cursor:wait}.notice{position:relative;padding:14px 44px 14px 16px;border-radius:9px;margin:0 0 18px}.error{color:#8d2929;background:#fcebea;border:1px solid #f3c7c4}.success{color:#175c39;background:#e4f5eb;border:1px solid #c1e8d0}.notice-close{position:absolute;right:12px;top:8px;border:0;background:none;font-size:1.3rem;cursor:pointer}.empty{padding:26px;color:#718077}.detail-card{margin-top:18px;padding:24px}.detail-card h2{font-size:1.05rem;margin:0 0 15px;color:#244f3f}.detail-card dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}.detail-card dl div{padding:12px;background:#f8faf9;border-radius:9px}.detail-card dt{text-transform:capitalize;color:#75827b;font-size:.78rem}.detail-card dd{margin:5px 0 0;font-weight:650}.actions{display:flex;gap:10px;margin-top:18px}.timeline{padding-left:20px}.timeline li{margin:12px 0}.timeline time{display:block;color:#77847d;font-size:.82rem;margin-top:3px}.filter-label{display:flex;gap:8px;align-items:center;color:#617168;font-size:.88rem}footer{padding:18px 24px;text-align:center;color:#79867f;font-size:.82rem;border-top:1px solid #e4ebe7;background:#fff}@media(max-width:700px){.topbar{flex-wrap:wrap;gap:12px;padding:15px 18px}.topbar nav{order:3;flex-basis:100%;overflow:auto;padding-top:6px}.account{margin-left:auto}.page{padding:32px 16px}.page-heading{align-items:start;flex-direction:column}.row-actions{gap:8px}th,td{padding:12px}.detail-card{padding:18px}}
`;
  const specFile = JSON.stringify(contract, null, 2) + "\n";
  return [
    { path: "frontend/ui-contract.v1.json", action: "create", content: specFile },
    { path: "frontend/src/App.tsx", action: "create", content: app },
    { path: "frontend/src/styles.css", action: "create", content: styles },
    { path: "frontend/src/vite-env.d.ts", action: "create", content: "/// <reference types=\"vite/client\" />\n" },
  ];
}
