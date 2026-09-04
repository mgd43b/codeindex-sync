/**
 * Index providers.
 *
 * The whole point of this abstraction: adding support for a new indexing
 * backend should be *configuration*, not a code change. A provider is anything
 * that can answer "does this repo belong to me?", "index it", and "how are
 * you?" — whether it speaks MCP, shells out to a binary, or talks HTTP.
 *
 * Everything above this interface (queue, lock, worker, coalescing, hooks) is
 * backend-agnostic and must stay that way. If you find yourself importing a
 * specific backend's name into the worker, the abstraction has leaked.
 */

/** Why an index ran, which providers may use to pick a cheaper path. */
export type IndexReason = "hook" | "manual" | "retry";

export interface IndexRequest {
  repoPath: string;
  /** Force complete re-discovery rather than an incremental update. */
  full: boolean;
  reason: IndexReason;
  /** Abort signal so a hung backend can never wedge the queue. */
  signal?: AbortSignal;
}

export interface IndexOutcome {
  status: "ok" | "busy" | "failed";
  /** One-line human summary, e.g. "Added: 3, New chunks: 135". */
  summary: string;
  /** Set when the provider can report them; purely informational. */
  filesIndexed?: number;
  chunks?: number;
  /** Populated on failure; shown to the user verbatim. */
  error?: string;
}

export interface ProviderHealth {
  ok: boolean;
  /** Short label, e.g. "qdrant" or "embedding model". */
  component: string;
  detail: string;
  /** Actionable next step when !ok — this is most of the UX value. */
  remedy?: string;
}

export interface RepoStatus {
  /** Provider-native project identifier, if it has one. */
  projectId?: string;
  indexed: boolean;
  /** True when a previous run was interrupted and left a partial index. */
  incomplete?: boolean;
  files?: number;
  chunks?: number;
  lastIndexedAt?: string;
}

/**
 * The result of trying to drop one index.
 *
 * Not a boolean, because there are three outcomes and conflating them is how a
 * removal that did nothing gets reported as done: the backend can confirm the
 * index is gone, it can leave it there while cheerfully acknowledging the call,
 * or it can accept the call somewhere we have no way to check. Only the first
 * may be shown to a user as "removed".
 *
 * A union rather than an optional field, so the two outcomes a user has to act
 * on cannot be reported without saying why — an unexplained failure sends them
 * to the backend with nothing to go on.
 */
export type RemoveOutcome =
  | { status: "removed" }
  /** Accepted, but nothing available could confirm it. */
  | { status: "unverified"; detail: string }
  /** The tool errored, or the index is still listed afterwards. */
  | { status: "failed"; detail: string };

/** One index the backend holds, as it reports it. */
export interface IndexedProject {
  path: string;
  /** Backend-native collection/index name, when it reports one. */
  collection?: string;
  /** Verbatim, so a partial index can say "3437/2798" rather than a wrong number. */
  files?: string;
  lastIndexedAt?: string;
  /** A previous run was interrupted; only a full reindex clears it. */
  incomplete?: boolean;
}

export interface IndexProvider {
  /** Stable id used in config and CLI output. */
  readonly name: string;
  /** One line shown by `doctor` and `providers`. */
  readonly description: string;

  /**
   * Can this provider index the given repo? Used to route a job when several
   * providers are configured. Cheap and synchronous-ish: no network.
   */
  detect(repoPath: string): Promise<boolean>;
  /**
   * Every project the backend holds an index for, or null when it cannot say.
   * Optional: powers `list --all` and `cleanup`, both of which degrade to a
   * clear "unsupported" message rather than guessing.
   */
  projects?(): Promise<IndexedProject[] | null>;
  /**
   * Drop one index, and confirm it is actually gone.
   *
   * A tool reply is not evidence: a backend that cannot resolve the index — its
   * directory is deleted by the time `cleanup` runs, by definition — may delete
   * nothing and still answer without an error. Implementations must check the
   * backend's own listing before reporting "removed".
   *
   * Optional; `cleanup --apply` requires it.
   */
  remove?(repoPath: string): Promise<RemoveOutcome>;

  index(req: IndexRequest): Promise<IndexOutcome>;

  /** Backend reachability. Drives `doctor`; should never throw. */
  health(): Promise<ProviderHealth[]>;

  /** What the provider knows about a repo. Drives `list`. */
  status(repoPath: string): Promise<RepoStatus | null>;
}

/**
 * Registry. Providers are registered by name so config can reference them and
 * `doctor`/`providers` can enumerate them without importing implementations.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, IndexProvider>();

  register(provider: IndexProvider): this {
    if (this.providers.has(provider.name)) {
      throw new Error(`duplicate provider name: ${provider.name}`);
    }
    this.providers.set(provider.name, provider);
    return this;
  }

  get(name: string): IndexProvider | undefined {
    return this.providers.get(name);
  }

  all(): IndexProvider[] {
    return [...this.providers.values()];
  }

  /**
   * First provider claiming the repo, in registration order — so config order
   * is the tie-break and is therefore predictable to the user.
   */
  async resolve(repoPath: string): Promise<IndexProvider | undefined> {
    for (const p of this.providers.values()) {
      if (await p.detect(repoPath)) return p;
    }
    return undefined;
  }
}
