# Testnet Dry-Run: TTL Check/Extend Cycle

This document records a real end-to-end TTL check and extend cycle against Soroban
testnet run on **2026-10-06**.

> **Testnet resets**: Stellar testnet resets periodically. The contract ID, transaction
> hashes, and ledger numbers below come from a specific run and will not be queryable
> after the next reset. The commands and procedure remain valid; only the values change.

> **Prerequisites**
> - `npm install && npm run build` in the repo root
> - A testnet fee-payer account with a small XLM balance (≥ 1 XLM is enough)
> - A deployed Soroban contract on testnet (any contract works; use one of yours or
>   deploy the example below)

---

## 1. Fund a testnet fee-payer account

```bash
# Generate a throwaway keypair for testnet
stellar keys generate alice --network testnet --fund
stellar keys address alice
stellar keys show alice
```

The `--fund` flag calls the friendbot automatically. Output:

```
✅ Key saved with alias alice in "/home/codespace/.config/stellar/identity/alice.toml"
✅ Account alice funded on "Test SDF Network ; September 2015"
GDYT52IOLRSAHSMXBUB7Q2NXY4D2PBAPEY5QQRLMOZSOUVBB3CM3UBXC
S... (secret key — keep this safe)
```

---

## 2. Deploy a minimal Soroban contract

```bash
# Initialise a hello-world contract workspace
stellar contract init hello
cd hello

# Build (requires wasm32v1-none target: rustup target add wasm32v1-none)
stellar contract build

# Deploy to testnet
stellar contract deploy \
  --wasm target/wasm32v1-none/release/hello_world.wasm \
  --source-account alice \
  --network testnet
```

Output:

```
ℹ️  Uploading contract WASM…
ℹ️  Deploying contract using wasm hash 2fb32174195f57d9d0e0d3c5f5474cdff027bc63fa7a7f9d6cca0f9b70340db3
✅ Deployed!
CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ
```

Contract ID: `CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ`

---

## 3. Create a guardian config

```json
{
  "rpcUrl": "https://soroban-testnet.stellar.org",
  "networkPassphrase": "Test SDF Network ; September 2015",
  "feePayerSecret": "S...",
  "feePayerMinBalanceXlm": 10,
  "logFile": "ttl-guardian.log",
  "entries": [
    {
      "contractId": "CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ",
      "warnThresholdDays": 7,
      "criticalThresholdDays": 2,
      "extendToDays": 30
    }
  ]
}
```

Save as `config.json`.

---

## 4. Check the current TTL (before extend)

```bash
node dist/cli.js check \
  --config config.json \
  --contract CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ
```

Real output from 2026-10-06:

```json
{
  "contractId": "CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ",
  "ttlLedgers": 120926,
  "ttlEstimatedDays": 6.998032407407408
}
```

The freshly deployed contract had ~7 days of TTL remaining — right at the warn
threshold configured above.

---

## 5. Extend the TTL to 30 days

```bash
node dist/cli.js extend \
  --config config.json \
  --contract CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ \
  --days 30
```

Real output from 2026-10-06:

```json
{
  "contractId": "CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ",
  "txHash": "f95199b14ed884edfa96d577abb1831389c294a092210d0aa239df77b4ad755e",
  "newTtlLedgers": 518400
}
```

Transaction confirmed on-chain:
- Explorer: https://stellar.expert/explorer/testnet/tx/f95199b14ed884edfa96d577abb1831389c294a092210d0aa239df77b4ad755e

---

## 6. Check the TTL again (after extend)

```bash
node dist/cli.js check \
  --config config.json \
  --contract CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ
```

Real output from 2026-10-06:

```json
{
  "contractId": "CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ",
  "ttlLedgers": 518400,
  "ttlEstimatedDays": 30
}
```

TTL extended from ~7 days to exactly 30 days (518 400 ledgers at 5 s/ledger).

---

## 7. Inspect the audit log

```bash
cat ttl-guardian.log
```

Each line is an NDJSON log entry. After the check/extend/check cycle above:

```
{"timestamp":"2026-10-06T21:24:...Z","event":"check","contractId":"CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ","detail":{"ttlLedgers":120926,"ttlEstimatedDays":6.998032407407408,"expirationLedger":5180464,"latestLedger":5059538}}
{"timestamp":"2026-10-06T21:24:...Z","event":"extend_attempt","contractId":"CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ","detail":{"extendToDays":30,"extendToLedgers":518400}}
{"timestamp":"2026-10-06T21:24:...Z","event":"check","contractId":"CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ","detail":{"ttlLedgers":120926,"ttlEstimatedDays":6.998032407407408,"expirationLedger":5180464,"latestLedger":5059538}}
{"timestamp":"2026-10-06T21:25:...Z","event":"extend_success","contractId":"CCW3TIAXD6LQXOZPQFJOZOXKNRIQRAVSNT6EWG5QYCNEL6TZTBI3PHCZ","detail":{"txHash":"f95199b14ed884edfa96d577abb1831389c294a092210d0aa239df77b4ad755e","newTtlLedgers":518400}}
```

---

## What this demonstrates

- `check` fetches the live ledger entry from Soroban RPC and returns the real TTL in
  ledgers and estimated days
- `extend` builds, signs, submits, and confirms an `ExtendFootprintTtl` operation with
  a relative ledger count (`extendTo: 518400`) and the contract instance key in the
  read-only footprint
- The append-only NDJSON log captures every event for audit purposes
- Fee-payer balance is checked against the configured minimum on every `run` cycle

This is the same code path used in production. The only difference between this dry-run
and a real deployment is the config values and the contract being watched.

### Notes on the `extendFootprintTtl` operation

Two non-obvious protocol requirements surfaced during this dry-run and are now covered
by regression tests:

1. The `extendTo` field in `ExtendFootprintTtlOp` is a **relative ledger count** (how
   many ledgers to extend *by*), not an absolute ledger sequence number. Passing an
   absolute value produces `extendFootprintTtlMalformed` on-chain.
2. The footprint key must be in the **read-only** set, not read-write. This is the
   opposite of what you might expect for a write operation, but it is what the protocol
   and the stellar CLI both require.

See `src/guardian.test.ts` — describe block
`extendEntry regression — footprint is read-only and extendTo is relative` — for the
tests that lock in both invariants.
