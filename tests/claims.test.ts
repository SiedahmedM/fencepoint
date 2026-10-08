import assert from "node:assert/strict";
import test from "node:test";
import { FenceConflictError, LeaseExpiredError, InvalidTransitionError } from "../src/index.js";
import { acquire, admitted, fixture, intent } from "./helpers.js";

test("first claim wins; another connection cannot acquire the active lease", (t) => {
  const { effects, open } = fixture(t);
  const receipt = acquire(effects);
  assert.equal(receipt.fence, 1);
  assert.equal(receipt.leaseExpiresAt, 1100);
  assert.ok(Object.isFrozen(receipt));
  assert.equal(open().claim(intent).acquired, false);
});

test("expiry at the exact boundary permits a new owner with a higher fence", (t) => {
  const { effects, setTime, open } = fixture(t);
  const first = acquire(effects);
  setTime(1099);
  assert.equal(effects.claim(intent).acquired, false);
  setTime(1100);
  const second = acquire(open());
  assert.equal(second.fence, first.fence + 1);
  assert.notEqual(second.ownerId, first.ownerId);
  assert.equal(second.leaseExpiresAt, 1200);
});

test("expired claims cannot admit, renew or cancel even without a successor", (t) => {
  const { effects, setTime } = fixture(t);
  const receipt = acquire(effects);
  setTime(1100);
  assert.throws(() => effects.admit(receipt), LeaseExpiredError);
  assert.throws(() => effects.renew(receipt, 100), LeaseExpiredError);
  assert.throws(() => effects.cancel(receipt), LeaseExpiredError);
});

test("renewal cannot shorten the lease; superseded receipts lose authority", (t) => {
  const { effects, setTime } = fixture(t);
  const first = acquire(effects);
  setTime(1050);
  const same = effects.renew(first, 10);
  assert.equal(same.leaseExpiresAt, 1100);
  const renewed = effects.renew(same, 200);
  assert.equal(renewed.leaseExpiresAt, 1250);
  assert.equal(renewed.fence, first.fence);
  assert.throws(() => effects.admit(first), FenceConflictError);
  assert.throws(() => effects.cancel(first), FenceConflictError);
  effects.admit(renewed);
});

test("clock rollback cannot revive a rejected expired claim, including after reopen", (t) => {
  const { effects, setTime, open } = fixture(t);
  const receipt = acquire(effects);
  setTime(1100);
  assert.throws(() => effects.admit(receipt), LeaseExpiredError);
  effects.close();
  setTime(1);
  const reopened = open();
  assert.throws(() => reopened.admit(receipt), LeaseExpiredError);
  const next = acquire(reopened);
  assert.equal(next.fence, 2);
  assert.equal(next.leaseExpiresAt, 1200);
});

test("admitted and terminal effects are never reclaimed by time passage", (t) => {
  const { effects, setTime } = fixture(t);
  const receipt = admitted(effects);
  setTime(900000);
  assert.equal(effects.claim(intent).acquired, false);
  assert.equal(effects.commit(receipt).state, "committed");
  assert.equal(effects.claim(intent).acquired, false);
});

test("a rejected overflowing reclaim cannot erase an observation of lease expiry", (t) => {
  const { effects, setTime } = fixture(t);
  const receipt = acquire(effects);
  setTime(1100);
  assert.throws(() => effects.claim({ ...intent, leaseMs: Number.MAX_SAFE_INTEGER }), RangeError);
  setTime(1000);
  assert.throws(() => effects.admit(receipt), LeaseExpiredError);
});

test("pre-admission cancellation is retryable and invalidates the cancelled operation", (t) => {
  const { effects } = fixture(t);
  const receipt = acquire(effects);
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => effects.cancel(receipt), { once: true });
  controller.abort();
  assert.equal(effects.get(intent.key)!.resolution, "cancelled");
  assert.throws(() => effects.admit(receipt), InvalidTransitionError);
  assert.throws(() => effects.renew(receipt, 100), InvalidTransitionError);
  assert.equal(acquire(effects).fence, 2);
  assert.throws(() => effects.cancel(receipt), FenceConflictError);
});

test("identical cancellation is idempotent without authorizing a new effect", (t) => {
  const { effects } = fixture(t);
  const receipt = acquire(effects);
  assert.deepEqual(effects.cancel(receipt), effects.cancel(receipt));
  assert.throws(() => effects.admit(receipt), InvalidTransitionError);
});
