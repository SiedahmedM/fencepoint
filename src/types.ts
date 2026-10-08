export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type EffectState = "pending" | "claimed" | "admitted" | "retryable" | "committed" | "ambiguous";
export type Resolution = "committed" | "ambiguous" | "pre_effect_failure" | "cancelled";

interface Binding {
  readonly key: string;
  readonly fence: number;
  readonly ownerId: string;
  readonly payloadHash: string;
}

export interface ClaimReceipt extends Binding {
  readonly kind: "claim";
  readonly leaseExpiresAt: number;
}

export interface AdmissionReceipt extends Binding {
  readonly kind: "admission";
  readonly admittedAt: number;
  /** Frozen, canonical snapshot. Use this payload for the external call. */
  readonly payload: Json;
}

export interface EffectSnapshot {
  readonly key: string;
  readonly state: EffectState;
  readonly fence: number;
  readonly payloadHash: string;
  readonly payload: Json;
  readonly leaseExpiresAt: number | null;
  readonly admittedAt: number | null;
  readonly resolution: Resolution | null;
  readonly result: Json;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export type ClaimResult =
  | { readonly acquired: true; readonly receipt: ClaimReceipt }
  | { readonly acquired: false; readonly effect: EffectSnapshot };

export interface FailureDetails {
  readonly reason: string;
  readonly evidence?: Json;
}

export interface FencepointOptions {
  readonly databasePath: string;
  /** Unix milliseconds. All connections must use a compatible clock. */
  readonly clock?: () => number;
}
