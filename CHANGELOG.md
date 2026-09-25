# CHANGELOG.md — soroban-ttl-guardian

Append-only log of changes made during the Stellar Wave Program audit and improvement cycle.
Each entry records what changed, why, and which branch it landed on.

---

## 2026-09-25

### Branch: `feat/tests-and-docs`

**Bug fix — notifier error isolation in `guardian.ts`**
- **What:** Wrapped all `notifier.onCritical()`, `notifier.onFeePayerCritical()`, and
  `notifier.onRunComplete()` calls in try-catch blocks inside `runOnce()` and
  `processEntry()`.
- **Why:** A throwing notifier (e.g., a Slack webhook timeout) was propagating up and
  halting the entire run, leaving subsequent entries unchecked and the run report
  never returned. The documented contract is "one failing entry never halts others" —
  this extends that contract to the notifier layer.
- **Impact:** Non-breaking. Notifier errors are now caught, logged to the NDJSON audit
  log with `hook: 'onCritical'` / `'onFeePayerCritical'` / `'onRunComplete'`, and the
  run continues.

**New unit tests — edge cases and boundary conditions (12 new tests)**
- **What:** Added four new `describe` blocks to `src/guardian.test.ts`, bringing total
  test count from 17 to 29 (all passing):
  1. `TTLGuardian — boundary conditions`
     - TTL exactly 1 ledger above warn threshold → `status=ok`, no extension
     - TTL exactly at warn threshold → `status=extended`
     - Fee-payer balance exactly at minimum → NOT critical (strict `<` check)
     - Fee-payer balance 1 XLM below minimum → IS critical
  2. `TTLGuardian — notifier error isolation`
     - `onCritical` throwing does not halt subsequent entries
     - `onFeePayerCritical` throwing does not crash `runOnce`
  3. `TTLGuardian — onRunComplete optional`
     - Notifier without `onRunComplete` does not crash `runOnce`
     - Notifier with `onRunComplete` receives the full report
  4. `TTLGuardian — start/stop lifecycle`
     - `start()` when already running throws `'Guardian is already running'`
     - `stop()` when not running is a safe no-op
     - `stop()` after `start()` clears the interval, allowing re-start
     - `start()` fires `runOnce()` immediately, then on interval
- **Why:** These were explicitly identified gaps in the audit: boundary math, notifier
  resilience, optional method handling, and lifecycle correctness.

**New doc — testnet dry-run guide**
- **What:** Created `docs/testnet-dryrun.md` with a step-by-step walkthrough of a real
  TTL check and extend cycle against Soroban testnet, including funding a fee-payer,
  deploying a contract, triggering an extension, and reading the NDJSON audit log.
- **Why:** The audit identified the absence of any testnet integration test or dry-run
  documentation. This fills that gap with a reproducible procedure anyone can follow.

**README — "Why this matters" section**
- **What:** Added a new section between "Why this exists" and "Quick start" titled
  "Why this matters".
- **Why:** The evaluation criteria include explaining ecosystem relevance and who
  benefits. The existing README explained the technical problem well but didn't frame
  the tool's network-level value.

**README — testnet dry-run reference**
- **What:** Added a pointer to `docs/testnet-dryrun.md` at the bottom of the README.
- **Why:** Documentation discoverability — the guide is useless if nobody can find it.
