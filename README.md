# Fencepoint

Fenced execution for side effects you cannot safely retry.

Distributed workers usually know how to retry failed computation. External side effects are harder. If a request times out after calling a deployment API, email service, payment provider, webhook, or agent tool, retrying may execute the action twice.

Fencepoint is a small SQLite-backed runtime that separates ownership from effect admission and makes uncertain outcomes explicit. It runs inside your application, has no runtime dependencies, and does not send requests for you.

## The problem

```text
worker ───── request ─────► provider
                      X
                response lost

Did it happen?
```

A timeout cannot distinguish a request that never arrived from a completed effect whose response was lost. A lease tells you who may work; it does not tell you whether an earlier worker changed the outside world.

## Why not exactly once?

A local database transaction cannot atomically include an arbitrary external provider. The provider may apply an effect before the worker records success, and retrying that gap can duplicate it. Exactly-once claims need additional assumptions, such as provider-enforced idempotency.

Fencepoint does not hide that gap. It reserves an attempt before external I/O, then records a confirmed result or an ambiguous outcome. An unresolved reservation is never retried automatically.

## Model

```text
REGISTER
   │
   ▼
 CLAIM ── lease + fence
   │
   ▼
 ADMIT ── permission for one external attempt
   │
   ├────────────────┐
   ▼                ▼
COMMITTED        AMBIGUOUS
```

Before admission, an expired claim may be replaced with a higher fence. After admission, expiry does not transfer ownership. A completed attempt that provably applied no effect can be marked retryable explicitly; uncertainty cannot.

## Fencing tokens

```text
Worker A: fence=7 ── stalls
lease expires
Worker B: fence=8 ── continues
Worker A wakes up ── rejected
```

Every successful claim increments a per-key fence. Mutations validate the fence, owner, receipt binding, and current state inside a SQLite write transaction. An old worker cannot admit, renew, cancel, or settle a newer attempt.

These fences protect the local state machine. A provider that does not check fences cannot be stopped by Fencepoint after a request is in flight.

## Quick start

Use Node **24.21.0 or later in the 24.x line**. Earlier Node builds may contain a SQLite WAL concurrency bug; Fencepoint checks the SQLite version at startup.

```bash
git clone https://github.com/SiedahmedM/fencepoint.git
cd fencepoint
npm ci
npm run demo
```

The demo makes no network requests. It shows a successful effect, a definitive rejection, and two indistinguishable timeouts—one with no effect and one with an effect. Both timeouts block retry.

Build with `npm run build`. From a file in this checkout, import `./dist/index.js`. The package is not published to npm; `private: true` prevents accidental publication. For a local package install, run `npm pack` and install the resulting tarball in your application.

```ts
import { Fencepoint } from "./dist/index.js";

using effects = new Fencepoint({ databasePath: "./effects.db" });
const claim = effects.claim({
  key: "artifact:release-123",
  payload: { artifact: "bundle.tgz", release: "123" },
  leaseMs: 30_000,
});

if (claim.acquired) {
  const admitted = effects.admit(claim.receipt);
  // publishArtifact is your provider adapter; disable its automatic retries.
  const result = await publishArtifact(admitted.payload);
  effects.commit(admitted, { providerReference: result.id });
}
```

The example above assumes your application supplies `publishArtifact`. If it throws, the intent stays reserved. The [complete runnable demo](examples/webhook.ts) includes conservative failure handling. Keep provider errors separate from errors while writing the outcome: a failed local `commit` does not mean the provider failed. Retrying the same settlement is safe; retrying the provider call is not.

## API

All operations are synchronous and use a local SQLite file. `:memory:` is supported for examples and isolated tests, without persistence.

| Operation | Meaning |
|---|---|
| `register({ key, payload })` | Persist an intent idempotently; reject a different canonical payload for the same key. |
| `claim({ key, payload, leaseMs })` | Register and acquire atomically. Returns `{ acquired: true, receipt }` or `{ acquired: false, effect }`. |
| `renew(claim, leaseMs)` | Extend an unexpired, unadmitted claim. Use the returned receipt; an extended deadline supersedes the old receipt. |
| `admit(claim)` | Consume admission once. Returns the frozen canonical payload and an admission receipt. Duplicate admission throws. |
| `commit(admission, result?)` | Record confirmed success. Identical canonical results are idempotent. |
| `markAmbiguous(admission, { reason, evidence? })` | Record an uncertain outcome permanently. |
| `failBeforeEffect(admission, { reason, evidence? })` | Assert the attempt is finished and cannot apply an effect; permit another claim. |
| `cancel(receipt, { reason }?)` | Release a claim, or mark an admitted attempt ambiguous. It does not abort provider I/O. |
| `get(key)` | Read a frozen snapshot; observing state grants no execution authority. |
| `close()` | Close this connection. `using` / `Symbol.dispose` also works. |

Receipts contain a key, fence, opaque owner identifier, payload hash, and lease or admission timestamp. Admission receipts also carry the canonical payload. They are ordinary immutable data, not signed capabilities or a security boundary between untrusted workers.

Payloads and settlement metadata accept finite JSON data, capped at 1 MiB and depth 64. Strings and object keys normalize to NFC; keys sort by UTF-16 order, arrays retain order, and negative zero becomes zero. Undefined values, cycles, sparse arrays, accessors, proxies, custom prototypes, malformed Unicode, and normalization collisions reject. Always send `admitted.payload`, since normalization may change the original input. Keys identifying intents are case-sensitive and are not normalized.

Errors include `FenceConflictError`, `LeaseExpiredError`, `PayloadConflictError`, `AlreadyAdmittedError`, `InvalidTransitionError`, `EffectAlreadyTerminalError`, `CanonicalizationError`, and `StorageError`. Invalid basic arguments throw `TypeError` or `RangeError`; SQLite I/O and lock errors propagate. None authorizes repeating an external call.

## Failure semantics

| Situation | Fencepoint state | Safe automatic retry? |
|---|---|---|
| Worker dies before admission | `claimed`, until expiry | A new claim can retry after expiry. |
| Admission succeeds, worker dies before calling provider | `admitted` | No. The database cannot prove the call never started. |
| Provider definitively rejects a finished attempt without applying an effect | `retryable`, after `failBeforeEffect` | Yes, under a new claim and fence. |
| Provider succeeds, response is lost | `ambiguous`, if recorded; otherwise `admitted` | No. |
| Outcome write fails after provider success | `admitted` or already `committed` | Retry the identical settlement, not external I/O. |
| Stale worker wakes after reclaim | Mutation rejected | No action under its old receipt. |
| Cancellation before admission | `retryable` | Yes, under a new claim. |
| Cancellation after admission | `ambiguous` | No, even if the provider later responds. |

`failBeforeEffect` is a caller assertion, not a network-error classifier. A timeout, abort, disconnected socket, or cancellation alone is insufficient evidence. An earlier asynchronous request must not still be able to complete when you permit a retry.

For `AbortSignal`, call `cancel` with the current receipt at your cancellation boundary. There is no background signal listener or deadline scheduler. If admission races with claim cancellation, only one transition succeeds; after admission you must use the admission receipt. A cancelled request can still produce an external effect.

## Guarantees

- Idempotent registration and one active claim per key across cooperating local processes.
- Strictly increasing fences on successful claims and one admission transition per fence.
- Payload binding checked against persisted state at every receipt mutation.
- No reclamation of admitted, committed, or ambiguous work through lease expiry.
- Idempotent identical settlement and rejection of conflicting terminal outcomes.
- Persistence across process restart, using WAL and `synchronous=FULL` for file databases.
- Persisted clock high-water mark: clock rollback cannot revive authority after expiry has been observed by a mutation, even a rejected one.

The tests cover real concurrent SQLite connections, killed-process recovery, and a seeded 20-worker stress run. Durability still depends on the filesystem and storage honoring SQLite's locking and sync requirements.

## What Fencepoint does not guarantee

Exactly-once external execution, distributed consensus, provider reconciliation, distributed SQLite replication, business-level compensation, or provider-specific idempotency. It cannot stop a worker that ignores the protocol, prevent two differently keyed intents from describing the same effect, or make independent database copies coordinate.

There is no automatic recovery from `admitted` to claimable work, no override for `ambiguous`, and no deletion API. If the admission receipt is lost, the intent remains reserved. Those restrictions trade liveness for avoiding an unproven retry. Restoring an old database backup can also restore old authority; stop and reconcile workers before disaster recovery.

## Design notes

SQLite serializes short write transactions across local connections. No transaction spans external I/O. Claims establish temporary ownership; admission records the irreversible uncertainty boundary; terminal state records what is actually known. SHA-256 binds canonical payloads without authenticating their origin.

See [the design](docs/design.md) for transaction boundaries, clock behavior, crash recovery, and rejected alternatives. Use a local disk, one shared database, and cooperating workers on one host. Network filesystems are unsupported. Calls can block the Node event loop for up to the five-second SQLite busy timeout, plus storage time; use a worker thread if your application requires responsiveness.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

CI runs Node 24 on Ubuntu, macOS, and Windows. Tests inject time and coordinate races with barriers instead of sleeps. See [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md). Licensed under [Apache-2.0](LICENSE).
