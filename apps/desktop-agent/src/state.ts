import type { Snapshot } from "@mobiusx/context-engine";

export interface ProjectState {
  path: string | null;
  snapshot: Snapshot | null;
  isGitRepo: boolean;
}

export const projectState: ProjectState = {
  path: null,
  snapshot: null,
  isGitRepo: false,
};
