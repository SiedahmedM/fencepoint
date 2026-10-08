import assert from "node:assert/strict";
import test from "node:test";
import { canonicalize, payloadHash, CanonicalizationError } from "../src/index.js";

test("canonical key order is recursive and independent of insertion order", () => {
  assert.equal(canonicalize({ z: { b: 2, a: 1 }, a: 0 }), '{"a":0,"z":{"a":1,"b":2}}');
  assert.equal(payloadHash({ b: 2, a: 1 }), payloadHash({ a: 1, b: 2 }));
  assert.equal(canonicalize({ "2": true, "10": false }), '{"10":false,"2":true}');
});

test("strings and keys use NFC, array order remains meaningful, negative zero becomes zero", () => {
  assert.equal(payloadHash({ "e\u0301": "e\u0301" }), payloadHash({ "é": "é" }));
  assert.equal(canonicalize(-0), "0");
  assert.notEqual(payloadHash([1, 2]), payloadHash([2, 1]));
  assert.notEqual(payloadHash({ a: 1 }), payloadHash({ a: 2 }));
  assert.equal(canonicalize("a\nb"), '"a\\nb"');
});

test("canonical output preserves null prototypes and special property names safely", () => {
  const value = JSON.parse('{"__proto__":{"safe":true},"constructor":null}');
  assert.equal(canonicalize(value), '{"__proto__":{"safe":true},"constructor":null}');
  assert.equal(canonicalize(Object.assign(Object.create(null), { a: 1 })), '{"a":1}');
});

test("cycles reject; repeated acyclic references are allowed", () => {
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  assert.throws(() => canonicalize(cyclic), CanonicalizationError);
  const value = { x: 1 };
  assert.equal(canonicalize([value, value]), '[{"x":1},{"x":1}]');
});

test("unsupported values never silently disappear or coerce", () => {
  class Example { x = 1; }
  for (const value of [undefined, () => 1, Symbol("x"), 1n, NaN, Infinity, -Infinity,
    new Date(), new Map(), new Set(), new Example(), new Uint8Array([1]), /x/,
    { x: undefined }, [undefined], new Array(1), { [Symbol("x")]: 1 },
    Object.defineProperty({}, "hidden", { value: 1 }), new Proxy({}, {})]) {
    assert.throws(() => canonicalize(value), CanonicalizationError);
  }
  const extended = [1];
  Object.assign(extended, { extra: true });
  assert.throws(() => canonicalize(extended), CanonicalizationError);
});

test("getters and toJSON callbacks are never invoked", () => {
  let calls = 0;
  const getter = { get x() { calls++; return 1; } };
  const custom = { toJSON() { calls++; return {}; } };
  assert.throws(() => canonicalize(getter), CanonicalizationError);
  assert.throws(() => canonicalize(custom), CanonicalizationError);
  assert.equal(calls, 0);
});

test("Unicode collisions and malformed strings reject", () => {
  assert.throws(() => canonicalize({ "é": 1, "e\u0301": 2 }), CanonicalizationError);
  for (const value of ["\ud800", "\udfff", { "\ud800": 1 }]) {
    assert.throws(() => canonicalize(value), CanonicalizationError);
  }
});

test("canonical data has explicit depth and encoded size limits", () => {
  let value: unknown = 1;
  for (let i = 0; i < 66; i++) value = [value];
  assert.throws(() => canonicalize(value), CanonicalizationError);
  assert.throws(() => canonicalize("x".repeat(1024 * 1024)), CanonicalizationError);
});
