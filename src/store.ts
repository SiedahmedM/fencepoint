import { DatabaseSync } from "node:sqlite";
import { FencepointError, StorageError } from "./errors.js";
import type { EffectState, Resolution } from "./types.js";

export interface Row {
  intent_key: string;
  body: string;
  digest: string;
  phase: EffectState;
  generation: number;
  holder: string | null;
  deadline: number | null;
  admission_time: number | null;
  outcome: Resolution | null;
  outcome_data: string | null;
  born: number;
  changed: number;
}

export function sqliteSupported(version: string): boolean {
  const [major, minor, patch] = version.split(".").map(Number);
  return major === 3 && (minor! > 51 || (minor === 51 && patch! >= 3)
    || (minor === 50 && patch! >= 7) || (minor === 44 && patch! >= 6));
}

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string, private readonly clock: () => number) {
    this.db = new DatabaseSync(path);
    try {
      const { version } = this.db.prepare("SELECT sqlite_version() AS version").get()!;
      if (!sqliteSupported(String(version))) throw new StorageError("SQLite requires the WAL-reset fix", { version: String(version) });
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA trusted_schema=OFF;");
      // Refuse unrelated databases before changing their persistent journal mode.
      this.checkIdentity();
      const mode = this.enableWal();
      if (mode.journal_mode !== "wal" && path !== ":memory:") throw new StorageError("WAL is required for file databases");
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
        const application = this.db.prepare("PRAGMA application_id").get()!.application_id;
        const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all();
        if (version === 0 && application === 0 && tables.length === 0) {
          this.db.exec(`
            CREATE TABLE fp_clock (singleton INTEGER PRIMARY KEY CHECK(singleton=1), tick INTEGER NOT NULL) STRICT;
            INSERT INTO fp_clock VALUES (1, 0);
            CREATE TABLE fp_intents (
              intent_key TEXT PRIMARY KEY,
              body TEXT NOT NULL,
              digest TEXT NOT NULL,
              phase TEXT NOT NULL CHECK(phase IN ('pending','claimed','admitted','retryable','committed','ambiguous')),
              generation INTEGER NOT NULL CHECK(generation>=0),
              holder TEXT,
              deadline INTEGER,
              admission_time INTEGER,
              outcome TEXT CHECK(outcome IN ('committed','ambiguous','pre_effect_failure','cancelled')),
              outcome_data TEXT,
              born INTEGER NOT NULL,
              changed INTEGER NOT NULL
            ) STRICT;
            PRAGMA application_id=0x46504e54;
            PRAGMA user_version=1;
          `);
        } else if (version !== 1 || application !== 0x46504e54) {
          throw new StorageError("Not a supported Fencepoint database");
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private enableWal() {
    const deadline = performance.now() + 5000;
    const pause = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      try {
        return this.db.prepare("PRAGMA journal_mode=WAL").get()!;
      } catch (error) {
        // Concurrent first opens can hit a lock upgrade that bypasses busy_timeout.
        if (!(error instanceof Error) || !("errcode" in error)
          || error.errcode !== 5 || performance.now() >= deadline) throw error;
        Atomics.wait(pause, 0, 0, 10);
      }
    }
  }

  private checkIdentity(): void {
    this.db.exec("BEGIN");
    try {
      const version = this.db.prepare("PRAGMA user_version").get()!.user_version;
      const application = this.db.prepare("PRAGMA application_id").get()!.application_id;
      const objects = this.db.prepare("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
      if (!(version === 0 && application === 0 && objects.length === 0)
        && !(version === 1 && application === 0x46504e54)) {
        throw new StorageError("Not a supported Fencepoint database");
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  read(key: string): Row | undefined {
    return this.db.prepare("SELECT * FROM fp_intents WHERE intent_key=?").get(key) as unknown as Row | undefined;
  }

  insert(key: string, body: string, digest: string, now: number): void {
    this.db.prepare(`INSERT INTO fp_intents
      (intent_key,body,digest,phase,generation,born,changed) VALUES (?,?,?,'pending',0,?,?)`)
      .run(key, body, digest, now, now);
  }

  save(row: Row): void {
    this.db.prepare(`UPDATE fp_intents SET phase=?,generation=?,holder=?,deadline=?,admission_time=?,
      outcome=?,outcome_data=?,changed=? WHERE intent_key=?`)
      .run(row.phase, row.generation, row.holder, row.deadline, row.admission_time,
        row.outcome, row.outcome_data, row.changed, row.intent_key);
  }

  write<T>(action: (now: number) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const sampled = this.clock();
      if (!Number.isSafeInteger(sampled) || sampled < 0) throw new RangeError("Clock must return nonnegative safe integer milliseconds");
      const now = Math.max(sampled, Number(this.db.prepare("SELECT tick FROM fp_clock WHERE singleton=1").get()!.tick));
      this.db.prepare("UPDATE fp_clock SET tick=? WHERE singleton=1").run(now);
      // Rejections still remember observed time, so expired authority cannot revive.
      this.db.exec("SAVEPOINT transition");
      let result: T;
      try {
        result = action(now);
      } catch (error) {
        if (!(error instanceof FencepointError || error instanceof RangeError || error instanceof TypeError)) throw error;
        this.db.exec("ROLLBACK TO transition; RELEASE transition; COMMIT");
        throw error;
      }
      this.db.exec("RELEASE transition; COMMIT");
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { if (this.db.isOpen) this.db.close(); }
}
