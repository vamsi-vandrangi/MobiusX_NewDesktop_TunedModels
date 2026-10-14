import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectArchitecture } from "../src/projectArchitecture.js";
import { renderReactUi } from "../src/reactUiRenderer.js";
import { createUiContractSkeleton, mergeUiContractContribution, validateUiContract, validateUiContractContribution, type UiContract, type UiOperation } from "../src/uiContract.js";
import { parseUiContributionResponse, validateTypeScriptSyntax } from "../src/buildPipeline.js";

const prompt = "Build a customer onboarding and manager approval application with customer dashboard, registration, status and audit history.";
const architecture = resolveProjectArchitecture(prompt);
const modelSource = `from backend.database import Base\nclass CustomerStatus(str, Enum):\n    PENDING = 'pending'\n    APPROVED = 'approved'\n    REJECTED = 'rejected'\nclass Customer(Base):\n    id = Column(Integer)\n    name = Column(String)\n    email = Column(String)\n    status = Column(Enum)\n    created_at = Column(DateTime)\n    owner_id = Column(Integer)\nclass AuditEvent(Base):\n    id = Column(Integer)\n    action = Column(String)\n    created_at = Column(DateTime)\n`;
const schemaSource = `class CustomerCreate(BaseModel):\n    name: str\n    email: str\nclass LoginRequest(BaseModel):\n    username: str\n    password: str\n`;
const operations = [
  { operationId: "auth.login", route: { method: "POST", path: "/auth/login" }, actor: { role: "public" }, requestFields: ["username", "password"], usernameField: "username", passwordField: "password", requestContentType: "application/json", responseContentType: "application/json", responseFields: ["access_token", "token_type"], sessionScheme: "bearer", tokenField: "access_token", tokenTypeField: "token_type", expirationSeconds: 900 },
  { operationId: "customer.register", operationKind: "entity-create", route: { method: "POST", path: "/customers" }, actor: { role: "customer" }, input: { bodySchema: "CustomerCreate" } },
  { operationId: "customer.listOwn", operationKind: "entity-collection-read", route: { method: "GET", path: "/customers" }, output: { entity: "Customer" }, actor: { customerRole: "customer", managerRole: "manager" } },
  { operationId: "customer.getOwn", operationKind: "entity-record-read", route: { method: "GET", path: "/customers/{customer_id}" }, output: { entity: "Customer" }, actor: { customerRole: "customer", managerRole: "manager" } },
  { operationId: "customer.submit", route: { method: "POST", path: "/customers/{customer_id}/submit" } },
  { operationId: "manager.listReviewQueue", operationKind: "entity-collection-read", route: { method: "GET", path: "/customers" }, output: { entity: "Customer" }, actor: { customerRole: "customer", managerRole: "manager" } },
  { operationId: "manager.getReviewable", operationKind: "entity-record-read", route: { method: "GET", path: "/customers/{customer_id}" }, output: { entity: "Customer" }, actor: { customerRole: "customer", managerRole: "manager" } },
  { operationId: "manager.approve", route: { method: "POST", path: "/customers/{customer_id}/approve" } },
  { operationId: "manager.reject", route: { method: "POST", path: "/customers/{customer_id}/reject" } },
  { operationId: "customer.audit.read", route: { method: "GET", path: "/customers/{customer_id}/audit" }, actor: { access: "owner-or-role", privilegedRole: "manager" }, output: { entity: "AuditEvent" } },
] as unknown as UiOperation[];
const state = { loading: "Loading verified records", empty: "No records yet", success: "Changes saved", error: "Could not load records" };
const access = { heading: true, labels: true, keyboard: true };
const contract: UiContract = {
  schemaVersion: "1.0", architectureHash: architecture.contractHash, title: "Customer Portal", apiBaseUrlEnv: "VITE_API_BASE_URL",
  routes: [
    { id: "customer-login", route: "/login", purpose: "Customer access", roles: ["public"], loginRole: "customer", title: "Customer sign in", form: { operationId: "auth.login", fields: [{ name: "username", label: "Username", type: "text", required: true }, { name: "password", label: "Password", type: "password", required: true }] }, actions: [], navigation: [{ label: "Customer sign in", route: "/login" }, { label: "Manager sign in", route: "/manager/login" }, { label: "My applications", route: "/customers" }], states: state, accessibility: access, responsive: true },
    { id: "manager-login", route: "/manager/login", purpose: "Manager access", roles: ["public"], loginRole: "manager", title: "Manager sign in", form: { operationId: "auth.login", fields: [{ name: "username", label: "Username", type: "text", required: true }, { name: "password", label: "Password", type: "password", required: true }] }, actions: [], navigation: [{ label: "Customer sign in", route: "/login" }, { label: "Manager sign in", route: "/manager/login" }], states: state, accessibility: access, responsive: true },
    { id: "customer-dashboard", route: "/customers", purpose: "Your applications", roles: ["customer"], title: "My applications", dataOperation: "customer.listOwn", table: { entity: "Customer", columns: ["id", "name", "status", "created_at"], filters: ["status"], filterOptions: { status: ["pending", "approved", "rejected"] } }, detailEntity: "Customer", actions: [{ label: "Submit", operationId: "customer.submit", confirm: true }], navigation: [{ label: "My applications", route: "/customers" }, { label: "Manager queue", route: "/manager" }], states: state, accessibility: access, responsive: true },
    { id: "customer-registration", route: "/register", purpose: "Start an application", roles: ["customer"], title: "Register a customer", form: { operationId: "customer.register", fields: [{ name: "name", label: "Business name", type: "text", required: true }, { name: "email", label: "Email", type: "email", required: true }] }, actions: [], navigation: [{ label: "My applications", route: "/customers" }, { label: "Register", route: "/register" }], states: state, accessibility: access, responsive: true },
    { id: "customer-detail", route: "/customers/{customer_id}", purpose: "Application status", roles: ["customer"], title: "Application details", dataOperation: "customer.getOwn", detailEntity: "Customer", relatedData: [{ title: "Activity history", operationId: "customer.audit.read", columns: ["action", "created_at"] }], actions: [{ label: "Submit", operationId: "customer.submit" }], navigation: [{ label: "My applications", route: "/customers" }], states: state, accessibility: access, responsive: true },
    { id: "manager-queue", route: "/manager", purpose: "Scoped review queue", roles: ["manager"], title: "Review applications", dataOperation: "manager.listReviewQueue", table: { entity: "Customer", columns: ["id", "name", "status"], filters: ["status"], filterOptions: { status: ["pending", "approved", "rejected"] } }, detailEntity: "Customer", actions: [{ label: "Approve", operationId: "manager.approve" }, { label: "Reject", operationId: "manager.reject", confirm: true }], navigation: [{ label: "Manager queue", route: "/manager" }, { label: "Customer sign in", route: "/login" }], states: state, accessibility: access, responsive: true },
    { id: "manager-detail", route: "/manager/customers/{customer_id}", purpose: "Review customer", roles: ["manager"], title: "Review application", dataOperation: "manager.getReviewable", detailEntity: "Customer", relatedData: [{ title: "Activity history", operationId: "customer.audit.read", columns: ["action", "created_at"] }], actions: [{ label: "Approve", operationId: "manager.approve" }, { label: "Reject", operationId: "manager.reject", confirm: true }], navigation: [{ label: "Review queue", route: "/manager" }], states: state, accessibility: access, responsive: true },
  ],
};

test("UI contract validates approved operation roles, entities, fields, and navigation", () => {
  const issues = validateUiContract(contract, architecture, operations, modelSource, schemaSource);
  assert.deepEqual(issues, []);
});

test("UI contract rejects unknown operation, wrong role, field, and transition target route", () => {
  const changed = structuredClone(contract);
  const dashboard = changed.routes.find((screen) => screen.id === "customer-dashboard")!;
  dashboard.dataOperation = "customer.listEverything";
  dashboard.actions[0].operationId = "manager.approve";
  dashboard.table!.columns.push("password_hash");
  dashboard.navigation.push({ label: "Missing", route: "/not-declared" });
  dashboard.table!.filterOptions!.status = ["not-a-domain-state"];
  const issues = validateUiContract(changed, architecture, operations, modelSource, schemaSource);
  assert.ok(issues.some((issue) => /unknown operation customer\.listEverything/.test(issue)));
  assert.ok(issues.some((issue) => /exposes manager\.approve to a screen without the customer role/.test(issue)));
  assert.ok(issues.some((issue) => /unknown Customer field password_hash/.test(issue)));
  assert.ok(issues.some((issue) => /undeclared route \/not-declared/.test(issue)));
  assert.ok(issues.some((issue) => /must use declared Customer domain states/.test(issue)));
});

test("UI contract rejects PAC mismatch and login fields not declared by backend schema", () => {
  const changed = structuredClone(contract);
  changed.architectureHash = "bad-hash";
  changed.routes[0].form!.fields.push({ name: "role", label: "Role", type: "text" });
  const issues = validateUiContract(changed, architecture, operations, modelSource, schemaSource);
  assert.ok(issues.some((issue) => /architectureHash/.test(issue)));
  assert.ok(issues.some((issue) => /not in the login request schema/.test(issue)));
});

test("React renderer emits API-backed, accessible Vite artifacts and valid TypeScript syntax", () => {
  const edits = renderReactUi(contract, operations);
  assert.deepEqual(edits.map((edit) => edit.path), ["frontend/ui-contract.v1.json", "frontend/src/App.tsx", "frontend/src/styles.css", "frontend/src/vite-env.d.ts"]);
  const source = edits.find((edit) => edit.path.endsWith("App.tsx"))!.content;
  assert.match(source, /fetch\(new URL/);
  assert.match(source, /Authorization/);
  assert.match(source, /data\?\.\[authOperation\.tokenField/);
  assert.match(source, /values\[authOperation\.usernameField/);
  assert.doesNotMatch(source, /data\?\.access_token|values\.username/, "login fields are read from the validated auth contract");
  assert.match(source, /customer\.audit\.read/);
  assert.match(source, /role="alert"/);
  assert.match(source, /filterOptions/);
  assert.match(source, /statusLabels\?\.\[String\(row\[column\]\)\]/);
  assert.doesNotMatch(source, /\["pending", "approved", "rejected"\]/, "the renderer uses UI-contract options instead of benchmark-specific states");
  assert.match(source, /routeParams\(screen\.route, path\)/, "detail requests use the contract route and operation rather than hard-coded paths");
  const files = new Map(edits.map((edit) => [edit.path, edit]));
  assert.deepEqual(validateTypeScriptSyntax(files), []);
});

test("compact model contribution parses, validates against the skeleton, merges and changes rendered output", () => {
  const skeleton = createUiContractSkeleton(architecture, operations, modelSource, schemaSource);
  const dashboard = skeleton.routes.find((screen) => screen.id === "customer-customer-dashboard")!;
  const raw = `\`\`\`json\n{"title":"My Onboarding Applications","columnOrder":["name","status","created_at"],"statusLabels":{"pending":"Pending Review","approved":"Approved","rejected":"Rejected"},"emptyState":"No onboarding applications found."}\n\`\`\``;
  const parsed = parseUiContributionResponse(raw);
  assert.ok(parsed.contribution);
  assert.deepEqual(validateUiContractContribution(parsed.contribution, skeleton, dashboard.id, architecture, modelSource, schemaSource), []);
  const merged = mergeUiContractContribution(skeleton, dashboard.id, parsed.contribution!);
  assert.deepEqual(validateUiContract(merged, architecture, operations, modelSource, schemaSource), []);
  const rendered = renderReactUi(merged, operations).find((edit) => edit.path.endsWith("App.tsx"))!.content;
  assert.match(rendered, /My Onboarding Applications/);
  assert.match(rendered, /Pending Review/);
  assert.match(rendered, /No onboarding applications found\./);
  assert.ok(merged.routes.find((screen) => screen.id === dashboard.id)!.table!.columns.indexOf("name") < merged.routes.find((screen) => screen.id === dashboard.id)!.table!.columns.indexOf("status"));
});

test("compact UI contribution rejects empty, malformed, invented and incomplete output", () => {
  assert.match(parseUiContributionResponse("").error ?? "", /empty/);
  assert.match(parseUiContributionResponse("{not json").error ?? "", /could not be parsed/);
  const skeleton = createUiContractSkeleton(architecture, operations, modelSource, schemaSource);
  const dashboard = skeleton.routes.find((screen) => screen.id === "customer-customer-dashboard")!;
  const invalid = {
    title: "Dashboard", columnOrder: ["password_hash"],
    statusLabels: { pending: "Pending", approved: "Approved", rejected: "Rejected", archived: "Archived" },
    emptyState: "No records", route: "/admin",
  };
  const issues = validateUiContractContribution(invalid, skeleton, dashboard.id, architecture, modelSource, schemaSource);
  assert.ok(issues.some((issue) => /unknown key route/.test(issue)));
  assert.ok(issues.some((issue) => /every skeleton column exactly once/.test(issue)));
  assert.ok(issues.some((issue) => /unknown Customer state archived/.test(issue)));
  assert.match(parseUiContributionResponse(JSON.stringify({ title: "x" })).error ?? "", /exactly these keys/);
});
