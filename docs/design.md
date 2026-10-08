# Execution model

## State machine

| Current state | Operation | Next state | Condition |
|---|---|---|---|
| Absent | `register` | `pending` | Canonical payload is valid. |
| `pending`, `retryable` | `claim` | `claimed` | New owner and fence. |
| `claimed` | `claim` | `claimed` | Previous lease expired; new owner and fence. |
| `claimed` | `renew` | `claimed` | Current receipt and unexpired lease; deadline never decreases. |
| `claimed` | `admit` | `admitted` | Current receipt and unexpired lease. |
| `claimed` | `cancel` | `retryable` | Current receipt and unexpired lease. |
| `admitted` | `commit` | `committed` | Confirmed external result. |
| `admitted` | `markAmbiguous`, `cancel` | `ambiguous` | External outcome is unknown. |
| `admitted` | `failBeforeEffect` | `retryable` | Caller proves the finished attempt cannot apply an effect. |

`committed` and `ambiguous` have no outgoing transitions. A repeated identical settlement returns the existing snapshot without changing its timestamp. A retryable attempt also accepts its identical resolution until a new claim supersedes it; thereafter the old receipt is stale. There is one row per intent, not an attempt history. A new claim clears the previous retryable result.

## Transaction boundaries

Each mutation starts `BEGIN IMMEDIATE`, reads the authoritative row, validates the transition, writes it, and commits. Registration plus claiming occurs in the same transaction. SQLite holds the writer lock across the read and write; there is no check-then-write gap outside the transaction. All variable SQL values are bound parameters.

The transaction also advances a persisted clock watermark. A savepoint encloses the effect transition. On a typed domain or argument rejection, the transition rolls back but the watermark commits. For example, observing expiry and rejecting admission must not permit that same admission later if the wall clock moves backward. Storage errors roll back the entire transaction when it remains open.

No external provider call, await, or application callback runs inside a mutation transaction, except the explicitly injected synchronous clock. Clock implementations must be pure, non-reentrant, and compatible across connections.

An I/O error during a database commit may leave the caller uncertain whether that commit persisted. Re-read the database. Identical settlement can be retried; `admit` cannot be retried into a second authorization. If admission persisted but its receipt was lost, do not perform the external call under an invented replacement receipt.

## Why fencing tokens matter

Lease expiry can let another worker proceed while the original process is still alive. Comparing only timestamps or owner names allows delayed operations from the old attempt to interfere with a new attempt. Each successful claim therefore increments a durable, per-key integer and generates a new opaque owner ID. Mutations compare both, and validate the payload hash and receipt timestamp.

The counter rejects advancement beyond JavaScript's safe integer range instead of wrapping. Renewal preserves the fence but replaces the claim receipt when the deadline changes. An expired receipt cannot renew itself. There is no unfenced reset, release, or settlement operation.

These checks fence SQLite writes, not arbitrary external providers. Admission is a one-use database transition; a JavaScript receipt cannot physically prevent its caller from issuing multiple requests. Workers must follow the protocol and disable automatic retries around the external attempt unless the provider independently makes them safe.

## Why admission is separate from claim

A claimed worker may still be computing, validating, or waiting. If it dies there, another worker can safely repeat that preparation after expiry. Admission records that the worker is crossing into external I/O. A duplicate admission is an error, rather than an idempotent return of permission to call the provider again.

After admission, the existing admission receipt retains settlement authority regardless of lease expiry. There is no replacement owner. This allows slow provider responses to settle while preventing another worker from starting a competing attempt. Admission does not start a timer, call a provider, or monitor worker health.

## Why ambiguity is terminal

An absent response is not evidence of an absent effect. Retrying an ambiguous attempt would convert an explicit unknown into a possible duplicate. `ambiguous` therefore has no automatic or manual transition back to claimable work in this API.

`failBeforeEffect` is deliberately different. Its caller asserts that the attempt is finished and cannot apply an effect, based on evidence outside this library. The runtime does not parse HTTP statuses, exceptions, or provider response bodies to make that decision. A wrong classification defeats the safety model.

Cancellation follows the same boundary: before admission it releases work, afterward it records ambiguity. Cancelling local state or an `AbortSignal` does not establish that the external system stopped. A late success after cancellation cannot overwrite the ambiguous terminal state.

## Crash recovery

| Last durable transition | Recovery |
|---|---|
| Registration | Claim normally. |
| Claim, before admission | Wait for expiry, then claim with a higher fence. |
| Admission, before or after the provider request | Remain reserved; ordinary expiry cannot distinguish these cases. |
| Provider success, before local settlement | Remain reserved. If the result is known, retry settlement with the retained receipt. |
| Terminal settlement | Read the terminal result or repeat the identical settlement. |
| Pre-effect failure | Another worker can claim; the old receipt cannot affect the new fence. |

Startup enables WAL, `synchronous=FULL`, a five-second busy timeout, and an application/schema identity. Unsupported schemas fail closed without changing their journal mode. Concurrent first opens can encounter a journal-mode lock upgrade that bypasses SQLite's busy handler; only this startup step retries `SQLITE_BUSY`, for a bounded five-second window. File databases must actually enter WAL mode; in-memory databases are the documented exception. SQLite builds affected by the [WAL-reset race](https://www.sqlite.org/wal.html#the_wal_reset_bug) are rejected. Use the current Node 24 patch release.

WAL and its shared-memory sidecar belong with the database. Do not copy only the main file while connections are active. Take a supported SQLite backup or close all connections first. Database rollback, deletion, or restoring a stale backup can revive old fences; the library cannot recover ordering information that was removed from its durable store.

## Concurrency model

Independent processes or worker threads open the same local file. Correctness relies on SQLite transactions, not a JavaScript mutex. Races select one valid ordering: a competing claim sees either the previous active lease or the successor; conflicting settlements select one immutable result. Lock contention may raise a SQLite error after the busy timeout. Retrying a database operation never implies that it is safe to retry provider I/O.

The clock is sampled after acquiring the writer lock. Effective time is the maximum of that sample and the stored watermark. Observed time and persisted deadlines never move backward. This does not create a trusted distributed clock: a large forward jump can expire claims early, and a backward adjustment can delay future expiry until the wall clock catches up. Fences still reject superseded workers. Use compatible clocks on one host; the injected clock exists for deterministic tests.

## Payload canonicalization

The encoding accepts a restricted JSON data model. It is a local format, not RFC 8785 or a cross-language canonicalization standard.

- Object keys normalize to NFC and sort lexicographically by UTF-16 code units. Colliding normalized keys reject.
- String values normalize to NFC; unpaired Unicode surrogates reject. Control characters retain their JSON-escaped meaning.
- Arrays preserve order and must be dense ordinary arrays with no extra properties.
- Finite numbers use ECMAScript JSON number formatting; negative zero becomes zero. Precision is JavaScript binary64 precision.
- Only plain or null-prototype objects with enumerable own data properties are accepted. Accessors, proxies, symbols, custom prototypes, dates, and `toJSON` callbacks are not evaluated or converted.
- Undefined, cycles, non-finite numbers, and unsupported values reject. Repeated acyclic references are allowed.
- The encoded value is limited to 1 MiB and depth 64. This bounds stored values, not all memory allocation by a caller constructing an enormous input.

SHA-256 covers the canonical bytes. Registration compares the canonical text as well, rather than relying only on collision resistance. Receipt hashes use fixed-length timing-safe comparison; admission payloads are rehashed at settlement. Payloads returned by the API are recursively frozen snapshots.

Canonicalization changes some inputs. The provider must receive `admitted.payload`, not the pre-normalized object. Intent keys are not normalized; choosing a stable key namespace and deciding which business actions represent the same effect belong to the application.

## Rejected: exactly-once execution

There is no transaction coordinator shared with an arbitrary provider. Reserving before the call leaves a crash gap before actual execution; recording after the call leaves a gap after execution. Moving the local write cannot eliminate both. Provider-enforced idempotency or reconciliation can improve end-to-end guarantees, but those require contracts outside this kernel.

## Rejected: lease expiry implies retryability

An expired lease describes elapsed ownership time. It says nothing about whether an admitted request reached the provider. Treating it as evidence of failure creates duplicate side effects under slow responses or a stalled worker. Expiry reclaims preparation only.

## Rejected: process-local locking

A mutex cannot coordinate separate Node processes, and disappears on restart. SQLite provides the arbitration point that all cooperating local workers observe. Keeping state transitions synchronous and short makes those boundaries explicit.

## Why SQLite is enough here

The unit of coordination is a small row in one durable local database. A single writer is sufficient to serialize these transitions; external I/O happens outside the lock. WAL permits independent local connections without requiring another service. This is intentionally a single-host design. See SQLite's [transaction documentation](https://www.sqlite.org/lang_transaction.html) and [WAL constraints](https://www.sqlite.org/wal.html).

## Known limitations

- No cross-host consensus, replication, network-filesystem support, or coordination between database copies.
- No provider authentication, payload encryption, or hostile-worker isolation. Filesystem access controls the database and its sidecars. Receipts are not security credentials.
- No automatic reconciliation or receipt recovery. A crashed admitted attempt can remain reserved indefinitely.
- No cleanup API, scheduler, bounded intent count, or attempt journal. Terminal rows are retained to preserve idempotency; operators must plan storage growth.
- Synchronous SQLite calls can block the event loop. A busy timeout limits lock waiting, not every possible disk stall.
- No proof of power-loss behavior on every filesystem or storage device. Tests exercise process termination and SQLite recovery, not faulty hardware.
- No automatic cancellation propagation. The application owns `AbortSignal` wiring, provider deadlines, and draining in-flight work before declaring a pre-effect failure.

The smallest reliable deployment is cooperating processes on one host, one local database, stable intent keys, and a provider adapter that classifies uncertainty conservatively.
