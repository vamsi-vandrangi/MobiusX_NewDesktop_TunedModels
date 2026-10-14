import type { ProposedEdit } from "@mobiusx/protocol";

export interface ReviewScopeScaffoldInput {
  modelPath: string;
  modelSource: string;
  migrationPath: string;
  migrationSource?: string;
  previousRevision: string;
}

/** Deterministic additive SQLAlchemy/Alembic infrastructure for the PAC 1.1 scope relation. */
export function ensureReviewScopeScaffold(input: ReviewScopeScaffoldInput): ProposedEdit[] {
  const source = input.modelSource;
  if (!/^class\s+User\s*\(Base\)\s*:/m.test(source) || !/^class\s+Customer\s*\(Base\)\s*:/m.test(source)) {
    throw new Error("review-scope scaffold requires the PAC User and Customer SQLAlchemy models");
  }
  let model = source;
  const sqlalchemyImport = model.match(/^from sqlalchemy import ([^\n]+)$/m);
  if (!sqlalchemyImport) throw new Error("review-scope scaffold cannot find the SQLAlchemy import declaration");
  const imports = new Set(sqlalchemyImport[1].split(",").map((name) => name.trim()));
  for (const required of ["Column", "Integer", "String", "ForeignKey"]) imports.add(required);
  model = model.replace(sqlalchemyImport[0], `from sqlalchemy import ${[...imports].join(", ")}`);
  if (!/^from sqlalchemy\.orm import .*\brelationship\b/m.test(model)) {
    model = `from sqlalchemy.orm import relationship\n${model}`;
  }
  const addField = (className: string, beforeField: RegExp, lines: string[]) => {
    const classMatch = model.match(new RegExp(`^class ${className}\\s*\\(Base\\)\\s*:\\s*$`, "m"));
    if (!classMatch || classMatch.index === undefined) throw new Error(`review-scope scaffold cannot locate ${className}`);
    const nextClass = model.indexOf("\nclass ", classMatch.index + classMatch[0].length);
    const end = nextClass >= 0 ? nextClass : model.length;
    const block = model.slice(classMatch.index, end);
    if (/\breview_scope_id\s*=/.test(block)) return;
    const point = block.search(beforeField);
    const insertAt = point >= 0 ? classMatch.index + point : end;
    const addition = `${lines.join("\n")}\n`;
    model = `${model.slice(0, insertAt)}${addition}${model.slice(insertAt)}`;
  };
  addField("User", /^\s{4}(?:customers|audit_events)\s*=/m, [
    '    review_scope_id = Column(Integer, ForeignKey("review_scopes.id"), nullable=False, default=1, index=True)',
    '    review_scope = relationship("ReviewScope", back_populates="users")',
  ]);
  addField("Customer", /^\s{4}owner\s*=/m, [
    '    review_scope_id = Column(Integer, ForeignKey("review_scopes.id"), nullable=False, default=1, index=True)',
    '    review_scope = relationship("ReviewScope", back_populates="customers")',
  ]);
  if (!/^class ReviewScope\s*\(Base\)\s*:/m.test(model)) {
    model = `${model.trimEnd()}\n\nclass ReviewScope(Base):\n    __tablename__ = "review_scopes"\n\n    id = Column(Integer, primary_key=True, index=True)\n    name = Column(String, unique=True, nullable=False)\n    users = relationship("User", back_populates="review_scope")\n    customers = relationship("Customer", back_populates="review_scope")\n`;
  }
  if (!/^revision\s*=\s*["']0002_review_scopes["']/m.test(input.migrationSource ?? "") && input.migrationSource) {
    throw new Error("review-scope scaffold refuses to overwrite a non-matching migration artifact");
  }
  const migration = `"""Add explicit manager review scopes and backfill existing accounts."""\nfrom alembic import op\nimport sqlalchemy as sa\n\nrevision = "0002_review_scopes"\ndown_revision = ${JSON.stringify(input.previousRevision)}\nbranch_labels = None\ndepends_on = None\n\n\ndef upgrade() -> None:\n    op.create_table("review_scopes", sa.Column("id", sa.Integer(), primary_key=True), sa.Column("name", sa.String(), nullable=False, unique=True))\n    op.execute("INSERT INTO review_scopes (id, name) VALUES (1, 'default')")\n    op.execute("SELECT setval(pg_get_serial_sequence('review_scopes', 'id'), 1, true)")\n    op.add_column("users", sa.Column("review_scope_id", sa.Integer(), nullable=True))\n    op.create_foreign_key("fk_users_review_scope", "users", "review_scopes", ["review_scope_id"], ["id"])\n    op.execute("UPDATE users SET review_scope_id = 1 WHERE review_scope_id IS NULL")\n    op.alter_column("users", "review_scope_id", nullable=False, server_default="1")\n    op.create_index("ix_users_review_scope_id", "users", ["review_scope_id"])\n    op.add_column("customers", sa.Column("review_scope_id", sa.Integer(), nullable=True))\n    op.create_foreign_key("fk_customers_review_scope", "customers", "review_scopes", ["review_scope_id"], ["id"])\n    op.execute("UPDATE customers SET review_scope_id = COALESCE((SELECT users.review_scope_id FROM users WHERE users.id = customers.owner_id), 1) WHERE review_scope_id IS NULL")\n    op.alter_column("customers", "review_scope_id", nullable=False, server_default="1")\n    op.create_index("ix_customers_review_scope_id", "customers", ["review_scope_id"])\n    op.create_index("ix_customers_review_scope_status_created", "customers", ["review_scope_id", "status", "created_at"])\n\n\ndef downgrade() -> None:\n    op.drop_index("ix_customers_review_scope_status_created", table_name="customers")\n    op.drop_index("ix_customers_review_scope_id", table_name="customers")\n    op.drop_constraint("fk_customers_review_scope", "customers", type_="foreignkey")\n    op.drop_column("customers", "review_scope_id")\n    op.drop_index("ix_users_review_scope_id", table_name="users")\n    op.drop_constraint("fk_users_review_scope", "users", type_="foreignkey")\n    op.drop_column("users", "review_scope_id")\n    op.drop_table("review_scopes")\n`;
  return [
    { path: input.modelPath, action: "modify", content: model },
    { path: input.migrationPath, action: input.migrationSource ? "modify" : "create", content: migration },
  ];
}
