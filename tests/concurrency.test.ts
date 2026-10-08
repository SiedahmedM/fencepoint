import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import type { AdmissionReceipt, ClaimReceipt, ClaimResult, EffectSnapshot } from "../src/index.js";
import { acquire, admitted, fixture, intent } from "./helpers.js";

type Request = { operation: string; now: number; receipt?: ClaimReceipt | AdmissionReceipt };
type Response = { ok: true; value: ClaimResult | EffectSnapshot | AdmissionReceipt | ClaimReceipt } | { ok: false; name: string };

async function race(path: string, requests: Request[], openTogether = false): Promise<Response[]> {
  const gate = new SharedArrayBuffer(4);
  const workers: Worker[] = [];
  const ready: Promise<void>[] = [];
  const finished: Promise<Response>[] = [];
  for (const request of requests) {
    const worker = new Worker(new URL("./worker.js", import.meta.url), { workerData: { path, gate, input: intent, openTogether, ...request } });
    workers.push(worker);
    ready.push(new Promise((resolve, reject) => {
      worker.once("error", reject);
      worker.on("message", (value: { ready?: boolean }) => { if (value.ready) resolve(); });
    }));
    finished.push(new Promise((resolve, reject) => {
      let response: Response | undefined;
      worker.once("error", reject);
      worker.on("message", (value: Response | { ready: true }) => { if (!("ready" in value)) response = value; });
      worker.once("exit", (code) => {
        if (code !== 0 || !response) reject(new Error(`Worker exited without result: ${code}`));
        else resolve(response);
      });
    }));
  }
  // Attach handlers before either phase can fail.
  const results = Promise.all(finished);
  void results.catch(() => undefined);
  try {
    await Promise.all(ready);
    Atomics.store(new Int32Array(gate), 0, 1);
    Atomics.notify(new Int32Array(gate), 0);
    return await results;
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

test("two actual concurrent SQLite connections produce exactly one claim winner", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const results = await race(databasePath, [{ operation: "claim", now: 1000 }, { operation: "claim", now: 1000 }]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.filter((r) => r.ok && (r.value as ClaimResult).acquired).length, 1);
  assert.equal(effects.get(intent.key)!.fence, 1);
});

test("concurrent first open initializes one schema and claims only once", { timeout: 15000 }, async (t) => {
  const { directory } = fixture(t);
  const results = await race(join(directory, "fresh.db"), [{ operation: "claim", now: 1000 }, { operation: "claim", now: 1000 }], true);
  assert.ok(results.every((r) => r.ok));
  assert.equal(results.filter((r) => r.ok && (r.value as ClaimResult).acquired).length, 1);
});

test("claim-versus-expiry race leaves a single monotonic successor", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  acquire(effects);
  const results = await race(databasePath, [{ operation: "claim", now: 1099 }, { operation: "claim", now: 1100 }]);
  assert.equal(results.filter((r) => r.ok && (r.value as ClaimResult).acquired).length, 1);
  assert.equal(effects.get(intent.key)!.fence, 2);
  assert.equal(effects.get(intent.key)!.leaseExpiresAt, 1200);
});

test("stale admission races with reclaim at expiry and cannot win", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = acquire(effects);
  const results = await race(databasePath, [{ operation: "admit", now: 1100, receipt }, { operation: "claim", now: 1100 }]);
  assert.equal(results[0]!.ok, false);
  assert.ok(results[1]!.ok && (results[1]!.value as ClaimResult).acquired);
  assert.equal(effects.get(intent.key)!.fence, 2);
});

test("two admissions racing on the same receipt consume the slot once", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = acquire(effects);
  const results = await race(databasePath, [{ operation: "admit", now: 1000, receipt }, { operation: "admit", now: 1000, receipt }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.find((r) => !r.ok), { ok: false, name: "AlreadyAdmittedError" });
});

test("commit-versus-ambiguous race produces exactly one immutable terminal outcome", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = admitted(effects);
  const results = await race(databasePath, [{ operation: "commit", now: 1200, receipt }, { operation: "ambiguous", now: 1200, receipt }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.deepEqual(results.find((r) => !r.ok), { ok: false, name: "EffectAlreadyTerminalError" });
  assert.ok(["committed", "ambiguous"].includes(effects.get(intent.key)!.state));
});

test("identical concurrent commits both observe the same persisted terminal result", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = admitted(effects);
  const results = await race(databasePath, [{ operation: "commit", now: 1200, receipt }, { operation: "commit", now: 1300, receipt }]);
  assert.ok(results[0]!.ok && results[1]!.ok);
  assert.deepEqual(results[0]!.value, results[1]!.value);
});

test("cancellation-versus-admission race cannot release an admitted attempt", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = acquire(effects);
  const results = await race(databasePath, [{ operation: "admit", now: 1000, receipt }, { operation: "cancel", now: 1000, receipt }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const current = effects.get(intent.key)!;
  assert.ok(current.state === "retryable" || current.state === "admitted");
  assert.equal(effects.claim(intent).acquired, current.state === "retryable");
});

test("cancellation-versus-commit race never permits a second provider attempt", { timeout: 15000 }, async (t) => {
  const { effects, databasePath } = fixture(t);
  const receipt = admitted(effects);
  const results = await race(databasePath, [{ operation: "commit", now: 1000, receipt }, { operation: "cancel", now: 1000, receipt }]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(effects.claim(intent).acquired, false);
});
