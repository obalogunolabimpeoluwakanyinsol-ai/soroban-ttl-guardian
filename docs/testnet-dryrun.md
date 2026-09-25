# Testnet Dry-Run: TTL Check/Extend Cycle

This document walks through a real end-to-end TTL check and extend cycle against Soroban
testnet. No code changes required — this uses the `ttl-guardian` CLI against a live
testnet contract.

> **Prerequisites**
> - `npm install && npm run build` in the repo root
> - A testnet fee-payer account with a small XLM balance (≥ 1 XLM is enough)
> - A deployed Soroban contract on testnet (any contract works; use one of yours or
>   deploy the example below)

---

## 1. Fund a testnet fee-payer account

```bash
# Generate a throwaway keypair for testnet
stellar keys generate --network testnet testnet-feepayer
stellar keys address testnet-feepayer

# Fund it via the friendbot
curl "https://friendbot.stellar.org?addr=$(stellar keys address testnet-feepayer)"
```

Get the secret key:
```bash
stellar keys show testnet-feepayer
# prints: S... (keep this secret)
```

---

## 2. Deploy a minimal Soroban contract (optional)

If you don't have a contract already, deploy the soroban hello-world example:

```bash
# Install stellar CLI if not already present
cargo install stellar-cli --features opt

# Clone and build the hello-world contract
git clone https://github.com/stellar/soroban-examples.git
cd soroban-examples/hello_world
cargo build --target wasm32-unknown-unknown --release

# Deploy to testnet (replace S... with your testnet-feepayer secret)
stellar contract deploy \
  --wasm target/wasm32-unknown-unknown/release/soroban_hello_world_contract.wasm \
  --source S... \
  --network testnet
# Output: C... (contract ID — save this)
```

---

## 3. Create a guardian config

```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "feePayerSecret": "S...",
  "feePayerMinBalanceXlm": 1,
  "logFile": "/tmp/testnet-ttl.log",
  "entries": [
    {
      "contractId": "C...",
      "warnThresholdDays": 60,
      "criticalThresholdDays": 10,
      "extendToDays": 120
    }
  ]
}
```

Save this as `testnet-config.json`.

---

## 4. Check the current TTL

```bash
./node_modules/.bin/ts-node src/cli.ts check \
  --config testnet-config.json \
  --contract C...
```

Expected output (values will vary):
```json
{
  "contractId": "C...",
  "key": undefined,
  "ttlLedgers": 518400,
  "ttlEstimatedDays": 36.0
}
```

> `ttlLedgers` is the raw ledger count remaining. `ttlEstimatedDays` converts that to
> wall-clock days using the current average ledger close time (~6 seconds on testnet).

---

## 5. Run a full check cycle

```bash
./node_modules/.bin/ts-node src/cli.ts run \
  --config testnet-config.json
```

If the TTL is above `warnThresholdDays` (60 days in this config), you'll see:
```json
{
  "timestamp": "2025-01-01T00:00:00.000Z",
  "entries": [
    {
      "contractId": "C...",
      "key": null,
      "status": "ok",
      "ttlLedgers": 518400,
      "ttlEstimatedDays": 36.0
    }
  ],
  "feePayer": { "balanceXlm": 9800.0, "isCritical": false },
  "checkedCount": 1,
  "extendedCount": 0,
  "criticalCount": 0,
  "errorCount": 0
}
```

---

## 6. Force an extension by lowering the warn threshold

Temporarily lower `warnThresholdDays` above the current TTL in days to trigger an
actual on-chain extension:

```json
{
  "entries": [
    {
      "contractId": "C...",
      "warnThresholdDays": 999,
      "criticalThresholdDays": 10,
      "extendToDays": 1000
    }
  ]
}
```

Then re-run:
```bash
./node_modules/.bin/ts-node src/cli.ts run \
  --config testnet-config-extend.json
```

Expected output:
```json
{
  "entries": [
    {
      "contractId": "C...",
      "status": "extended",
      "ttlLedgers": 518400,
      "ttlEstimatedDays": 36.0,
      "extension": {
        "contractId": "C...",
        "txHash": "abc123...",
        "newTtlLedgers": 14400000
      }
    }
  ],
  "extendedCount": 1
}
```

The transaction hash is a real, confirmed Soroban transaction on testnet. You can verify
it on the [Stellar Explorer](https://stellar.expert/explorer/testnet).

---

## 7. Inspect the audit log

```bash
cat /tmp/testnet-ttl.log
```

Each line is an NDJSON log entry:
```
{"timestamp":"2025-01-01T00:00:00.000Z","event":"check","contractId":"C...","detail":{"ttlLedgers":518400,"ttlEstimatedDays":36.0}}
{"timestamp":"2025-01-01T00:00:00.100Z","event":"extend_attempt","contractId":"C...","detail":{"extendToDays":1000,"extendToLedgers":14400000}}
{"timestamp":"2025-01-01T00:00:04.200Z","event":"extend_success","contractId":"C...","detail":{"txHash":"abc123...","newTtlLedgers":14400000}}
{"timestamp":"2025-01-01T00:00:04.201Z","event":"run_complete","detail":{"checkedCount":1,"extendedCount":1,"criticalCount":0,"errorCount":0}}
```

---

## What this demonstrates

- `checkEntry` fetches the live ledger entry from Soroban RPC and returns the real TTL
- `extendEntry` builds, signs, submits, and confirms an `ExtendFootprintTtl` operation
- The average ledger close time is computed from real observed ledger data — not hardcoded
- The append-only log captures every event for audit purposes
- Fee-payer balance is checked against the configured minimum every run

This is the same code path used in production. The only difference between this dry-run
and a real deployment is the config values and the contract being watched.
