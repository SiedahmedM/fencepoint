import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import test from "node:test";
import { Fencepoint, StorageError, type AdmissionReceipt } from "../src/index.js";
import { sqliteSupported } from "../src/store.js";
import { fixture, intent, acquire } from "./helpers.js";

test("process termination preserves claims, admission, terminals and metadata through WAL recovery", { timeout: 15000 }, async (t) => {
  const { effects, databasePath, setTime, open } = fixture(t);
  effects.close();
  const child = fork(new URL("./crash-worker.js", import.meta.url), [databasePath], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(() => child.kill());
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const receipts = await new Promise<Record<string, AdmissionReceipt>>((resolve, reject) => {
    child.once("message", (message) => resolve(message as Record<string, AdmissionReceipt>));
    child.once("error", reject);
    child.once("exit", () => reject(new Error("Child exited before committing fixtures")));
  });
  child.kill("SIGKILL");
  await exited;
  setTime(1050);
  const recovered = open();
  assert.equal(recovered.get("pending")!.state, "pending");
  assert.equal(recovered.get("active")!.state, "claimed");
  assert.equal(recovered.claim({ ...intent, key: "active" }).acquired, false);
  assert.equal(acquire(recovered, { ...intent, key: "expired" }).fence, 2);
  assert.equal(recovered.get("admitted")!.state, "admitted");
  assert.equal(recovered.get("admitted")!.admittedAt, 1000);
  assert.equal(recovered.get("admitted")!.payloadHash, receipts.admitted!.payloadHash);
  assert.equal(recovered.get("retryable")!.resolution, "pre_effect_failure");
  assert.deepEqual(recovered.get("committed")!.result, { reference: "persisted" });
  assert.deepEqual(recovered.get("ambiguous")!.result, { reason: "response_lost" });
  setTime(5000);
  assert.equal(recovered.claim({ ...intent, key: "admitted" }).acquired, false);
  assert.equal(recovered.claim({ ...intent, key: "ambiguous" }).acquired, false);
  assert.equal(recovered.commit(receipts.committed!, { reference: "persisted" }).state, "committed");
  assert.equal(recovered.markAmbiguous(receipts.admitted!, { reason: "interrupted" }).state, "ambiguous");
});

test("database identifies its schema and rejects unrelated or future databases", (t) => {
  const { directory } = fixture(t);
  const foreignPath = join(directory, "foreign.db");
  const foreign = new DatabaseSync(foreignPath);
  foreign.exec("CREATE TABLE unrelated (value TEXT)");
  foreign.close();
  assert.throws(() => new Fencepoint({ databasePath: foreignPath }), StorageError);
  const unchanged = new DatabaseSync(foreignPath);
  assert.equal(unchanged.prepare("PRAGMA journal_mode").get()!.journal_mode, "delete");
  unchanged.close();
  const futurePath = join(directory, "future.db");
  const future = new DatabaseSync(futurePath);
  future.exec("PRAGMA user_version=99; PRAGMA application_id=0x46504e54");
  future.close();
  assert.throws(() => new Fencepoint({ databasePath: futurePath }), StorageError);
});

test("file databases use WAL and current SQLite without the known WAL-reset race", (t) => {
  const { databasePath } = fixture(t);
  const db = new DatabaseSync(databasePath);
  try {
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { db.close(); }
  for (const version of ["3.50.4", "3.51.2", "3.44.5", "invalid"]) assert.equal(sqliteSupported(version), false);
  for (const version of ["3.50.7", "3.44.6", "3.51.3", "3.53.4"]) assert.equal(sqliteSupported(version), true);
});

test("invalid injected clocks roll back registration and leave the connection usable", (t) => {
  const { directory } = fixture(t);
  let now = NaN;
  using effects = new Fencepoint({ databasePath: join(directory, "clock.db"), clock: () => now });
  for (const invalid of [NaN, -1, Infinity, 1.2]) {
    now = invalid;
    assert.throws(() => effects.register(intent), RangeError);
    assert.equal(effects.get(intent.key), undefined);
  }
  now = 1;
  assert.equal(effects.register(intent).createdAt, 1);
});
