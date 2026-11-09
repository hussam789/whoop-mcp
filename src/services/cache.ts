import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

export interface CacheStatus extends Record<string, unknown> {
  enabled: boolean;
  path: string;
  entries: number;
  newest_cached_at?: string;
  oldest_cached_at?: string;
  max_age_days?: number;
  pruned_on_open?: number;
  http_cache?: {
    size: number;
    hit_count: number;
    miss_count: number;
    hit_rate: number;
    default_ttl_seconds: number;
    bypass_env_var: string;
  };
}

export class WhoopCache {
  private db: Database.Database;
  private prunedOnOpen = 0;

  constructor(private readonly path: string, private readonly maxAgeDays?: number) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_cache (
        cache_key TEXT PRIMARY KEY,
        method TEXT NOT NULL,
        url TEXT NOT NULL,
        payload TEXT NOT NULL,
        cached_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS api_cache_cached_at_idx ON api_cache(cached_at);
    `);
    if (maxAgeDays !== undefined) this.prunedOnOpen = this.prune(maxAgeDays);
  }

  get(method: string, url: string): unknown | undefined {
    const row = this.db.prepare("SELECT payload FROM api_cache WHERE cache_key = ?").get(cacheKey(method, url)) as { payload?: string } | undefined;
    if (!row?.payload) return undefined;
    try {
      return JSON.parse(row.payload);
    } catch {
      return undefined;
    }
  }

  set(method: string, url: string, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO api_cache (cache_key, method, url, payload, cached_at)
      VALUES (@cache_key, @method, @url, @payload, @cached_at)
      ON CONFLICT(cache_key) DO UPDATE SET
        payload = excluded.payload,
        cached_at = excluded.cached_at
    `).run({
      cache_key: cacheKey(method, url),
      method,
      url,
      payload: JSON.stringify(payload),
      cached_at: new Date().toISOString()
    });
  }

  /** Delete entries cached more than `maxAgeDays` ago; returns the number removed. */
  prune(maxAgeDays: number): number {
    // cached_at is an ISO-8601 UTC string, so lexical comparison orders by time.
    const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000).toISOString();
    return this.db.prepare("DELETE FROM api_cache WHERE cached_at < ?").run(cutoff).changes;
  }

  status(): CacheStatus {
    const row = this.db.prepare("SELECT COUNT(*) AS entries, MAX(cached_at) AS newest_cached_at, MIN(cached_at) AS oldest_cached_at FROM api_cache").get() as { entries: number; newest_cached_at?: string; oldest_cached_at?: string };
    return {
      enabled: true,
      path: this.path,
      entries: row.entries,
      newest_cached_at: row.newest_cached_at ?? undefined,
      oldest_cached_at: row.oldest_cached_at ?? undefined,
      max_age_days: this.maxAgeDays,
      pruned_on_open: this.maxAgeDays === undefined ? undefined : this.prunedOnOpen
    };
  }
}

export function disabledCacheStatus(path: string): CacheStatus {
  return { enabled: false, path, entries: 0 };
}

function cacheKey(method: string, url: string): string {
  return `${method.toUpperCase()} ${url}`;
}
