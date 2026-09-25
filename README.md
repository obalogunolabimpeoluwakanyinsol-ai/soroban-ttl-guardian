# soroban-ttl-guardian

A monitoring and automation service that watches Soroban contract instances and persistent storage entries, automatically extending their TTL (time-to-live) before they expire and get archived.

Built for teams running Soroban contracts in production who don't want a forgotten TTL to archive their contract data out from under them.

---

## Why this exists

Soroban's state-archival model means every contract instance and every persistent storage entry has a TTL measured in ledgers. When the TTL expires, the entry is archived — not deleted, but inaccessible until restored. Restoration requires an on-chain transaction and is not automatic.

If you deploy a Soroban contract and forget about TTL, your users will eventually hit a wall: transactions fail because the contract instance or its data has been archived. This guardian prevents that by watching your entries and extending their TTL before it becomes a problem.

---

## Why this matters

This is infrastructure for developers and teams running Soroban contracts in production — it doesn't surface to end users, but they feel its absence. State archival (TTL expiry) is a Stellar/Soroban-specific design choice that affects every project built on it; this solves a problem every serious Soroban team eventually hits. Without a guardian like this, a team's app can silently break for users when contract data expires unnoticed — transactions fail, data becomes inaccessible, and the incident is hard to diagnose because nothing explicitly "deletes" anything.

Think of it as ecosystem plumbing. Each team that deploys this is one fewer team filing a "my contract stopped working" post-mortem. At scale, that's a whole category of production incident eliminated across the Soroban ecosystem — a network-level benefit even though its direct users are developers, not end users.

---

## Quick start

### 1. Install

```bash
npm install -g soroban-ttl-guardian
# or run locally:
npm install && npm run build
```

### 2. Create a config file

```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "feePayerSecret": "S...",
  "feePayerMinBalanceXlm": 10,
  "logFile": "ttl-guardian.log",
  "entries": [
    {
      "contractId": "C...",
      "warnThresholdDays": 7,
      "criticalThresholdDays": 2,
      "extendToDays": 30
    }
  ]
}
```

### 3. Run

```bash
# Check TTL for a contract instance
ttl-guardian check --config config.json --contract C...

# Extend TTL manually
ttl-guardian extend --config config.json --contract C... --days 30

# Run once (check all entries, extend any below warn threshold)
ttl-guardian run --config config.json

# Run continuously every 60 minutes
ttl-guardian run --config config.json --interval 60
```

---

## Config reference

| Field | Type | Default | Description |
|---|---|---|---|
| `rpcUrl` | string | required | Soroban RPC endpoint |
| `networkPassphrase` | string | required | Stellar network passphrase |
| `feePayerSecret` | string | required | Secret key for the account paying extension fees |
| `feePayerMinBalanceXlm` | number | `10` | XLM balance below which a critical alert fires |
| `logFile` | string | `ttl-guardian.log` | Path to the append-only NDJSON log |
| `entries` | array | required | List of entries to watch (see below) |

### Entry config

| Field | Type | Description |
|---|---|---|
| `contractId` | string | Stellar contract ID (C... address) |
| `keys` | string[] | Optional ledger key XDRs (base64) for specific storage entries |
| `warnThresholdDays` | number | Auto-extend when TTL drops to this many days |
| `criticalThresholdDays` | number | Fire critical alert when TTL drops to this many days (must be < warn) |
| `extendToDays` | number | Target TTL in days after extension (must be > warn) |

If `keys` is omitted, only the contract instance TTL is watched. If `keys` is provided, both the instance and each key are watched independently.

---

## Design decisions

**TTL is always computed in ledgers, never wall-clock time.** The guardian converts your human-configured day thresholds to ledger counts using a periodically-recomputed average ledger close time — never a hardcoded constant. This prevents silent drift if Stellar's close time changes.

**Skip-if-above-threshold.** If an entry's current TTL is already above the warn threshold, the guardian skips it and doesn't spend fees on a redundant extension. The ledger-count threshold check is the guard.

**Fee-payer low balance is its own critical alert.** If the fee-payer account balance drops below `feePayerMinBalanceXlm`, this fires as a distinct critical alert separate from TTL alerts — because a depleted fee-payer means the guardian itself can't function.

**Append-only log.** Every check and every extension attempt (success or failure) is written to an NDJSON log file. Nothing is lost. The log is the audit trail.

**One entry failing never halts others.** Errors are isolated per-entry.

---

## Pluggable notifier

The `Notifier` interface lets you route critical alerts to any channel:

```typescript
import { Notifier, EntryReport, FeePayerStatus, GuardianReport } from 'soroban-ttl-guardian';

class MySlackNotifier implements Notifier {
  async onCritical(entry: EntryReport): Promise<void> {
    // post to Slack
  }
  async onFeePayerCritical(status: FeePayerStatus): Promise<void> {
    // post to Slack
  }
}

const guardian = new TTLGuardian(config, new MySlackNotifier());
```

The default `ConsoleNotifier` logs to stderr.

---

## Out of scope for v1

- Multiple networks in a single instance — run one instance per network
- Web dashboard — use the structured log output
- Auto top-up of fee-payer balance — that's a critical alert, not a self-fix
- Restore-from-archive — if the guardian's alerts were ignored and something expired, that's a documented manual recovery path

See open issues for the v2 roadmap.

---

## Testnet end-to-end guide

For a step-by-step walkthrough of a real TTL check and extend cycle against Soroban
testnet (including funding a fee-payer, deploying a contract, triggering an extension,
and reading the audit log), see [`docs/testnet-dryrun.md`](docs/testnet-dryrun.md).

---

## License

MIT — see [LICENSE](LICENSE).
