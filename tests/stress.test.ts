import assert from "node:assert/strict";
import test from "node:test";
import { FencepointError, type AdmissionReceipt, type ClaimReceipt } from "../src/index.js";
import { acquire, fixture, intent } from "./helpers.js";

test("seeded stress: 20 workers preserve ownership across 3000 interleaved transitions", (t) => {
  const { effects, open } = fixture(t);
  let now = 1000;
  let seed = 0x17baface;
  const next = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return seed >>> 0;
  };
  const workers = Array.from({ length: 20 }, () => ({
    db: open(() => now),
    receipt: undefined as ClaimReceipt | AdmissionReceipt | undefined,
  }));
  effects.register(intent);
  const admissions = new Set<number>();
  const observedClaims: number[] = [];
  const counts = { claim: 0, admit: 0, retry: 0, renew: 0, crash: 0, rejected: 0 };
  for (let step = 0; step < 3000; step++) {
    const worker = workers[next() % workers.length]!;
    const before = effects.get(intent.key)!;
    const operation = next() % 8;
    let acquired = false;
    try {
      if (operation === 0 || operation === 1) {
        const attempt = worker.db.claim(intent);
        if (attempt.acquired) {
          assert.ok(before.state === "pending" || before.state === "retryable"
            || (before.state === "claimed" && before.leaseExpiresAt! <= now));
          worker.receipt = attempt.receipt;
          observedClaims.push(attempt.receipt.fence);
          acquired = true;
          counts.claim++;
        }
      } else if (operation === 2) {
        now += 1 + next() % 80;
      } else if (operation === 3 && worker.receipt?.kind === "claim") {
        const admission = worker.db.admit(worker.receipt);
        assert.equal(admissions.has(admission.fence), false, "At most one admission per fence");
        admissions.add(admission.fence);
        worker.receipt = admission;
        counts.admit++;
      } else if (operation === 4 && worker.receipt?.kind === "admission") {
        // The simulated provider definitively rejected this completed attempt.
        worker.db.failBeforeEffect(worker.receipt, { reason: "simulated_rejection" });
        counts.retry++;
      } else if (operation === 5 && worker.receipt?.kind === "claim") {
        worker.db.cancel(worker.receipt);
      } else if (operation === 6 && worker.receipt?.kind === "claim") {
        worker.receipt = worker.db.renew(worker.receipt, 100);
        counts.renew++;
      } else if (operation === 7) {
        worker.db.close();
        worker.db = open(() => now);
        // Receipts may be retained by a supervisor, but reopening grants no new authority.
        counts.crash++;
      }
    } catch (error) {
      assert.ok(error instanceof FencepointError, String(error));
      assert.deepEqual(effects.get(intent.key), before, "Rejected operations cannot change the intent");
      counts.rejected++;
    }
    const after = effects.get(intent.key)!;
    assert.equal(after.payloadHash, before.payloadHash);
    assert.equal(after.fence, before.fence + (acquired ? 1 : 0));
    assert.ok(after.updatedAt >= before.updatedAt);
    if (before.state === "admitted" && operation !== 4) assert.equal(after.state, "admitted");
  }
  assert.ok(counts.claim > 30, JSON.stringify(counts));
  assert.ok(counts.admit > 5, JSON.stringify(counts));
  assert.ok(counts.retry > 5, JSON.stringify(counts));
  assert.ok(counts.renew > 5, JSON.stringify(counts));
  assert.ok(counts.crash > 100, JSON.stringify(counts));
  assert.ok(counts.rejected > 100, JSON.stringify(counts));
  assert.deepEqual(observedClaims, Array.from({ length: counts.claim }, (_, i) => i + 1));

  // Finish conservatively, then bombard the terminal state with every retained receipt.
  let owner = workers.find((worker) => worker.receipt?.kind === "admission"
    && worker.receipt.fence === effects.get(intent.key)!.fence);
  let finalReceipt: AdmissionReceipt;
  if (effects.get(intent.key)!.state === "admitted") {
    assert.ok(owner?.receipt?.kind === "admission");
    finalReceipt = owner.receipt;
  } else {
    now += 1000;
    owner = workers[0]!;
    finalReceipt = owner.db.admit(acquire(owner.db));
  }
  const terminal = owner!.db.markAmbiguous(finalReceipt, { reason: "simulated_response_loss" });
  for (let step = 0; step < 200; step++) {
    now += 100;
    const worker = workers[next() % workers.length]!;
    assert.equal(worker.db.claim(intent).acquired, false);
    if (worker.receipt) {
      assert.throws(() => worker.receipt!.kind === "claim"
        ? worker.db.admit(worker.receipt as ClaimReceipt)
        : worker.db.commit(worker.receipt as AdmissionReceipt), FencepointError);
    }
    assert.deepEqual(effects.get(intent.key), terminal);
  }
  t.diagnostic(`seed=0x17baface; workers=20; transitions=3200; ${JSON.stringify(counts)}`);
});
