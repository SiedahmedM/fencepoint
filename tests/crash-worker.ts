import { Fencepoint } from "../src/index.js";
import { acquire } from "./helpers.js";

const effects = new Fencepoint({ databasePath: process.argv[2]!, clock: () => 1000 });
const receipts: Record<string, unknown> = {};
effects.register({ key: "pending", payload: null });
for (const key of ["active", "expired", "admitted", "committed", "ambiguous", "retryable"]) {
  const claim = acquire(effects, { key, payload: { artifact: "bundle.tgz", revision: 3 }, leaseMs: key === "expired" ? 1 : 100 });
  receipts[key] = claim;
  if (key === "active" || key === "expired") continue;
  const admission = effects.admit(claim);
  receipts[key] = admission;
  if (key === "committed") effects.commit(admission, { reference: "persisted" });
  if (key === "ambiguous") effects.markAmbiguous(admission, { reason: "response_lost" });
  if (key === "retryable") effects.failBeforeEffect(admission, { reason: "declined" });
}
process.send!(receipts);
// The parent terminates this process without allowing close() or cleanup handlers.
setInterval(() => {}, 1000);
