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

---

## 2026-10-06

### Branch: `fix/extend-footprint-bugs`

**Bug fix — `extendEntry` built a malformed `ExtendFootprintTtl` transaction**

Two protocol-level bugs were discovered during the first real testnet dry-run and fixed
in `src/guardian.ts`:

1. **`extendTo` must be a relative ledger count, not an absolute sequence number.**
   The code was passing `latestLedger.sequence + extendToLedgers` as `extendTo`. The
   `ExtendFootprintTtlOp` field is a relative count — how many ledgers to extend *by*
   from the current ledger, not a target absolute sequence. Passing an absolute value
   causes `extendFootprintTtlMalformed` on every submission.
   Fix: pass `extendToLedgers` directly, drop the `getLatestLedger()` call.

2. **Footprint key must be in `readOnly`, not `readWrite`.**
   The code placed the contract instance key in `SorobanDataBuilder.setReadWrite()`.
   For `extendFootprintTtl`, the protocol and the stellar CLI both require the key in
   the read-only footprint. Passing it as read-write produces `extendFootprintTtlMalformed`.
   Fix: change to `SorobanDataBuilder.setReadOnly()`.

**Bug fix — SDK v12 parse error on `getTransaction` for non-`invokeHostFunction` Soroban txs**

The stellar-sdk v12 `getTransaction` parser throws `Bad union switch` when reading back
`extendFootprintTtl` or `restoreFootprint` transactions because it only handles
`invokeHostFunction` result XDR. This caused `extendEntry` to throw even on successful
transactions.
Fix: the polling loop now catches errors whose message contains `Bad union switch` or
`XDR Read Error`, treats them as confirmation (the transaction was already `PENDING`,
not `ERROR`), and re-checks the TTL post-transaction to verify the extension actually
landed.

**New regression tests (2 tests, 33 total)**

Added describe block
`extendEntry regression — footprint is read-only and extendTo is relative`
in `src/guardian.test.ts`. Uses `TxCapturingGuardian`, which overrides `extendEntry`
to replicate the production transaction-building logic and captures the built XDR for
inspection — no live network calls. Tests:
- `footprint key is in readOnly and readWrite is empty` — asserts `readOnly.length === 1`,
  `readWrite.length === 0`, key type is `contractData`.
- `extendTo is a relative ledger count, not an absolute sequence number` — asserts
  `capturedExtendTo === daysToLedgers(30, 5)` (518 400) and that the value is strictly
  less than any plausible current ledger sequence.

**Testnet dry-run doc — replaced placeholders with real run data**

`docs/testnet-dryrun.md` now records the actual 2026-10-06 run:
- Contract: `CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ`
- Check before: 120 926 ledgers (~6.998 days)
- Extend tx: `f95199b14ed884edfa96d577abb1831389c294a092210d0aa239df77b4ad755e`
- Check after: 518 400 ledgers (30.0 days)
Added a testnet-reset warning and a "Notes on the `extendFootprintTtl` operation"
section documenting the two protocol requirements above.

**`config.json` added to `.gitignore`**

`config.json` (which contains the fee-payer secret key) was not previously gitignored.
Added alongside the existing `*.log` and `.env` rules.

**README — corrected ledger-close-time claim**

The Design decisions section claimed the average ledger close time is
"periodically-recomputed". It is not — it uses the `ledgerCloseSeconds` config value
(default 5 s). Updated to accurately describe the behaviour.
