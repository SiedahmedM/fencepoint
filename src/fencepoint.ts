import { randomUUID } from "node:crypto";
import { canonicalize, equalHash, frozenJson, hashCanonical, payloadHash } from "./canonical.js";
import { AlreadyAdmittedError, EffectAlreadyTerminalError, FenceConflictError,
  InvalidTransitionError, LeaseExpiredError, PayloadConflictError } from "./errors.js";
import { Store, type Row } from "./store.js";
import type { AdmissionReceipt, ClaimReceipt, ClaimResult, EffectSnapshot, FailureDetails,
  FencepointOptions, Json, Resolution } from "./types.js";

type Receipt = ClaimReceipt | AdmissionReceipt;

function checkKey(key: string): void {
  if (typeof key !== "string" || !key.length || !key.isWellFormed() || Buffer.byteLength(key) > 512) {
    throw new TypeError("Key must be a nonempty Unicode string of at most 512 UTF-8 bytes");
  }
}

function checkLease(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms <= 0) throw new RangeError("leaseMs must be a positive safe integer");
}

function failure(details: FailureDetails): string {
  if (!details || typeof details.reason !== "string" || !details.reason.trim()) throw new TypeError("A nonempty reason is required");
  return canonicalize(details);
}

function snapshot(row: Row): EffectSnapshot {
  return Object.freeze({ key: row.intent_key, state: row.phase, fence: row.generation,
    payloadHash: row.digest, payload: frozenJson(row.body), leaseExpiresAt: row.deadline,
    admittedAt: row.admission_time, resolution: row.outcome,
    result: frozenJson(row.outcome_data ?? "null"), createdAt: row.born, updatedAt: row.changed });
}

function claimReceipt(row: Row): ClaimReceipt {
  return Object.freeze({ kind: "claim", key: row.intent_key, fence: row.generation,
    ownerId: row.holder!, payloadHash: row.digest, leaseExpiresAt: row.deadline! });
}

export class Fencepoint {
  private readonly store: Store;

  constructor(options: FencepointOptions) {
    this.store = new Store(options.databasePath, options.clock ?? Date.now);
  }

  register(input: { key: string; payload: unknown }): EffectSnapshot {
    checkKey(input.key);
    const body = canonicalize(input.payload);
    return this.store.write((now) => snapshot(this.registerInside(input.key, body, now)));
  }

  /** Registration and claim share one transaction. No acquisition means no authority. */
  claim(input: { key: string; payload: unknown; leaseMs: number }): ClaimResult {
    checkKey(input.key);
    checkLease(input.leaseMs);
    const body = canonicalize(input.payload);
    return this.store.write((now) => {
      const row = this.registerInside(input.key, body, now);
      if (row.phase !== "pending" && row.phase !== "retryable"
        && !(row.phase === "claimed" && row.deadline! <= now)) {
        return Object.freeze({ acquired: false, effect: snapshot(row) });
      }
      const deadline = now + input.leaseMs;
      if (!Number.isSafeInteger(deadline) || row.generation >= Number.MAX_SAFE_INTEGER) {
        throw new RangeError("Lease or fence exceeds safe integer range");
      }
      row.phase = "claimed";
      row.generation++;
      row.holder = randomUUID();
      row.deadline = deadline;
      row.admission_time = null;
      row.outcome = null;
      row.outcome_data = null;
      row.changed = now;
      this.store.save(row);
      return Object.freeze({ acquired: true, receipt: claimReceipt(row) });
    });
  }

  /** Renewal never shortens a deadline; use the returned receipt from now on. */
  renew(receipt: ClaimReceipt, leaseMs: number): ClaimReceipt {
    checkLease(leaseMs);
    return this.store.write((now) => {
      const row = this.authority(receipt);
      this.claimed(row, receipt, now);
      const deadline = Math.max(row.deadline!, now + leaseMs);
      if (!Number.isSafeInteger(deadline)) throw new RangeError("Lease exceeds safe integer range");
      row.deadline = deadline;
      row.changed = now;
      this.store.save(row);
      return claimReceipt(row);
    });
  }

  admit(receipt: ClaimReceipt): AdmissionReceipt {
    return this.store.write((now) => {
      const row = this.authority(receipt);
      if (row.phase === "admitted") throw new AlreadyAdmittedError("Admission was already consumed", { key: row.intent_key, fence: row.generation });
      this.claimed(row, receipt, now);
      row.phase = "admitted";
      row.admission_time = now;
      row.changed = now;
      this.store.save(row);
      return Object.freeze({ kind: "admission", key: row.intent_key, fence: row.generation,
        ownerId: row.holder!, payloadHash: row.digest, admittedAt: now, payload: frozenJson(row.body) });
    });
  }

  commit(receipt: AdmissionReceipt, result: Json = null): EffectSnapshot {
    return this.settle(receipt, "committed", canonicalize(result));
  }

  markAmbiguous(receipt: AdmissionReceipt, details: FailureDetails): EffectSnapshot {
    return this.settle(receipt, "ambiguous", failure(details));
  }

  /** Caller asserts the attempt is finished and provably cannot apply an effect. */
  failBeforeEffect(receipt: AdmissionReceipt, details: FailureDetails): EffectSnapshot {
    return this.settle(receipt, "pre_effect_failure", failure(details));
  }

  /** Before admission: release. After admission: ambiguity, never retryability. */
  cancel(receipt: Receipt, details: FailureDetails = { reason: "cancelled" }): EffectSnapshot {
    const encoded = failure(details);
    if (receipt.kind === "admission") return this.settle(receipt, "ambiguous", encoded);
    return this.store.write((now) => {
      const row = this.authority(receipt);
      if (row.phase === "retryable" && row.outcome === "cancelled" && row.outcome_data === encoded) return snapshot(row);
      this.claimed(row, receipt, now);
      return this.resolve(row, "cancelled", encoded, now);
    });
  }

  get(key: string): EffectSnapshot | undefined {
    checkKey(key);
    const row = this.store.read(key);
    return row ? snapshot(row) : undefined;
  }

  close(): void { this.store.close(); }
  [Symbol.dispose](): void { this.close(); }

  private registerInside(key: string, body: string, now: number): Row {
    let row = this.store.read(key);
    if (row) {
      if (row.body !== body) throw new PayloadConflictError("Key is already bound to another payload", { key });
    } else {
      this.store.insert(key, body, hashCanonical(body), now);
      row = this.store.read(key)!;
    }
    return row;
  }

  private authority(receipt: Receipt): Row {
    const row = this.store.read(receipt.key);
    if (!row || !row.holder || row.holder !== receipt.ownerId || row.generation !== receipt.fence) {
      throw new FenceConflictError("Receipt no longer owns this intent", { key: receipt.key, fence: receipt.fence });
    }
    if (!equalHash(receipt.payloadHash, row.digest)) throw new PayloadConflictError("Receipt payload hash differs", { key: receipt.key });
    if (receipt.kind === "claim") {
      if (row.deadline !== receipt.leaseExpiresAt) throw new FenceConflictError("Claim receipt was superseded by renewal", { key: receipt.key });
    } else if (receipt.kind === "admission") {
      if (row.admission_time === null || row.admission_time !== receipt.admittedAt) throw new FenceConflictError("Admission receipt differs", { key: receipt.key });
      if (!equalHash(payloadHash(receipt.payload), row.digest)) throw new PayloadConflictError("Admission payload differs", { key: receipt.key });
    } else {
      throw new InvalidTransitionError("Unknown receipt kind");
    }
    return row;
  }

  private claimed(row: Row, receipt: Receipt, now: number): void {
    if (receipt.kind !== "claim" || row.phase !== "claimed") throw new InvalidTransitionError("An active claim is required", { state: row.phase });
    if (row.deadline! <= now) throw new LeaseExpiredError("Claim expired before admission", { key: row.intent_key, fence: row.generation });
  }

  private settle(receipt: AdmissionReceipt, outcome: Resolution, encoded: string): EffectSnapshot {
    return this.store.write((now) => {
      const row = this.authority(receipt);
      if (receipt.kind !== "admission") throw new InvalidTransitionError("Settlement requires admission");
      if (row.outcome) {
        if (row.outcome === outcome && row.outcome_data === encoded) return snapshot(row);
        throw new EffectAlreadyTerminalError("Attempt already has a different resolution", { state: row.phase, fence: row.generation });
      }
      if (row.phase !== "admitted") throw new InvalidTransitionError("Settlement requires admitted state", { state: row.phase });
      return this.resolve(row, outcome, encoded, now);
    });
  }

  private resolve(row: Row, outcome: Resolution, encoded: string, now: number): EffectSnapshot {
    row.phase = outcome === "committed" || outcome === "ambiguous" ? outcome : "retryable";
    row.outcome = outcome;
    row.outcome_data = encoded;
    row.changed = now;
    this.store.save(row);
    return snapshot(row);
  }
}
