/**
 * Phase 5 (local-reference slice): regex-based secret detection.
 *
 * Two call sites use this, for two different reasons:
 *
 * - cloud-agent-gateway (taskEngine.ts) calls `scanAndRedact` on code
 *   snippets before they become part of a task's model context. This is
 *   the one governance boundary in this repo that IS fully enforceable:
 *   unlike the desktop terminal guard (advisory, reactive — see
 *   apps/desktop-agent/src/policy.ts), this code controls exactly what
 *   gets included in a request before it's ever sent anywhere, so a match
 *   here can be redacted with certainty before it leaves the machine.
 *
 * - desktop-agent (fsOps.ts#applyEdits) calls `scanForSecrets` (detect
 *   only, no rewrite) on AI-generated file content the user is about to
 *   approve writing to disk. Silently mutating content the user is
 *   reviewing would be dishonest, so a match there SKIPS that file (with
 *   a reason) for manual review instead of redacting it — see
 *   apps/desktop-agent/src/fsOps.ts.
 *
 * Either way this is still a plain regex scanner, not a real
 * secret-detection engine (no entropy scoring, no provider-specific
 * validation, no allowlisting) — it will miss unusual formats and can
 * false-positive on secret-shaped-but-fake strings (test fixtures,
 * placeholder examples). Treat it as a floor, not a guarantee.
 */

export interface SecretMatch {
  ruleId: string;
  description: string;
}

interface SecretRule {
  id: string;
  description: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { id: "aws-access-key", description: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { id: "anthropic-openai-style-key", description: "Anthropic/OpenAI-style secret key (sk-...)", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "github-token", description: "GitHub personal access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: "slack-token", description: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: "private-key-block", description: "PEM private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "generic-secret-assignment", description: "hardcoded password/secret/API key assignment", pattern: /(password|passwd|secret|api[_-]?key)\s*[:=]\s*['"][^'"\n]{6,}['"]/gi },
  { id: "jwt", description: "JWT-looking token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

export interface RedactionResult {
  text: string;
  matches: SecretMatch[];
}

/** Scans and redacts a piece of text in one pass. Each matched rule's hits are replaced with `[REDACTED:<rule-id>]` so nothing about the actual secret value survives into the returned text. */
export function scanAndRedact(text: string): RedactionResult {
  const matches: SecretMatch[] = [];
  let redacted = text;
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    const before = redacted;
    redacted = redacted.replace(re, `[REDACTED:${rule.id}]`);
    if (redacted !== before) matches.push({ ruleId: rule.id, description: rule.description });
  }
  return { text: redacted, matches };
}

/** Detect-only variant: reports matches without altering `text`. Used where rewriting the content isn't safe — see module doc above. */
export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const rule of SECRET_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags);
    if (re.test(text)) matches.push({ ruleId: rule.id, description: rule.description });
  }
  return matches;
}
