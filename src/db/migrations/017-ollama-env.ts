/**
 * Per-group container env overrides + blocked hosts.
 *
 * `env` is a JSON object of extra `KEY=VALUE` pairs emitted as `docker run -e`
 * for the group's container; `blocked_hosts` is a JSON array of hostnames
 * nulled out via `--add-host HOST:0.0.0.0`. Both are durable DB columns (not
 * hand-edited `container.json`, which is rewritten from the DB every spawn).
 *
 * Motivating use: routing one group to a local Ollama endpoint via a per-group
 * `ANTHROPIC_BASE_URL`, independent of the install-wide `.env`, so mixed
 * installs (one cloud group + one local group) work. Additive, behavior-neutral
 * until a group sets a value.
 */
import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration017: Migration = {
  version: 17,
  name: 'ollama-env',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]';
    `);
  },
};
