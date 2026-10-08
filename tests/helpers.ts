import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { Fencepoint, type AdmissionReceipt, type ClaimReceipt } from "../src/index.js";

export const intent = { key: "artifact:demo", payload: { artifact: "bundle.tgz", revision: 3 }, leaseMs: 100 };

export function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "fencepoint-test-"));
  const databasePath = join(directory, "effects.db");
  let now = 1000;
  const connections: Fencepoint[] = [];
  const open = (clock: () => number = () => now) => {
    const db = new Fencepoint({ databasePath, clock });
    connections.push(db);
    return db;
  };
  const effects = open();
  t.after(() => {
    connections.forEach((connection) => connection.close());
    rmSync(directory, { recursive: true, force: true });
  });
  return { effects, databasePath, directory, open, setTime: (value: number) => { now = value; } };
}

export function acquire(effects: Fencepoint, input = intent): ClaimReceipt {
  const result = effects.claim(input);
  assert.equal(result.acquired, true);
  if (!result.acquired) throw new Error("Expected acquisition");
  return result.receipt;
}

export function admitted(effects: Fencepoint, input = intent): AdmissionReceipt {
  return effects.admit(acquire(effects, input));
}
