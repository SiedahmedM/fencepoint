import { Fencepoint } from "../src/index.js";

type Mode = "success" | "definite_failure" | "timeout_before_effect" | "effect_then_timeout";
class DefiniteRejection extends Error {}

async function provider(mode: Mode, applied: () => void): Promise<{ reference: string }> {
  if (mode === "definite_failure") throw new DefiniteRejection("Request rejected without applying an effect");
  if (mode !== "timeout_before_effect") applied();
  if (mode === "success") return { reference: "example-delivery" };
  // Both timeout modes are deliberately indistinguishable to the caller.
  throw new Error("Response deadline exceeded");
}

using effects = new Fencepoint({ databasePath: ":memory:" });
console.log("mode                   applied  state       retry");
for (const mode of ["success", "definite_failure", "timeout_before_effect", "effect_then_timeout"] as const) {
  let applied = 0;
  const claim = effects.claim({ key: mode, payload: { event: "artifact.published" }, leaseMs: 30000 });
  if (!claim.acquired) throw new Error("Expected a new intent");
  const admission = effects.admit(claim.receipt);
  let result: { reference: string };
  try {
    result = await provider(mode, () => { applied++; });
  } catch (error) {
    if (error instanceof DefiniteRejection) {
      effects.failBeforeEffect(admission, { reason: "provider_declined" });
    } else {
      effects.markAmbiguous(admission, { reason: "response_timeout" });
    }
    const state = effects.get(mode)!.state;
    console.log(`${mode.padEnd(23)}${String(applied).padEnd(9)}${state.padEnd(12)}${state === "retryable" ? "allowed" : "blocked"}`);
    continue;
  }
  // Storage failures here must not be mistaken for provider failures.
  effects.commit(admission, result);
  console.log(`${mode.padEnd(23)}${String(applied).padEnd(9)}${"committed".padEnd(12)}blocked`);
}
console.log("\nA timeout alone cannot distinguish zero effects from one effect. Neither timeout is retried.");
