import { createHash, timingSafeEqual } from "node:crypto";
import { types } from "node:util";
import { CanonicalizationError } from "./errors.js";
import type { Json } from "./types.js";

const MAX_BYTES = 1024 * 1024;
const MAX_DEPTH = 64;

/** A deliberately restricted JSON encoding, not an implementation of RFC 8785. */
export function canonicalize(value: unknown): string {
  const ancestors = new Set<object>();
  let bytes = 0;
  const emit = (text: string): string => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw new CanonicalizationError("Canonical value exceeds 1 MiB");
    return text;
  };
  const string = (text: string): string => {
    if (!text.isWellFormed()) throw new CanonicalizationError("Unpaired Unicode surrogate");
    return JSON.stringify(text.normalize("NFC"));
  };
  const visit = (item: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new CanonicalizationError("Canonical value exceeds depth 64");
    if (item === null) return emit("null");
    if (typeof item === "string") return emit(string(item));
    if (typeof item === "boolean") return emit(String(item));
    if (typeof item === "number" && Number.isFinite(item)) return emit(JSON.stringify(item));
    if (typeof item !== "object" || types.isProxy(item)) {
      throw new CanonicalizationError("Expected finite JSON data, without proxies");
    }
    if (ancestors.has(item)) throw new CanonicalizationError("Cyclic value");
    ancestors.add(item);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(item);
      const keys = Reflect.ownKeys(descriptors);
      if (keys.some((key) => typeof key !== "string")) {
        throw new CanonicalizationError("Symbol keys are unsupported");
      }
      const data = (key: string): unknown => {
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
          throw new CanonicalizationError("Expected enumerable data properties");
        }
        return descriptor.value;
      };
      if (Array.isArray(item)) {
        if (Object.getPrototypeOf(item) !== Array.prototype || keys.length !== item.length + 1) {
          throw new CanonicalizationError("Sparse, extended, or subclassed array");
        }
        emit("[]");
        const entries: string[] = [];
        for (let i = 0; i < item.length; i++) {
          if (i) emit(",");
          entries.push(visit(data(String(i)), depth + 1));
        }
        return `[${entries.join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(item);
      if (prototype !== null && prototype !== Object.prototype) {
        throw new CanonicalizationError("Only plain objects are supported");
      }
      const entries = (keys as string[]).map((key) => ({ key, normalized: JSON.parse(string(key)) as string }));
      entries.sort((a, b) => a.normalized < b.normalized ? -1 : a.normalized > b.normalized ? 1 : 0);
      emit("{}");
      return `{${entries.map(({ key, normalized }, index) => {
        if (index && entries[index - 1]!.normalized === normalized) {
          throw new CanonicalizationError("Object keys collide after Unicode normalization");
        }
        if (index) emit(",");
        return emit(JSON.stringify(normalized)) + emit(":") + visit(data(key), depth + 1);
      }).join(",")}}`;
    } finally {
      ancestors.delete(item);
    }
  };
  return visit(value, 0);
}

export function payloadHash(value: unknown): string {
  return hashCanonical(canonicalize(value));
}

export function hashCanonical(encoded: string): string {
  return createHash("sha256").update(encoded).digest("hex");
}

export function equalHash(actual: string, expected: string): boolean {
  return typeof actual === "string" && /^[a-f0-9]{64}$/.test(actual)
    && timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function frozenJson(encoded: string): Json {
  const freeze = (value: Json): Json => {
    if (value !== null && typeof value === "object") {
      Object.values(value).forEach(freeze);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(JSON.parse(encoded) as Json);
}
