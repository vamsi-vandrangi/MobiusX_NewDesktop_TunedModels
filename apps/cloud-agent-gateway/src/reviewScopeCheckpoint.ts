import { createHash } from "node:crypto";
import type { GenerationCheckpoint, ProposedEdit } from "@mobiusx/protocol";
import {
  appendCustomerPageResponseSchema,
  appendEntityCollectionReadOperation,
  appendEntityCreateOperation,
  appendEntityHistoryReadOperation,
  appendEntityRecordReadOperation,
  appendOperationRoute,
  createCustomerReadOperationContracts,
  type BusinessOperationSpec,
  type EntityCreateOperationSpec,
} from "./businessOperations.js";
import { ensureReviewScopeScaffold } from "./reviewScopeScaffold.js";
import type { ProjectArchitectureContract } from "@mobiusx/protocol";

const sha = (content: string) => createHash("sha256").update(content).digest("hex");
const pathKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();

/** Apply the explicitly approved additive PAC evolution to a completed checkpoint,
 * preserving stage history while creating new checksummed artifact versions. */
export function evolveReviewScopeCheckpoint(checkpoint: GenerationCheckpoint, architecture: ProjectArchitectureContract): GenerationCheckpoint {
  if (!architecture.reviewScope) throw new Error("evolved checkpoint requires PAC review-scope policy");
  const files = new Map(checkpoint.artifacts.map((artifact) => [pathKey(artifact.path), { ...artifact }]));
  const required = (path: string) => {
    const file = files.get(pathKey(path));
    if (!file) throw new Error(`review-scope checkpoint migration requires ${path}`);
    return file.content;
  };
  const put = (path: string, content: string) => {
    const old = files.get(pathKey(path));
    files.set(pathKey(path), { path, action: (old?.action ?? "create") as ProposedEdit["action"], content, sha256: sha(content) });
  };
  const scaffold = ensureReviewScopeScaffold({
    modelPath: "backend/models.py", modelSource: required("backend/models.py"),
    migrationPath: "backend/migrations/versions/0002_review_scopes.py", previousRevision: "0001_initial",
    migrationSource: files.get(pathKey("backend/migrations/versions/0002_review_scopes.py"))?.content,
  });
  for (const artifact of scaffold) put(artifact.path, artifact.content);
  let modelSource = required("backend/models.py");
  let schemaSource = appendCustomerPageResponseSchema(required("backend/schemas.py"));
  let routeSource = required("backend/routes/customers.py");

  let operations = checkpoint.businessOperations ?? [];
  const updateExisting = (operationId: string, transform: (value: Record<string, unknown>) => Record<string, unknown>) => {
    const saved = operations.find((record) => record.operationId === operationId);
    if (!saved) throw new Error(`review-scope checkpoint is missing operation ${operationId}`);
    const spec = transform(JSON.parse(saved.content) as Record<string, unknown>);
    spec.architectureHash = architecture.contractHash;
    const content = JSON.stringify(spec);
    operations = [...operations.filter((item) => item.operationId !== operationId), { operationId, architectureHash: architecture.contractHash, content, sha256: sha(content), createdAt: new Date().toISOString() }];
    put(`.mobiusx/operations/${operationId.replaceAll(".", "-")}.v2.json`, content);
    return spec;
  };
  updateExisting("customer.submit", (value) => value);
  const registration = updateExisting("customer.register", (value) => ({ ...value, scopeAssignment: "inherit-authenticated-customer" })) as unknown as EntityCreateOperationSpec;
  routeSource = appendEntityCreateOperation(routeSource, registration);
  for (const operationId of ["manager.approve", "manager.reject"]) {
    const spec = updateExisting(operationId, (value) => ({ ...value, managerScope: { userField: "review_scope_id", subjectField: "review_scope_id" } })) as unknown as BusinessOperationSpec;
    routeSource = appendOperationRoute(routeSource, spec);
  }

  const readContracts = createCustomerReadOperationContracts(architecture, modelSource, schemaSource);
  routeSource = appendEntityCollectionReadOperation(routeSource, readContracts.customerList);
  routeSource = appendEntityRecordReadOperation(routeSource, readContracts.customerDetail);
  routeSource = appendEntityHistoryReadOperation(routeSource, readContracts.auditHistory);
  for (const operation of Object.values(readContracts)) {
    const content = JSON.stringify(operation);
    operations = [...operations.filter((item) => item.operationId !== operation.operationId), {
      operationId: operation.operationId,
      architectureHash: architecture.contractHash,
      content,
      sha256: sha(content),
      createdAt: new Date().toISOString(),
    }];
    put(`.mobiusx/operations/${operation.operationId.replaceAll(".", "-")}.v2.json`, content);
  }
  put("backend/schemas.py", schemaSource);
  put("backend/routes/customers.py", routeSource);

  const stages = checkpoint.stages.map((stage) => ({ ...stage, artifacts: [...(stage.artifacts ?? [])] }));
  const upsertStageArtifact = (stageId: string, artifact: (typeof checkpoint.artifacts)[number]) => {
    const index = stages.findIndex((stage) => stage.id === stageId);
    if (index < 0) throw new Error(`review-scope checkpoint has no ${stageId} stage snapshot`);
    const stage = stages[index];
    const snapshot = [...(stage.artifacts ?? [])];
    const existing = snapshot.findIndex((item) => pathKey(item.path) === pathKey(artifact.path));
    if (existing >= 0) snapshot[existing] = artifact;
    else snapshot.push(artifact);
    stages[index] = { ...stage, artifacts: snapshot, artifactPaths: [...new Set(snapshot.map((item) => item.path))] };
  };
  const databaseStagePaths = new Set(["backend/models.py", "backend/migrations/versions/0002_review_scopes.py"]);
  for (const artifact of files.values()) {
    const path = pathKey(artifact.path);
    if (path === "backend/models.py" || path === "backend/migrations/versions/0002_review_scopes.py") upsertStageArtifact("database", artifact);
    else if (path === "backend/routes/customers.py" || path === "backend/schemas.py" || path.startsWith(".mobiusx/operations/")) upsertStageArtifact("transactions", artifact);
  }
  void databaseStagePaths;
  const aggregate = new Map<string, (typeof checkpoint.artifacts)[number]>();
  for (const stage of stages) for (const artifact of stage.artifacts ?? []) aggregate.set(pathKey(artifact.path), artifact);
  const allArtifacts = [...aggregate.values()].sort((a, b) => a.path.localeCompare(b.path));
  const updatedSubtasks = (subtasks: GenerationCheckpoint["databaseSubtasks"] | GenerationCheckpoint["backendSubtasks"]) => subtasks?.map((subtask) => ({
    ...subtask,
    architectureHash: architecture.contractHash,
    artifacts: subtask.artifacts.map((artifact) => files.get(pathKey(artifact.path)) ?? artifact).map((artifact) => ({ ...artifact, sha256: sha(artifact.content) })),
  }));
  const databaseSubtasks = updatedSubtasks(checkpoint.databaseSubtasks) ?? [];
  const modelAndMigration = [files.get(pathKey("backend/models.py"))!, files.get(pathKey("backend/migrations/versions/0002_review_scopes.py"))!];
  databaseSubtasks.push({ id: "review-scope-schema", completedAt: new Date().toISOString(), architectureHash: architecture.contractHash, artifacts: modelAndMigration });
  return {
    ...checkpoint,
    projectArchitecture: architecture,
    stages,
    artifacts: allArtifacts,
    databaseSubtasks,
    backendSubtasks: updatedSubtasks(checkpoint.backendSubtasks),
    businessOperations: operations,
    updatedAt: new Date().toISOString(),
  };
}
