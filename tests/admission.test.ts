import assert from "node:assert/strict";
import test from "node:test";
import { AlreadyAdmittedError, FenceConflictError, InvalidTransitionError, PayloadConflictError,
  type AdmissionReceipt, type ClaimReceipt } from "../src/index.js";
import { acquire, fixture, intent } from "./helpers.js";

test("current claim admits exactly once and returns canonical immutable payload", (t) => {
  const { effects } = fixture(t);
  const claim = acquire(effects);
  const receipt = effects.admit(claim);
  assert.equal(receipt.kind, "admission");
  assert.equal(receipt.admittedAt, 1000);
  assert.equal(receipt.payloadHash, claim.payloadHash);
  assert.deepEqual(receipt.payload, intent.payload);
  assert.ok(Object.isFrozen(receipt));
  assert.throws(() => effects.admit(claim), AlreadyAdmittedError);
});

test("every mutation rejects a superseded fence", (t) => {
  const { effects, setTime } = fixture(t);
  const stale = acquire(effects);
  setTime(1100);
  acquire(effects);
  const forged = { ...stale, kind: "admission", admittedAt: 1000, payload: intent.payload } as AdmissionReceipt;
  for (const mutate of [() => effects.admit(stale), () => effects.renew(stale, 100),
    () => effects.cancel(stale), () => effects.commit(forged),
    () => effects.markAmbiguous(forged, { reason: "unknown" }),
    () => effects.failBeforeEffect(forged, { reason: "rejected" })]) {
    assert.throws(mutate, FenceConflictError);
  }
  assert.equal(effects.get(intent.key)!.state, "claimed");
  assert.equal(effects.get(intent.key)!.fence, 2);
});

test("tampered owner, deadline, fence and payload hash fail closed", (t) => {
  const { effects } = fixture(t);
  const claim = acquire(effects);
  for (const receipt of [{ ...claim, ownerId: "another" }, { ...claim, fence: 2 },
    { ...claim, leaseExpiresAt: 9999 }, { ...claim, key: "missing" }]) {
    assert.throws(() => effects.admit(receipt), FenceConflictError);
  }
  for (const payloadHash of ["0".repeat(64), "bad", "G".repeat(64)]) {
    assert.throws(() => effects.admit({ ...claim, payloadHash }), PayloadConflictError);
  }
  assert.equal(effects.get(intent.key)!.state, "claimed");
});

test("admission timestamp, hash and payload are checked on every settlement", (t) => {
  const { effects } = fixture(t);
  const receipt = effects.admit(acquire(effects));
  assert.throws(() => effects.commit({ ...receipt, admittedAt: 0 }), FenceConflictError);
  assert.throws(() => effects.commit({ ...receipt, payloadHash: "f".repeat(64) }), PayloadConflictError);
  assert.throws(() => effects.commit({ ...receipt, payload: null }), PayloadConflictError);
  assert.equal(effects.get(intent.key)!.state, "admitted");
});

test("claim receipts cannot be used as settlement receipts or cancel admitted work", (t) => {
  const { effects } = fixture(t);
  const claim = acquire(effects);
  assert.throws(() => effects.commit(claim as unknown as AdmissionReceipt), InvalidTransitionError);
  effects.admit(claim);
  assert.throws(() => effects.commit(claim as unknown as AdmissionReceipt), InvalidTransitionError);
  assert.throws(() => effects.cancel(claim), InvalidTransitionError);
  assert.throws(() => effects.admit({ ...claim, kind: "invalid" } as unknown as ClaimReceipt), InvalidTransitionError);
});
