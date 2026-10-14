import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureReviewScopeScaffold } from "../src/reviewScopeScaffold.js";

const models = `from sqlalchemy import Column, Integer, String, ForeignKey\nfrom sqlalchemy.orm import relationship\nfrom backend.database import Base\n\nclass User(Base):\n    __tablename__ = "users"\n    id = Column(Integer, primary_key=True)\n    customers = relationship("Customer", back_populates="owner")\n\nclass Customer(Base):\n    __tablename__ = "customers"\n    id = Column(Integer, primary_key=True)\n    owner_id = Column(Integer, ForeignKey("users.id"))\n    owner = relationship("User", back_populates="customers")\n`;

test("review-scope scaffold is additive, checksummed as full artifacts, and idempotent", () => {
  const generated = ensureReviewScopeScaffold({ modelPath: "backend/models.py", modelSource: models, migrationPath: "backend/migrations/versions/0002_review_scopes.py", previousRevision: "0001_initial" });
  assert.match(generated[0].content, /review_scope_id = Column\(Integer, ForeignKey\("review_scopes\.id"\)/);
  assert.match(generated[0].content, /class ReviewScope\(Base\)/);
  assert.match(generated[1].content, /down_revision = "0001_initial"/);
  assert.match(generated[1].content, /setval\(pg_get_serial_sequence/);
  const again = ensureReviewScopeScaffold({ modelPath: "backend/models.py", modelSource: generated[0].content, migrationPath: "backend/migrations/versions/0002_review_scopes.py", migrationSource: generated[1].content, previousRevision: "0001_initial" });
  assert.equal(again[0].content, generated[0].content);
  assert.equal(again[1].content, generated[1].content);
  assert.throws(() => ensureReviewScopeScaffold({ modelPath: "backend/models.py", modelSource: models, migrationPath: "backend/migrations/versions/0002_review_scopes.py", migrationSource: "revision='other'", previousRevision: "0001_initial" }), /refuses to overwrite/);
});
