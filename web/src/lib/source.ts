/**
 * Which source a contract was built from, as its NEP-330 metadata says. A reproducible build names
 * the commit and the build image, so anyone can rebuild it and compare code hashes.
 */

export interface SourceMetadata {
  version?: string | null;
  link?: string | null;
  build_info?: {
    build_environment: string;
    build_command: string[];
    source_code_snapshot: string;
    contract_path?: string | null;
  } | null;
}

export interface Source {
  /** The account's code hash, or the shared global contract's. */
  codeHash: string;
  /** Present only for a reproducible build. */
  build: { repository: string; commit: string; path: string; environment: string } | null;
}

/** "git+https://github.com/o/r?rev=<40 hex>" into the repository and commit; null for anything else. */
export function parseSnapshot(snapshot: string): { repository: string; commit: string } | null {
  const match = /^git\+(https:\/\/[^\s?]+)\?rev=([0-9a-f]{40})$/.exec(snapshot);
  return match ? { repository: match[1]!.replace(/\.git$/, ""), commit: match[2]! } : null;
}

export function sourceOf(codeHash: string, metadata: SourceMetadata | null): Source {
  const info = metadata?.build_info;
  const snapshot = info ? parseSnapshot(info.source_code_snapshot) : null;
  return {
    codeHash,
    build: info && snapshot ? { ...snapshot, path: info.contract_path || ".", environment: info.build_environment } : null,
  };
}

/** A link to the commit's tree on GitHub, or to the repository elsewhere. */
export function commitLink(build: NonNullable<Source["build"]>): string {
  const path = build.path === "." ? "" : `/${build.path}`;
  return build.repository.startsWith("https://github.com/") ? `${build.repository}/tree/${build.commit}${path}` : build.repository;
}
