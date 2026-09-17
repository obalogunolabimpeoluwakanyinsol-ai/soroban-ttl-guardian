# Architecture

## Why TTL exists on Soroban

Stellar's ledger is a global state machine. Without limits, contract storage would grow unbounded and full nodes would become impractical to run. Soroban addresses this with **state archival**: every persistent storage entry (including contract instances) has a TTL measured in ledgers. When the TTL expires, the entry transitions from "live" to "archived" — it still exists in archive nodes but is inaccessible on-chain until explicitly restored.

This means:

- A contract with an expired instance TTL cannot be invoked
- A contract with an expired storage key TTL cannot read that key
- Instance and storage key TTLs are tracked **independently** — one can expire while the other remains live

The guardian exists to prevent these expirations from happening silently in production.

## Check → warn → extend → critical-alert flow

```
┌──────────────────────────────────────────────────────────────────────┐
│  runOnce()                                                           │
│                                                                      │
│  For each configured entry (contractId + optional keys):             │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  checkEntry(contractId, key?)                                 │   │
│  │    getLedgerEntries(ledgerKey) -> liveUntilLedgerSeq          │   │
│  │    ttlLedgers = liveUntilLedgerSeq - latestLedger             │   │
│  │    ttlDays = ttlLedgers * avgCloseSeconds / 86400             │   │
│  └───────────────────────┬──────────────────────────────────────┘   │
│                           │                                          │
│                    ┌──────▼──────┐                                   │
│                    │ ttlDays >   │                                   │
│                    │ warnDays?   │                                   │
│                    └──────┬──────┘                                   │
│              YES          │         NO                               │
│         ┌─────────────────┤                                          │
│         │                 │                                          │
│    status=ok         ┌────▼──────────┐                              │
│    (skip, no fee)    │ ttlDays <=    │                              │
│                      │ criticalDays? │                              │
│                      └────┬──────────┘                              │
│                YES        │       NO                                 │
│          ┌────────────────┤                                          │
│          │                │                                          │
│   onCritical()       extendEntry()                                  │
│   (notifier)         status=extended                                │
│   + extendEntry()                                                   │
│   status=critical                                                   │
│                                                                      │
│  After all entries:                                                  │
│  checkFeePayerStatus()                                               │
│    if balance < feePayerMinBalanceXlm:                               │
│      onFeePayerCritical()  <- distinct alert from TTL-critical       │
│                                                                      │
│  return GuardianReport { entries, feePayer, counts, timestamp }      │
└──────────────────────────────────────────────────────────────────────┘
```

## TTL to days conversion

TTL is always stored and computed in **ledgers**. Human-configured thresholds (`warnThresholdDays`, `criticalThresholdDays`, `extendToDays`) are converted to ledgers using a dynamically-computed average ledger close time.

The guardian tracks two consecutive `(sequence, wallClockTime)` observations and computes:

```
avgCloseSeconds = (currTime - prevTime) / (currSeq - prevSeq)
```

This is recomputed on every `checkEntry` call via `refreshAvgCloseSeconds()`. If the computed value is outside the plausible range (1–30 seconds), the previous value is retained. On first run, the fallback constant (6 seconds) is used.

This design ensures the ledger-to-days conversion never silently drifts due to a stale hardcoded constant.

## Skip-if-above-threshold

If an entry's current TTL is already above the warn threshold, `processEntry` returns `status=ok` and calls no extension. This prevents:

- Wasted fee spend on redundant extensions immediately after a successful extension
- Churning the fee-payer account unnecessarily on short polling intervals

The guard is purely ledger-count based — there is no separate time-based minimum re-extension interval.

## Error isolation

`processEntry` never throws. All errors from `checkEntry` or `extendEntry` are caught and returned as `status=error` with the error message. This means one failing entry never halts the run loop for other entries.

## Fee-payer critical alert

Low fee-payer balance is treated as its own distinct `fee_payer_critical` event, separate from TTL `critical_alert` events. This separation is intentional:

- A TTL critical means the contract itself is in danger
- A fee-payer critical means the *guardian mechanism itself* is impaired

Operators may need to respond differently to each.

## Append-only log

Every `check`, `extend_attempt`, `extend_success`, `extend_failure`, `critical_alert`, `fee_payer_critical`, and `run_complete` event is written to an NDJSON log file via `fs.appendFileSync`. The log is never truncated or overwritten. This is the audit trail for what was extended and when.

## Module structure

```
src/
├── types.ts          Config schema (zod), runtime types, log entry types
├── config.ts         Config file loader and validator
├── guardian.ts       TTLGuardian class (checkEntry, extendEntry, runOnce, start, stop)
├── ledger.ts         Ledger-to-days conversion helpers
├── logger.ts         Append-only NDJSON logger
├── notifier.ts       Notifier interface + ConsoleNotifier implementation
├── cli.ts            Commander CLI (check, extend, run commands)
├── index.ts          Public API exports
└── guardian.test.ts  Unit tests (mocked RPC)
```
