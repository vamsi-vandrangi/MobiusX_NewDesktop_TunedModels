import assert from "node:assert/strict";
import test from "node:test";
import { discoverTestApplicationTopology, testTopologyPromptSummary, validateGeneratedTestsAgainstTopology } from "../src/testTopology.js";

const appFiles = [
  { path: "backend/__init__.py", content: "" },
  { path: "backend/main.py", content: "from fastapi import FastAPI\napp = FastAPI()\n@ app.get('/health')\ndef health(): return {'ok': True}" },
  { path: "backend/database.py", content: "async def get_db():\n    yield None\n" },
  { path: "backend/models.py", content: "class Customer(Base):\n    __tablename__ = 'customers'\n    id = Column(Integer, primary_key=True)\n" },
  { path: "backend/schemas.py", content: "class LoginRequest(BaseModel):\n    username: str\n    password: str\n\nclass TokenResponse(BaseModel):\n    access_token: str\n" },
  { path: "backend/auth.py", content: "async def get_current_user():\n    return None\n" },
  { path: "backend/routes/__init__.py", content: "" },
  { path: "backend/routes/auth.py", content: "from backend.schemas import LoginRequest\n@router.post('/auth/login')\ndef login(payload: LoginRequest): return {}\n" },
  { path: "backend/routes/customers.py", content: "@router.get('/customers/{customer_id}')\ndef get(): pass" },
  { path: "frontend/ui-contract.v1.json", content: JSON.stringify({ routes: [
    { route: "/login/customer", title: "Customer sign in", form: { fields: [{ name: "username", label: "Username" }, { name: "password", label: "Password" }] } },
    { route: "/customer", title: "My records", actions: [] },
    { route: "/manager/{customer_id}", title: "Review", actions: [{ label: "Approve" }, { label: "Reject" }] },
  ] }) },
  { path: "frontend/src/App.tsx", content: "export default function App() { return <button>Sign out</button>; }\n" },
  { path: "frontend/package.json", content: JSON.stringify({ devDependencies: { "@playwright/test": "^1.55.0" } }) },
];

test("topology discovery resolves real FastAPI package, routes, UI routes and selected Playwright version", () => {
  const topology = discoverTestApplicationTopology(appFiles);
  assert.equal(topology.backend.entrypoint, "backend.main:app");
  assert.equal(topology.backend.packageRoot, "backend");
  assert.equal(topology.backend.databaseSessionModule, "backend.database");
  assert.deepEqual(topology.backend.ormModels, [{ module: "backend.models", className: "Customer", table: "customers" }]);
  assert.equal(topology.authentication.usernameField, "username");
  assert.equal(topology.authentication.passwordField, "password");
  assert.equal(topology.authentication.module, "backend.auth");
  assert.equal(topology.authentication.routeModule, "backend.routes.auth");
  assert.ok(topology.backend.modules.includes("backend.routes.customers"));
  assert.ok(topology.backend.routes.some((route) => route.path === "/customers/{customer_id}"));
  assert.deepEqual(topology.frontend.routes, ["/login/customer", "/customer", "/manager/{customer_id}"]);
  assert.equal(topology.frontend.playwrightPackage, "^1.55.0");
  assert.ok(topology.frontend.actions.includes("Sign out"));
  assert.match(testTopologyPromptSummary(topology), /backend\.main:app/);
});

test("test validation rejects nonexistent imports, routes, selectors and undefined fixtures", () => {
  const files = [...appFiles,
    { path: "backend/tests/conftest.py", content: "import pytest\n@pytest.fixture\ndef client(): return None\n" },
    { path: "backend/tests/test_generated.py", content: "from app.main import app\ndef test_bad(client, async_session): assert app\n" },
    { path: "frontend/e2e/generated.spec.ts", content: "import {test, expect} from '@playwright/test'; test('bad', async ({page}) => { await page.goto('/login'); await page.getByLabel('Email'); await page.getByRole('button', {name: 'Sign in'}); });" },
  ];
  const issues = validateGeneratedTestsAgainstTopology(files);
  assert.ok(issues.some((issue) => issue.includes("missing local package/module 'app.main'")));
  assert.ok(issues.some((issue) => issue.includes("undefined pytest fixture 'async_session'")));
  assert.ok(issues.some((issue) => issue.includes("unregistered frontend route '/login'")));
  assert.ok(issues.some((issue) => issue.includes("unknown accessible label 'Email'")));
  assert.ok(issues.some((issue) => issue.includes("unknown button name 'Sign in'")));
});

test("test validation checks symbols imported from existing local modules", () => {
  const files = [...appFiles,
    { path: "backend/tests/test_symbols.py", content: "from backend.main import get_db\ndef test_symbol(): assert get_db\n" },
  ];
  assert.ok(validateGeneratedTestsAgainstTopology(files).some((issue) => issue.includes("imports missing symbol 'get_db' from 'backend.main'")));
});

test("browser validation rejects endpoint and fixed password drift", () => {
  const files = [...appFiles, { path: "frontend/e2e/bad.spec.ts", content: "import {test} from '@playwright/test'; test('bad', async ({page}) => { await page.goto('/login/customer'); await page.fill('input[name=\"password\"]', 'fixed-password'); await page.request.post('/customers/1/unknown'); });" }];
  const issues = validateGeneratedTestsAgainstTopology(files);
  assert.ok(issues.some((issue) => issue.includes("unregistered API route '/customers/1/unknown'")));
  assert.ok(issues.some((issue) => issue.includes("embeds a fixed credential")));
});

test("test validation accepts actual application module imports and parameterized frontend routes", () => {
  const files = [...appFiles,
    { path: "backend/tests/conftest.py", content: "import pytest\n@pytest.fixture\ndef client(): return None\n" },
    { path: "backend/tests/test_generated.py", content: "from backend.main import app\ndef test_ok(client): assert app\n" },
    { path: "frontend/e2e/generated.spec.ts", content: "import {test, expect} from '@playwright/test'; test('ok', async ({page}) => { await page.goto('/manager/42'); await page.getByRole('button', {name: 'Approve'}); });" },
  ];
  assert.deepEqual(validateGeneratedTestsAgainstTopology(files), []);
});
