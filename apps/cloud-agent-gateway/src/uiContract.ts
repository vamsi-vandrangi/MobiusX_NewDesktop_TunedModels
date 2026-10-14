import type { ProjectArchitectureContract } from "@mobiusx/protocol";
import { extractBusinessDomainCatalog, type BusinessOperationContract, type EntityCollectionReadOperationSpec, type EntityCreateOperationSpec, type EntityHistoryReadOperationSpec, type EntityRecordReadOperationSpec } from "./businessOperations.js";

export interface UiContractField {
  name: string;
  label: string;
  type: "text" | "email" | "password" | "textarea" | "select";
  required?: boolean;
  options?: string[];
}

export interface UiContractScreen {
  id: string;
  route: string;
  purpose: string;
  roles: Array<"public" | "customer" | "manager">;
  title: string;
  /** UI navigation hint only; the backend remains the authority for role checks. */
  loginRole?: "customer" | "manager";
  dataOperation?: string;
  form?: { operationId: string; fields: UiContractField[]; navigateTo?: string };
  table?: { entity: string; columns: string[]; filters?: string[]; filterOptions?: Record<string, string[]>; statusLabels?: Record<string, string> };
  detailEntity?: string;
  detailFields?: string[];
  relatedData?: Array<{ title: string; operationId: string; columns: string[] }>;
  actions: Array<{ label: string; operationId: string; confirm?: boolean; navigateTo?: string }>;
  navigation: Array<{ label: string; route: string }>;
  states: { loading: string; empty: string; success: string; error: string };
  accessibility: { heading: boolean; labels: boolean; keyboard: boolean };
  responsive: boolean;
}

export interface UiContract {
  schemaVersion: "1.0";
  architectureHash: string;
  title: string;
  apiBaseUrlEnv: "VITE_API_BASE_URL";
  routes: UiContractScreen[];
}

export type UiOperation = BusinessOperationContract | EntityCollectionReadOperationSpec | EntityRecordReadOperationSpec | EntityHistoryReadOperationSpec | {
  operationId: "auth.login";
  route: { method: "POST"; path: string };
  actor: { role: "public" };
  requestFields: string[];
  usernameField: string;
  passwordField: string;
  requestContentType: "application/json";
  responseContentType: "application/json";
  responseFields: string[];
  sessionScheme: "bearer";
  tokenField: string;
  tokenTypeField: string;
  expirationSeconds: number;
};

/** A small model-authored presentation choice merged into a validated UI skeleton. */
export interface UiContractContribution {
  title: string;
  columnOrder: string[];
  statusLabels: Record<string, string>;
  emptyState: string;
}

/** Build a safe UI contract shell from approved operations and backend metadata. */
export function createUiContractSkeleton(
  architecture: ProjectArchitectureContract,
  operations: UiOperation[],
  modelSource: string,
  schemaSource: string,
): UiContract {
  const catalog = extractBusinessDomainCatalog(architecture, modelSource, schemaSource, ["customer", "manager"], operations.map((operation) => operation.operationId));
  const login = operations.find((operation) => operation.operationId === "auth.login");
  if (!login || !("requestFields" in login) || login.requestContentType !== "application/json" || login.responseContentType !== "application/json" || login.sessionScheme !== "bearer" || !login.responseFields.includes(login.tokenField)) throw new Error("UI skeleton requires the complete approved auth.login request/response and session schema");
  const roles = [...new Set(operations.flatMap((operation) => {
    const actor = "actor" in operation ? operation.actor as Record<string, unknown> : {};
    return [actor.role, actor.customerRole, actor.managerRole, actor.privilegedRole].filter((role): role is string => typeof role === "string" && ["customer", "manager"].includes(role));
  }))];
  const states = { loading: "Loading your records…", empty: "No records are available yet.", success: "Your changes were saved.", error: "We could not load this screen. Please try again." };
  const accessibility = { heading: true, labels: true, keyboard: true };
  const screens: UiContractScreen[] = roles.map((role) => {
    const screen: UiContractScreen = {
      id: `${role}-login`, route: `/login/${role}`, purpose: `${role[0].toUpperCase()}${role.slice(1)} access`, roles: ["public"],
      loginRole: role as "customer" | "manager", title: `${role[0].toUpperCase()}${role.slice(1)} sign in`,
      form: { operationId: "auth.login", fields: login.requestFields.map((name) => ({ name, label: name === login.usernameField ? (name === "email" ? "Email" : "Username") : name === login.passwordField ? "Password" : name, type: name === login.passwordField ? "password" : name === "email" ? "email" : "text", required: true })) },
      actions: [], navigation: [], states, accessibility, responsive: true,
    };
    return screen;
  });
  for (const role of roles) {
    const operation = operations.find((candidate) => candidate.operationId.startsWith(`${role}.`) && /(?:listOwn|listReviewQueue)$/.test(candidate.operationId) && candidate.route.method === "GET");
    if (!operation || !("output" in operation)) continue;
    const entity = operation.output.entity;
    const entityInfo = catalog.entities[entity];
    if (!entityInfo) continue;
    const preferred = ["name", "status", "created_at"];
    const columns = preferred.filter((field) => entityInfo.fields.includes(field));
    if (!columns.length) columns.push(...entityInfo.fields.filter((field) => !/password|owner|scope|token|secret/i.test(field)).slice(0, 4));
    if (!columns.length) continue;
    const statusStates = entityInfo.fields.includes("status") ? entityInfo.states ?? [] : [];
    screens.push({
      id: `${role}-${entity.toLowerCase()}-dashboard`, route: `/${role}`, purpose: `${role[0].toUpperCase()}${role.slice(1)} workspace`,
      roles: [role as "customer" | "manager"], title: role === "customer" ? `My ${entity} records` : `${entity} review queue`,
      dataOperation: operation.operationId,
      table: { entity, columns, ...(statusStates.length ? { filters: ["status"], filterOptions: { status: statusStates } } : {}) },
      actions: [], navigation: [], states, accessibility, responsive: true,
    });
  }
  if (!screens.some((screen) => screen.dataOperation && screen.roles.includes("customer"))) throw new Error("UI skeleton requires an approved customer collection-read operation");
  const createOperations = operations.filter((operation): operation is EntityCreateOperationSpec => "operationKind" in operation && operation.operationKind === "entity-create");
  for (const operation of createOperations) {
    const create = operation;
    const role = String((create.actor as Record<string, unknown>).role ?? "");
    const entity = create.output?.entity;
    if (typeof entity !== "string" || !entity) continue;
    const entityInfo = catalog.entities[entity];
    if (!(role === "customer" || role === "manager") || !entityInfo) continue;
    const bodyFields = new Set(create.input?.bodySchema ? schemaFieldsFromSource(schemaSource, create.input.bodySchema) : []);
    const fields = [...bodyFields].filter((field) => entityInfo.fields.includes(field) && !/password|owner|scope|token|secret|role/i.test(field));
    if (!fields.length) continue;
    const detail = screens.find((screen) => screen.roles.includes(role) && screen.detailEntity === entity);
    screens.push({
      id: `${role}-${entity.toLowerCase()}-register`, route: `/${role}/new`, purpose: `${entity} registration`, roles: [role],
      title: `Create ${entity.toLowerCase()} application`, form: { operationId: operation.operationId, fields: fields.map((name) => ({ name, label: name.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()), type: name === "email" ? "email" : "text", required: true })), ...(detail ? { navigateTo: detail.route } : {}) },
      actions: [], navigation: [], states: { ...states, empty: `Enter the ${entity.toLowerCase()} details to get started.` }, accessibility, responsive: true,
    });
  }
  for (const operation of operations) {
    if (!("operationKind" in operation) || operation.operationKind !== "entity-record-read") continue;
    const actor = operation.actor as Record<string, unknown>;
    const operationRole = operation.operationId.startsWith("manager.") ? "manager" : operation.operationId.startsWith("customer.") ? "customer" : undefined;
    const rolesForOperation = operationRole ? [operationRole] : typeof actor.role === "string" ? [actor.role] : [];
    const entity = operation.output.entity;
    const entityInfo = catalog.entities[entity];
    if (!entityInfo || !operation.route.path.includes("{")) continue;
    for (const role of rolesForOperation) {
      if (role !== "customer" && role !== "manager") continue;
      const route = `/${role}/${operation.route.path.split("/").filter(Boolean).at(-1)}`;
      if (screens.some((screen) => screen.route === route)) continue;
      const actions = operations.filter((candidate) => {
        if (!candidate.route.path.includes("{")) return false;
        if (!("output" in candidate)) return false;
        const candidateActor = candidate.actor as Record<string, unknown>;
        const candidateRole = String(candidateActor.role ?? candidateActor.customerRole ?? (candidate.operationId.startsWith("manager.") ? "manager" : "customer"));
        return candidateRole === role && candidate.output.entity === entity && candidate.route.path.split("/").at(-1) !== "audit" && candidate.route.method !== "GET";
      }).map((candidate) => ({ label: operationActionLabel(candidate.operationId), operationId: candidate.operationId, confirm: /approve|reject|delete/i.test(candidate.operationId) }));
      const history = operations.find((candidate) => "operationKind" in candidate && candidate.operationKind === "entity-history-read" && candidate.output.entity === "AuditEvent" && candidate.route.path.includes("{"));
      const relatedData = history ? [{ title: "Activity history", operationId: history.operationId, columns: ["action", "created_at"] }] : [];
      screens.push({
        id: `${role}-${entity.toLowerCase()}-detail`, route, purpose: `${entity} application details`, roles: [role],
        title: `${entity} application`, dataOperation: operation.operationId, detailEntity: entity,
        detailFields: entityInfo.fields.filter((field) => !/owner|scope|token|secret|password/i.test(field)),
        relatedData, actions, navigation: [], states, accessibility, responsive: true,
      });
    }
  }
  for (const screen of screens.filter((candidate) => candidate.form?.operationId && candidate.form.operationId !== "auth.login")) {
    const detail = screens.find((candidate) => candidate.detailEntity && candidate.roles.some((role) => screen.roles.includes(role)) && candidate.route.includes("{"));
    if (detail && screen.form) screen.form.navigateTo = detail.route;
  }
  for (const screen of screens) {
    screen.navigation = screen.roles.includes("public")
      ? screens.filter((candidate) => candidate.loginRole).map((candidate) => ({ label: candidate.title, route: candidate.route }))
      : screens.filter((candidate) => candidate.roles.some((role) => screen.roles.includes(role)) && !candidate.roles.includes("public")).map((candidate) => ({ label: candidate.title, route: candidate.route }));
  }
  return { schemaVersion: "1.0", architectureHash: architecture.contractHash, title: "Application Portal", apiBaseUrlEnv: "VITE_API_BASE_URL", routes: screens };
}

function schemaFieldsFromSource(source: string, schemaName: string): string[] {
  const match = source.match(new RegExp(`^class\\s+${schemaName}\\s*\\([^\\n]+\\):\\s*$`, "m"));
  if (!match || match.index === undefined) return [];
  const start = match.index + match[0].length;
  const next = source.slice(start).match(/^class\s+[A-Za-z_]\w*\s*\(/m);
  const body = source.slice(start, next?.index === undefined ? undefined : start + next.index);
  return [...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*:/gm)].map((item) => item[1]);
}

function operationActionLabel(operationId: string): string {
  const action = operationId.split(".").at(-1) ?? "Open";
  return action.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

const safeRoute = (path: string) => path.startsWith("/") && !path.includes("..") && !path.includes("//");

export function validateUiContract(value: unknown, architecture: ProjectArchitectureContract, operations: UiOperation[], modelSource = "", schemaSource = ""): string[] {
  const issues: string[] = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["UI contract must be a JSON object"];
  const spec = value as Partial<UiContract>;
  if (spec.schemaVersion !== "1.0") issues.push("unsupported UI contract schemaVersion; expected 1.0");
  if (spec.architectureHash !== architecture.contractHash) issues.push("UI contract architectureHash does not match the immutable PAC");
  if (!spec.title?.trim()) issues.push("UI contract requires an application title");
  if (spec.apiBaseUrlEnv !== "VITE_API_BASE_URL") issues.push("UI contract must use VITE_API_BASE_URL for its API origin");
  if (!Array.isArray(spec.routes) || !spec.routes.length) return [...issues, "UI contract must declare at least one route"];
  const opById = new Map(operations.map((operation) => [operation.operationId, operation]));
  const loginOperation = opById.get("auth.login");
  if (!loginOperation || !("requestFields" in loginOperation)) issues.push("auth.login operation is missing its request schema");
  else {
    if (!loginOperation.requestFields.length) issues.push("auth.login request schema has no fields");
    if (loginOperation.requestContentType !== "application/json") issues.push("auth.login request content type is incompatible with the generated FastAPI JSON body");
    if (loginOperation.responseContentType !== "application/json" || !loginOperation.responseFields.length) issues.push("auth.login response schema or content type is missing");
    if (loginOperation.sessionScheme !== "bearer" || !loginOperation.responseFields.includes(loginOperation.tokenField) || !Number.isInteger(loginOperation.expirationSeconds) || loginOperation.expirationSeconds <= 0) issues.push("auth.login session contract is unsupported or incomplete");
  }
  const catalog = extractBusinessDomainCatalog(architecture, modelSource, schemaSource, ["customer", "manager"], operations.map((operation) => operation.operationId));
  const schemaFields = (schemaName: string): Set<string> => {
    const schemaMatch = schemaSource.match(new RegExp(`^class\\s+${schemaName}\\s*\\([^\\n]+\\):\\s*$`, "m"));
    if (!schemaMatch || schemaMatch.index === undefined) return new Set();
    const next = schemaSource.slice(schemaMatch.index + schemaMatch[0].length).match(/^class\s+[A-Za-z_]\w*\s*\(/m);
    const body = schemaSource.slice(schemaMatch.index + schemaMatch[0].length, next?.index === undefined ? undefined : schemaMatch.index + schemaMatch[0].length + next.index);
    return new Set([...body.matchAll(/^\s{4}([A-Za-z_]\w*)\s*:/gm)].map((match) => match[1]));
  };
  const routeIds = new Set<string>();
  const paths = new Set<string>();
  for (const [index, raw] of spec.routes.entries()) {
    if (!raw || typeof raw !== "object") { issues.push(`routes[${index}] must be an object`); continue; }
    const screen = raw as UiContractScreen;
    if (!/^[a-z][a-z0-9-]*$/.test(screen.id ?? "")) issues.push(`routes[${index}] has an invalid screen id`);
    if (routeIds.has(screen.id)) issues.push(`duplicate screen id ${screen.id}`);
    routeIds.add(screen.id);
    if (!safeRoute(screen.route)) issues.push(`${screen.id} has an unsafe route`);
    if (paths.has(screen.route)) issues.push(`duplicate UI route ${screen.route}`);
    paths.add(screen.route);
    if (!screen.title?.trim() || !screen.purpose?.trim()) issues.push(`${screen.id} requires a title and purpose`);
    if (screen.loginRole && !["customer", "manager"].includes(screen.loginRole)) issues.push(`${screen.id} has an unsupported login role hint`);
    if (!Array.isArray(screen.roles) || !screen.roles.length || screen.roles.some((role) => !["public", "customer", "manager"].includes(role))) issues.push(`${screen.id} has an unknown or missing authorized role`);
    if (!Array.isArray(screen.actions) || !Array.isArray(screen.navigation)) issues.push(`${screen.id} must declare actions and navigation arrays`);
    const checkOperation = (operationId: string, location: string) => {
      const operation = opById.get(operationId);
      if (!operation) { issues.push(`${screen.id} ${location} references unknown operation ${operationId}`); return; }
      const actor = "actor" in operation ? operation.actor as Record<string, unknown> : {};
      const allowedRoles = operationId === "auth.login" ? ["public"]
        : actor.access === "owner-or-role" ? ["customer", String(actor.privilegedRole)]
          : Array.isArray(actor.customerRole) ? [String(actor.customerRole), String(actor.managerRole)]
            : typeof actor.role === "string" ? [actor.role]
              : [operationId.startsWith("manager.") ? "manager" : "customer"];
      for (const role of screen.roles.filter((item) => item !== "public")) {
        if (!allowedRoles.includes(role)) issues.push(`${screen.id} exposes ${operationId} to a screen without the ${role} role`);
      }
    };
    if (screen.dataOperation) {
      checkOperation(screen.dataOperation, "data source");
      const operation = opById.get(screen.dataOperation);
      if (operation && operation.route.method !== "GET") issues.push(`${screen.id} data source ${screen.dataOperation} is not a read operation`);
    }
    if (screen.form) {
      checkOperation(screen.form.operationId, "form");
      const operation = opById.get(screen.form.operationId);
      if (operation && operation.route.method !== "POST") issues.push(`${screen.id} form ${screen.form.operationId} is not a POST operation`);
      if (screen.form.operationId === "auth.login" && !screen.loginRole) issues.push(`${screen.id} login form must declare a customer or manager portal hint`);
      if (!screen.form.fields.length) issues.push(`${screen.id} form must declare fields`);
      const expectedFields = operation && "requestFields" in operation ? new Set(operation.requestFields) : operation && "operationKind" in operation && operation.operationKind === "entity-create" ? schemaFields(operation.input.bodySchema) : undefined;
      if (screen.form.operationId === "auth.login" && expectedFields && screen.form.fields.length !== expectedFields.size) issues.push(`${screen.id} login form must include every required request field exactly once`);
      for (const field of screen.form.fields) {
        if (!field.name || !field.label || !["text", "email", "password", "textarea", "select"].includes(field.type)) issues.push(`${screen.id} contains an invalid form field`);
        if (field.type === "select" && (!field.options?.length || field.options.some((option) => !option))) issues.push(`${screen.id}.${field.name} select requires explicit options`);
        if (expectedFields && !expectedFields.has(field.name)) issues.push(`${screen.id} form field ${field.name} is not in the login request schema`);
      }
      if (screen.form.navigateTo && !safeRoute(screen.form.navigateTo)) issues.push(`${screen.id} form has unsafe success navigation`);
    }
    if (screen.table) {
      if (!catalog.entities[screen.table.entity]) issues.push(`${screen.id} table uses unknown entity ${screen.table.entity}`);
      for (const field of screen.table.columns ?? []) if (!catalog.entities[screen.table.entity]?.fields.includes(field)) issues.push(`${screen.id} table uses unknown ${screen.table.entity} field ${field}`);
      for (const field of screen.table.filters ?? []) if (!catalog.entities[screen.table.entity]?.fields.includes(field) && !catalog.entities[screen.table.entity]?.states?.includes(field)) issues.push(`${screen.id} filter uses unknown ${screen.table.entity} field ${field}`);
      for (const [field, options] of Object.entries(screen.table.filterOptions ?? {})) {
        if (!screen.table.filters?.includes(field)) issues.push(`${screen.id} filter options are declared for unconfigured field ${field}`);
        const allowed = catalog.entities[screen.table.entity]?.states;
        if (!Array.isArray(options) || options.some((option) => !allowed?.includes(option))) issues.push(`${screen.id} filter options for ${field} must use declared ${screen.table.entity} domain states`);
      }
      for (const [state, label] of Object.entries(screen.table.statusLabels ?? {})) {
        if (!catalog.entities[screen.table.entity]?.states?.includes(state)) issues.push(`${screen.id} status label uses unknown ${screen.table.entity} domain state ${state}`);
        if (typeof label !== "string" || !label.trim()) issues.push(`${screen.id} status label for ${state} must be non-empty text`);
      }
    }
    if (screen.detailEntity && !catalog.entities[screen.detailEntity]) issues.push(`${screen.id} uses unknown detail entity ${screen.detailEntity}`);
    if (screen.detailFields) {
      if (!screen.detailEntity) issues.push(`${screen.id} declares detail fields without a detail entity`);
      for (const field of screen.detailFields) if (!catalog.entities[screen.detailEntity ?? ""]?.fields.includes(field)) issues.push(`${screen.id} uses unknown detail field ${field}`);
    }
    for (const related of screen.relatedData ?? []) {
      checkOperation(related.operationId, "related data source");
      const operation = opById.get(related.operationId);
      if (operation && operation.route.method !== "GET") issues.push(`${screen.id} related data ${related.operationId} is not a read operation`);
      const responseEntity = operation && "output" in operation ? (operation as { output: { entity: string } }).output.entity : undefined;
      if (responseEntity && !catalog.entities[responseEntity]) issues.push(`${screen.id} related data uses unknown entity ${responseEntity}`);
      for (const column of related.columns) if (!responseEntity || !catalog.entities[responseEntity]?.fields.includes(column)) issues.push(`${screen.id} related data uses unknown ${responseEntity ?? "response"} field ${column}`);
    }
    for (const action of screen.actions ?? []) {
      checkOperation(action.operationId, "action");
      const operation = opById.get(action.operationId);
      if (operation && operation.route.method === "GET") issues.push(`${screen.id} action ${action.operationId} cannot use a read operation`);
      if (action.navigateTo && !safeRoute(action.navigateTo)) issues.push(`${screen.id} action has unsafe navigation`);
    }
    for (const item of screen.navigation ?? []) if (!item.label?.trim() || !safeRoute(item.route)) issues.push(`${screen.id} has invalid navigation`);
    if (!screen.states || ["loading", "empty", "success", "error"].some((key) => !screen.states[key as keyof UiContractScreen["states"]]?.trim())) issues.push(`${screen.id} must define loading, empty, success and error states`);
    if (!screen.accessibility || !screen.accessibility.heading || !screen.accessibility.labels || !screen.accessibility.keyboard) issues.push(`${screen.id} must preserve headings, labels, and keyboard access`);
    if (screen.responsive !== true) issues.push(`${screen.id} must declare responsive layout support`);
  }
  for (const screen of spec.routes) for (const item of screen.navigation ?? []) if (!paths.has(item.route)) issues.push(`${screen.id} navigates to undeclared route ${item.route}`);
  for (const screen of spec.routes) if (screen.form?.navigateTo && !paths.has(screen.form.navigateTo)) issues.push(`${screen.id} form success navigation points to an undeclared route`);
  for (const screen of spec.routes) {
    if (!screen.table?.entity || !screen.detailEntity) continue;
    for (const role of screen.roles.filter((item) => item !== "public")) {
      if (!spec.routes.some((candidate) => candidate.detailEntity === screen.detailEntity && candidate.roles.includes(role) && candidate.route.includes("{"))) {
        issues.push(`${screen.id} declares row details but has no ${role}-authorized detail route`);
      }
    }
  }
  const securedRoles = new Set<string>();
  for (const operation of operations) {
    if (operation.operationId === "auth.login") continue;
    const actor = "actor" in operation ? operation.actor as Record<string, unknown> : {};
    if (typeof actor.role === "string") securedRoles.add(actor.role);
    if (typeof actor.customerRole === "string") securedRoles.add(actor.customerRole);
    if (typeof actor.managerRole === "string") securedRoles.add(actor.managerRole);
    if (actor.access === "owner-or-role") { securedRoles.add("customer"); if (typeof actor.privilegedRole === "string") securedRoles.add(actor.privilegedRole); }
  }
  const loginPortals = new Set<string | undefined>(spec.routes.filter((screen) => screen.form?.operationId === "auth.login").map((screen) => screen.loginRole));
  for (const role of securedRoles) if (!loginPortals.has(role)) issues.push(`UI contract has no auth.login screen for the ${role} role`);
  const backendRoutes = architecture.modules.filter((module) => module.path.startsWith("backend/routes/"));
  if (!backendRoutes.length || !modelSource.trim() || !schemaSource.trim()) issues.push("UI contract validation requires the PAC backend route, model and schema artifacts");
  return [...new Set(issues)];
}

/**
 * Validate the model's compact contribution against a deterministic screen skeleton.
 * The model may choose presentation, but cannot introduce routes, fields, roles,
 * operations, or domain states.
 */
export function validateUiContractContribution(
  value: unknown,
  contract: UiContract,
  screenId: string,
  architecture: ProjectArchitectureContract,
  modelSource = "",
  schemaSource = "",
): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["UI contribution must be a JSON object"];
  const contribution = value as Record<string, unknown>;
  const allowedKeys = new Set(["title", "columnOrder", "statusLabels", "emptyState"]);
  const issues = Object.keys(contribution).filter((key) => !allowedKeys.has(key)).map((key) => `UI contribution contains unknown key ${key}`);
  const screen = contract.routes.find((item) => item.id === screenId);
  if (!screen) return [...issues, `UI contribution targets unknown screen ${screenId}`];
  if (!screen.table) return [...issues, `UI contribution target ${screenId} has no table`];
  const textField = (key: "title" | "emptyState") => {
    const item = contribution[key];
    if (typeof item !== "string" || !item.trim() || item.length > 160) issues.push(`${key} must be non-empty text no longer than 160 characters`);
  };
  textField("title");
  textField("emptyState");
  const order = contribution.columnOrder;
  if (!Array.isArray(order) || order.some((item) => typeof item !== "string")) {
    issues.push("columnOrder must be an array of approved field names");
  } else {
    const baseline = screen.table.columns;
    if (new Set(order).size !== order.length || order.length !== baseline.length || baseline.some((field) => !order.includes(field))) {
      issues.push("columnOrder must contain every skeleton column exactly once");
    }
  }
  const catalog = extractBusinessDomainCatalog(architecture, modelSource, schemaSource, ["customer", "manager"], []);
  const states = catalog.entities[screen.table.entity]?.states ?? [];
  if (!contribution.statusLabels || typeof contribution.statusLabels !== "object" || Array.isArray(contribution.statusLabels)) {
    issues.push("statusLabels must be an object keyed by approved domain states");
  } else {
    const labels = contribution.statusLabels as Record<string, unknown>;
    for (const state of states) if (!(state in labels)) issues.push(`statusLabels is missing approved ${screen.table.entity} state ${state}`);
    for (const [state, label] of Object.entries(labels)) {
      if (!states.includes(state)) issues.push(`statusLabels contains unknown ${screen.table.entity} state ${state}`);
      if (typeof label !== "string" || !label.trim() || label.length > 60) issues.push(`status label for ${state} must be non-empty text no longer than 60 characters`);
    }
  }
  return [...new Set(issues)];
}

export function mergeUiContractContribution(contract: UiContract, screenId: string, contribution: UiContractContribution): UiContract {
  return {
    ...contract,
    routes: contract.routes.map((screen) => screen.id !== screenId || !screen.table ? screen : {
      ...screen,
      title: contribution.title,
      table: { ...screen.table, columns: [...contribution.columnOrder], statusLabels: { ...contribution.statusLabels } },
      states: { ...screen.states, empty: contribution.emptyState },
    }),
  };
}

export function uiContributionPrompt(contract: UiContract, screenId: string, domainStates: string[]): string {
  const screen = contract.routes.find((item) => item.id === screenId);
  if (!screen?.table) throw new Error(`Cannot generate UI contribution: ${screenId} is not a table screen`);
  return [
    "Return one compact JSON object only. Do not use markdown or code fences.",
    "Choose concise, useful presentation text and ordering for this existing screen. Do not add or rename fields, routes, roles, operations, or states.",
    `Screen: ${JSON.stringify({ id: screen.id, title: screen.title, route: screen.route, role: screen.roles, entity: screen.table.entity, columns: screen.table.columns, domainStates })}`,
    'Exact output keys: {"title": string, "columnOrder": string[], "statusLabels": {"<each domain state>": string}, "emptyState": string}.',
    "columnOrder must contain all approved columns exactly once. statusLabels must contain every approved domain state and no other keys.",
  ].join("\n\n");
}

export function uiContractPrompt(input: { architecture: ProjectArchitectureContract; operations: UiOperation[]; requirements: string; modelSource: string; schemaSource: string }): string {
  const allowedOperations = input.operations.map((operation) => ({ id: operation.operationId, method: operation.route.method, path: operation.route.path, role: operation.operationId.startsWith("manager.") ? "manager" : operation.operationId.startsWith("customer.") ? "customer" : "public" }));
  return [
    "Generate one versioned UI contract for this application. Do not generate source code.",
    "Return one MobiusX structured file edit at frontend/ui-contract.v1.json whose content is valid JSON only.",
    "Required shape: {schemaVersion:'1.0',architectureHash,title,apiBaseUrlEnv:'VITE_API_BASE_URL',routes:[{id,route,purpose,roles,title,loginRole?:'customer'|'manager',dataOperation?,form?:{operationId,fields:[{name,label,type,required?,options?}]},table?:{entity,columns,filters?,filterOptions?},detailEntity?,actions:[{label,operationId,confirm?,navigateTo?}],navigation:[{label,route}],states:{loading,empty,success,error},accessibility:{heading:true,labels:true,keyboard:true},responsive:true}]}.",
    "Use only the provided operation ids, roles, and entity fields. Every auth.login form needs a loginRole portal hint (customer or manager); this is navigation only and grants no server permission. Every screen must have explicit loading/empty/success/error copy. Provide functional login, customer-owned dashboard and registration, plus manager review queue/detail where supported. Include actions only when backed by an operation. Keep routes small and navigable. Do not invent endpoints or data.",
    `PAC: ${JSON.stringify({ schemaVersion: input.architecture.schemaVersion, architectureHash: input.architecture.contractHash, frontend: input.architecture.stack.frontend, modulePaths: input.architecture.modules.filter((module) => module.path.startsWith("frontend/")).map((module) => module.path) })}`,
    `Approved operations: ${JSON.stringify(allowedOperations)}`,
    `Approved model fields/enums: ${input.modelSource.slice(0, 2500)}`,
    `Approved request/response fields: ${input.schemaSource.slice(0, 1800)}`,
    `Requirements: ${input.requirements.slice(0, 1800)}`,
  ].join("\n\n");
}
