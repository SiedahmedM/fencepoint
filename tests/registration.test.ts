import assert from "node:assert/strict";
import test from "node:test";
import { PayloadConflictError, CanonicalizationError, payloadHash } from "../src/index.js";
import { fixture, intent, acquire } from "./helpers.js";

test("new registration persists an immutable pending intent without claiming", (t) => {
  const { effects } = fixture(t);
  const first = effects.register(intent);
  assert.equal(first.state, "pending");
  assert.equal(first.fence, 0);
  assert.equal(first.payloadHash, payloadHash(intent.payload));
  assert.equal(first.leaseExpiresAt, null);
  assert.equal(first.admittedAt, null);
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.payload));
  assert.deepEqual(effects.get(intent.key), first);
  assert.equal(effects.get("missing"), undefined);
});

test("same key and canonical payload register idempotently without changing timestamps", (t) => {
  const { effects, setTime } = fixture(t);
  const first = effects.register(intent);
  setTime(2000);
  assert.deepEqual(effects.register({ key: intent.key, payload: { revision: 3, artifact: "bundle.tgz" } }), first);
});

test("conflicting payload rejects registration and claim without changing the intent", (t) => {
  const { effects } = fixture(t);
  const first = effects.register(intent);
  assert.throws(() => effects.register({ ...intent, payload: {} }), PayloadConflictError);
  assert.throws(() => effects.claim({ ...intent, payload: {} }), PayloadConflictError);
  assert.deepEqual(effects.get(intent.key), first);
});

test("input mutation cannot change the stored or admitted payload", (t) => {
  const { effects } = fixture(t);
  const payload = { nested: { value: 1 } };
  const result = effects.claim({ key: "snapshot", payload, leaseMs: 100 });
  assert.ok(result.acquired);
  payload.nested.value = 2;
  const receipt = effects.admit(result.receipt);
  assert.deepEqual(receipt.payload, { nested: { value: 1 } });
  assert.ok(Object.isFrozen((receipt.payload as { nested: object }).nested));
});

test("invalid keys, payloads and leases fail before creating intent rows", (t) => {
  const { effects } = fixture(t);
  for (const key of ["", "x".repeat(513), "\ud800"]) assert.throws(() => effects.register({ key, payload: null }), TypeError);
  assert.throws(() => effects.register({ key: "invalid", payload: undefined }), CanonicalizationError);
  for (const leaseMs of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => effects.claim({ ...intent, leaseMs }), RangeError);
  }
  assert.equal(effects.get(intent.key), undefined);
});

test("SQL-looking keys and payloads remain ordinary data", (t) => {
  const { effects } = fixture(t);
  const key = "'; DROP TABLE fp_intents; --";
  effects.register({ key, payload: { text: key } });
  assert.deepEqual(effects.get(key)!.payload, { text: key });
  assert.equal(acquire(effects).fence, 1);
});
