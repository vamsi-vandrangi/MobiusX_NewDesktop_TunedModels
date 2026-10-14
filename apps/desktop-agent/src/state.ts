import type { Snapshot } from "@mobiusx/context-engine";

/** Non-secret connection metadata for the currently-open remote project
 * (Phase D, "Connect via SSH") -- host/port/username/label only, never any
 * auth material. The live ssh2 Client + SFTPWrapper themselves live in
 * remoteConnection.ts's module-level `active` var, not here, same reason
 * projectState doesn't hold a filesystem handle for a local project either. */
export interface RemoteMeta {
  host: string;
  port: number;
  username: string;
  label: string | null;
}

export interface ProjectState {
  path: string | null;
  snapshot: Snapshot | null;
  isGitRepo: boolean;
  /** Set once buildSemanticIndex() has run for the current project (Phase 2). */
  semanticIndexBuilt: boolean;
  /** Phase D: true when the open "project" is actually a remote SSH/SFTP
   * target rather than a local folder -- see remoteConnection.ts and
   * remoteFsOps.ts. When true, `snapshot` is always null (remote trees are
   * listed fresh over SFTP on every /fs/tree call, not cached through
   * context-engine's local-fs-only reconcile()) and the /fs/*, /git/*, and
   * terminal routes branch to their SFTP/ssh-spawn implementations. */
  isRemote: boolean;
  remote: RemoteMeta | null;
}

export const projectState: ProjectState = {
  path: null,
  snapshot: null,
  isGitRepo: false,
  semanticIndexBuilt: false,
  isRemote: false,
  remote: null,
};
