/**
 * The smallest Qdrant client that can answer "is this index intact?".
 *
 * This is the one place in the project that knows a storage engine's name, and
 * that is a deliberate, narrow exception rather than a drift in the design.
 * Every other command drives a backend through MCP tools it declares; integrity
 * checking has no such tool to call — the question "which files does this index
 * claim to hold, and which of them actually have content?" is answerable only
 * from storage. `verify` therefore reaches past the backend, and pays for it by
 * being the only feature that is not backend-agnostic.
 *
 * Three constraints shape what is here, each from a failure rather than taste:
 *
 *  - **`fetch`, not a client library.** `@qdrant/js-client-rest` fails on Node
 *    26 (the undici release it pulls in), which is a version this tool has to
 *    keep working on. A dependency that breaks on a future runtime is a poor
 *    trade for the four endpoints used here, and the project's two-dependency
 *    footprint is worth keeping.
 *  - **`scroll`, never `facet`.** Faceting a payload key looks like exactly the
 *    right tool for "distinct paths", but it takes a limit and offers no
 *    cursor: on a repo-sized collection it truncates and says nothing about it.
 *    A verifier that silently sees a subset reports missing files that are
 *    present, which is worse than not checking at all.
 *  - **The API key is never logged.** It reaches the process from a config file
 *    and must not turn up in an error message, so failures quote the status and
 *    the endpoint, never the request headers.
 */

/** Where the index actually lives. */
export interface QdrantConfig {
  /** Base URL, no trailing slash. */
  url: string;
  apiKey?: string;
  /** Namespaces collections when several backends share one Qdrant. */
  prefix: string;
}

/**
 * Read connection details from a provider's `env` block, falling back to the
 * ambient environment.
 *
 * The config file wins because it is the file the indexer itself is spawned
 * with: git hooks are not a login shell, so what is in that block is what
 * actually wrote the index. An exported shell variable may well point somewhere
 * else entirely, and checking a store nothing writes to would report an empty
 * index as catastrophic damage.
 */
export function resolveQdrantConfig(
  providerEnv: Record<string, string> | undefined,
  ambient: Record<string, string | undefined> = process.env,
): QdrantConfig | null {
  const pick = (key: string): string | undefined => providerEnv?.[key] ?? ambient[key];
  const url = pick("QDRANT_URL")?.trim();
  if (!url) return null;
  const apiKey = pick("QDRANT_API_KEY")?.trim();
  const prefix = pick("QDRANT_COLLECTION_PREFIX") ?? "";
  // Taken verbatim, and validated rather than tidied. The backend prepends this
  // to a collection name unchanged and rejects anything outside this character
  // set at startup, so trimming here would be worse than not: a prefix with a
  // stray space would pass, name a collection that cannot exist, and the whole
  // index would read as missing. Rejecting it says what is actually wrong.
  if (prefix && !/^[A-Za-z0-9_-]+$/.test(prefix)) {
    throw new QdrantError(
      `QDRANT_COLLECTION_PREFIX is not a usable collection-name prefix: ${JSON.stringify(prefix)}`,
    );
  }
  return {
    url: url.replace(/\/+$/, ""),
    ...(apiKey ? { apiKey } : {}),
    prefix,
  };
}

export class QdrantError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QdrantError";
  }
}

/** What a collection reports about itself. */
export interface CollectionInfo {
  /** Qdrant's own health word: "green", "yellow", "red". */
  status: string;
  points: number;
}

export interface ScrollPage {
  /** Payloads, trimmed to the keys asked for. */
  payloads: Record<string, unknown>[];
  /** Cursor for the next page; null at the end. */
  next: unknown;
}

const DEFAULT_PAGE = 1_000;

export class Qdrant {
  constructor(
    private readonly cfg: QdrantConfig,
    private readonly timeoutMs = 30_000,
  ) {}

  /** The metadata collection this instance keeps its per-project state in. */
  get metadataCollection(): string {
    return `${this.cfg.prefix}socraticode_metadata`;
  }

  get prefix(): string {
    return this.cfg.prefix;
  }

  get endpoint(): string {
    return this.cfg.url;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const url = `${this.cfg.url}${route}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { "api-key": this.cfg.apiKey } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      // Note what is quoted: the endpoint, never the headers.
      throw new QdrantError(
        `${method} ${route} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new QdrantError(`${method} ${route} \u2192 ${res.status} ${detail}`.trim(), res.status);
    }
    return (await res.json()) as T;
  }

  /** null when the collection does not exist — a normal answer, not an error. */
  async collection(name: string): Promise<CollectionInfo | null> {
    try {
      const res = await this.request<{
        result?: { status?: string; points_count?: number };
      }>("GET", `/collections/${encodeURIComponent(name)}`);
      return {
        status: res.result?.status ?? "unknown",
        points: res.result?.points_count ?? 0,
      };
    } catch (err) {
      if (err instanceof QdrantError && err.status === 404) return null;
      throw err;
    }
  }

  /** One point's payload, or null when it is not there. */
  async point(collection: string, id: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.request<{ result?: { payload?: Record<string, unknown> }[] }>(
        "POST",
        `/collections/${encodeURIComponent(collection)}/points`,
        { ids: [id], with_payload: true, with_vector: false },
      );
      return res.result?.[0]?.payload ?? null;
    } catch (err) {
      if (err instanceof QdrantError && err.status === 404) return null;
      throw err;
    }
  }

  /** One page of a scroll. Exposed so pagination itself can be tested. */
  async scrollPage(
    collection: string,
    include: string[],
    offset: unknown,
    limit: number,
  ): Promise<ScrollPage> {
    const res = await this.request<{
      result?: { points?: { payload?: Record<string, unknown> }[]; next_page_offset?: unknown };
    }>("POST", `/collections/${encodeURIComponent(collection)}/points/scroll`, {
      limit,
      ...(offset === undefined || offset === null ? {} : { offset }),
      // Only the keys being read come back. Payloads carry whole chunks of
      // source, so pulling them across the wire to throw them away would make
      // verifying a large repo cost more than indexing it.
      with_payload: { include },
      with_vector: false,
    });
    return {
      payloads: (res.result?.points ?? []).map((p) => p.payload ?? {}),
      next: res.result?.next_page_offset ?? null,
    };
  }

  /**
   * Page a scroll to exhaustion.
   *
   * A partial answer here is indistinguishable from real damage: unseen points
   * look exactly like files with no content. A cursor that fails to advance
   * would loop forever, so a repeated offset is treated as a broken server
   * rather than an end condition — stopping there would quietly report a
   * subset, which is the outcome this whole function exists to prevent.
   */
  async scrollAll(
    collection: string,
    include: string[],
    pageSize = DEFAULT_PAGE,
  ): Promise<{ payloads: Record<string, unknown>[]; pages: number }> {
    const payloads: Record<string, unknown>[] = [];
    const seen = new Set<string>();
    let offset: unknown = undefined;
    let pages = 0;
    for (;;) {
      const page = await this.scrollPage(collection, include, offset, pageSize);
      pages++;
      payloads.push(...page.payloads);
      if (page.next === null || page.next === undefined) return { payloads, pages };
      const cursor = JSON.stringify(page.next);
      if (seen.has(cursor)) {
        throw new QdrantError(
          `scroll of ${collection} repeated its cursor after ${pages} page(s); refusing to report a partial listing`,
        );
      }
      seen.add(cursor);
      offset = page.next;
    }
  }

  /** Every distinct value of one payload key across a collection. */
  async distinct(
    collection: string,
    key: string,
    pageSize = DEFAULT_PAGE,
  ): Promise<{ values: Set<string>; pages: number }> {
    const { payloads, pages } = await this.scrollAll(collection, [key], pageSize);
    const values = new Set<string>();
    for (const p of payloads) {
      const v = p[key];
      if (typeof v === "string" && v) values.add(v);
    }
    return { values, pages };
  }

  /**
   * Merge keys into one point's payload.
   *
   * `set_payload` rather than a full upsert on purpose: an upsert must carry a
   * vector, and reconstructing one for a point written by another program is a
   * good way to corrupt the thing being repaired. `wait=true` because the next
   * thing a user does is re-run verify, and an eventually-consistent write
   * would make the fix look like it failed.
   */
  async setPayload(
    collection: string,
    id: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.request("POST", `/collections/${encodeURIComponent(collection)}/points/payload?wait=true`, {
      payload,
      points: [id],
    });
  }
}
