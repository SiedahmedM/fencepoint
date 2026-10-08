import assert from "node:assert/strict";
import test from "node:test";
import { EffectAlreadyTerminalError, FenceConflictError } from "../src/index.js";
import { acquire, admitted, fixture, intent } from "./helpers.js";

test("confirmed success commits and identical canonical result settles idempotently", (t) => {
  const { effects, setTime } = fixture(t);
  const receipt = admitted(effects);
  const first = effects.commit(receipt, { providerReference: "example-reference", accepted: true });
  setTime(100000);
  const again = effects.commit(receipt, { accepted: true, providerReference: "example-reference" });
  assert.deepEqual(again, first);
  assert.equal(first.state, "committed");
  assert.equal(first.resolution, "committed");
  assert.equal(first.updatedAt, 1000);
});

test("committed outcomes reject different results, ambiguity, cancellation and failure", (t) => {
  const { effects } = fixture(t);
  const receipt = admitted(effects);
  effects.commit(receipt, { value: 1 });
  for (const change of [() => effects.commit(receipt, { value: 2 }),
    () => effects.markAmbiguous(receipt, { reason: "timeout" }),
    () => effects.cancel(receipt), () => effects.failBeforeEffect(receipt, { reason: "rejected" })]) {
    assert.throws(change, EffectAlreadyTerminalError);
  }
});

test("ambiguity is idempotent but cannot become committed or retryable", (t) => {
  const { effects } = fixture(t);
  const receipt = admitted(effects);
  const first = effects.markAmbiguous(receipt, { reason: "response_lost" });
  assert.deepEqual(effects.markAmbiguous(receipt, { reason: "response_lost" }), first);
  assert.throws(() => effects.commit(receipt), EffectAlreadyTerminalError);
  assert.throws(() => effects.failBeforeEffect(receipt, { reason: "rejected" }), EffectAlreadyTerminalError);
  assert.throws(() => effects.markAmbiguous(receipt, { reason: "different" }), EffectAlreadyTerminalError);
  assert.equal(effects.claim(intent).acquired, false);
});

test("definite pre-effect failure retries only under a new fence", (t) => {
  const { effects } = fixture(t);
  const receipt = admitted(effects);
  const details = { reason: "provider_declined", evidence: { applied: false } };
  const first = effects.failBeforeEffect(receipt, details);
  assert.equal(first.state, "retryable");
  assert.deepEqual(effects.failBeforeEffect(receipt, details), first);
  assert.throws(() => effects.commit(receipt), EffectAlreadyTerminalError);
  const next = acquire(effects);
  assert.equal(next.fence, receipt.fence + 1);
  assert.throws(() => effects.commit(receipt), FenceConflictError);
  assert.throws(() => effects.failBeforeEffect(receipt, details), FenceConflictError);
  assert.equal(effects.commit(effects.admit(next)).state, "committed");
});

test("cancellation after admission records ambiguity and rejects a late provider result", (t) => {
  const { effects } = fixture(t);
  const receipt = admitted(effects);
  const controller = new AbortController();
  controller.signal.addEventListener("abort", () => effects.cancel(receipt), { once: true });
  controller.abort();
  assert.equal(effects.get(intent.key)!.state, "ambiguous");
  assert.equal(effects.claim(intent).acquired, false);
  assert.throws(() => effects.commit(receipt, { late: true }), EffectAlreadyTerminalError);
});

test("empty failure reasons reject without resolving the attempt", (t) => {
  const { effects } = fixture(t);
  const receipt = admitted(effects);
  assert.throws(() => effects.failBeforeEffect(receipt, { reason: "  " }), TypeError);
  assert.throws(() => effects.markAmbiguous(receipt, { reason: "" }), TypeError);
  assert.equal(effects.get(intent.key)!.state, "admitted");
});
