# Contributing

Use Node 24.21.0 or a newer 24.x patch. Fencepoint rejects SQLite versions without the WAL-reset fix. There are no runtime dependencies; development uses TypeScript and Node type definitions.

```bash
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

Keep changes small and state the invariant they preserve. For a correctness fix, include a test that fails before the change. Explain whether a change affects persisted data, receipt validity, retry safety, canonical bytes, or the public API. Changes to the schema or canonicalization format need an explicit compatibility plan.

Use injected clocks and synchronization barriers for tests. Races must use separate SQLite connections in real worker threads or processes; a collection of promises around synchronous calls does not test concurrent database access. Do not use sleeps to decide which operation wins. Test both legal outcomes where ordering is nondeterministic.

Keep provider calls outside database transactions. Prefer explicit states and narrow operations over convenience wrappers that infer whether a failed request is safe to retry. New dependencies or background behavior need a concrete correctness justification. Do not add provider SDKs, a server, or a scheduler to this kernel.

Pull requests should include the problem, the resulting behavior, the relevant test evidence, and any changed limitations. Run the commands above on Node 24; CI also checks Ubuntu, macOS, and Windows. Tests and examples must contain synthetic data only.
