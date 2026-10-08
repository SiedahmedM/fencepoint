# Security

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/SiedahmedM/fencepoint/security/advisories/new). Do not post credentials, real payloads, database files, or private infrastructure details in public issues. Include a minimal synthetic reproducer and the affected version.

Sensitive reports include bypasses of stale-receipt rejection, admission reuse, conflicting terminal transitions, payload binding, or conditions that make an uncertain effect automatically retryable. Ordinary bugs and questions about documented limitations can use public issues.

Fencepoint coordinates cooperating workers. It is not a security boundary against code that can write the database, forge receipts, or call a provider directly. Protect the database directory, WAL sidecars, and backups with operating-system access controls. Stored payloads and results are not encrypted. Do not place secrets in intent keys or diagnostic metadata.

Keep Node 24 patched. Use a local filesystem with working SQLite locks and sync semantics, and keep all workers on one authoritative database. Restoring old state while workers continue executing can invalidate fencing guarantees.

An unknown provider result stays unknown. Calling `failBeforeEffect` without proof that the attempt has finished and cannot apply an effect is application misuse; cancellation and timeouts alone are not that proof. The supported security baseline is the latest commit on `main`; no older maintenance branches are promised.
