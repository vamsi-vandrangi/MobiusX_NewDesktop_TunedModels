import type { Snapshot } from "@mobiusx/context-engine";

export interface ProjectState {
  path: string | null;
  snapshot: Snapshot | null;
  isGitRepo: boolean;
  /** Set once buildSemanticIndex() has run for the current project (Phase 2). */
  semanticIndexBuilt: boolean;
}

export const projectState: ProjectState = {
  path: null,
  snapshot: null,
  isGitRepo: false,
  semanticIndexBuilt: false,
};
