import { parentPort, workerData } from "node:worker_threads";
import { Fencepoint, type AdmissionReceipt, type ClaimReceipt } from "../src/index.js";

const { path, now, gate, operation, receipt, input, openTogether } = workerData as {
  path: string; now: number; gate: SharedArrayBuffer; operation: string;
  receipt: ClaimReceipt | AdmissionReceipt; input: { key: string; payload: unknown; leaseMs: number }; openTogether: boolean;
};
if (openTogether) {
  parentPort!.postMessage({ ready: true });
  Atomics.wait(new Int32Array(gate), 0, 0);
}
const effects = new Fencepoint({ databasePath: path, clock: () => now });
if (!openTogether) {
  parentPort!.postMessage({ ready: true });
  Atomics.wait(new Int32Array(gate), 0, 0);
}
let response: unknown;
try {
  let value: unknown;
  switch (operation) {
    case "claim": value = effects.claim(input); break;
    case "admit": value = effects.admit(receipt as ClaimReceipt); break;
    case "renew": value = effects.renew(receipt as ClaimReceipt, 200); break;
    case "commit": value = effects.commit(receipt as AdmissionReceipt, { reference: "example" }); break;
    case "ambiguous": value = effects.markAmbiguous(receipt as AdmissionReceipt, { reason: "timeout" }); break;
    case "cancel": value = effects.cancel(receipt); break;
    default: throw new Error("Unknown test operation");
  }
  response = { ok: true, value };
} catch (error) {
  response = { ok: false, name: error instanceof Error ? error.name : "UnknownError" };
} finally {
  effects.close();
}
parentPort!.postMessage(response);
