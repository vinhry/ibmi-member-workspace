import * as path from "node:path";

/** The part of `vscode.Memento` the trust list needs, so it can be tested without VS Code. */
export interface TrustStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

const TRUSTED_KEY = "trustedRepositories";

/** Comparison key for a folder: macOS and Windows file systems ignore case. */
export function repositoryKey(folder: string, platform: NodeJS.Platform = process.platform): string {
  const resolved = platform === "win32" ? path.win32.resolve(folder) : path.posix.resolve(folder);
  return platform === "win32" || platform === "darwin" ? resolved.toLowerCase() : resolved;
}

/**
 * The Git repositories Local Change History may run in: ones it created, and ones the user chose
 * to use. A repository found in a system folder is otherwise untrusted, because a cloned or shared
 * folder can carry one whose settings make Git run programs. Kept per machine, not per workspace.
 */
export class RepositoryTrust {
  constructor(
    private readonly store: TrustStore,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  isTrusted(folder: string): boolean {
    return this.keys().includes(repositoryKey(folder, this.platform));
  }

  async trust(folder: string): Promise<void> {
    const key = repositoryKey(folder, this.platform);
    const keys = this.keys();
    if (!keys.includes(key)) {
      await this.store.update(TRUSTED_KEY, [...keys, key]);
    }
  }

  private keys(): string[] {
    const value = this.store.get<unknown>(TRUSTED_KEY, []);
    return Array.isArray(value) ? value.filter((key): key is string => typeof key === "string") : [];
  }
}
