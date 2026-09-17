/**
 * soroban-ttl-guardian — Core types
 *
 * TTL is always denominated in ledgers on Stellar. The service converts human-configured
 * "days" thresholds to ledger counts using a periodically-recomputed average ledger
 * close time (never a hardcoded constant).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Config schema (validated with zod at startup)
// ---------------------------------------------------------------------------

/**
 * A single ledger key in XDR base64 format identifying a specific persistent
 * storage entry to watch. Omitting `keys` on a WatchEntry means "watch the
 * contract instance TTL only."
 */
export type LedgerKeyXdr = string;

/**
 * Configuration for a single watched contract or storage entry.
 *
 * - warnThresholdDays: auto-extend when TTL drops to this many days or fewer.
 * - criticalThresholdDays: fire a critical alert when TTL drops to this many days or fewer.
 *   Must be strictly less than warnThresholdDays.
 * - extendToDays: target TTL (in days from now) after a successful extension.
 * - keys: optional list of persistent storage keys to watch in addition to the instance.
 */
export const WatchEntrySchema = z.object({
  contractId: z.string().min(1),
  keys: z.array(z.string()).optional(),
  warnThresholdDays: z.number().positive(),
  criticalThresholdDays: z.number().positive(),
  extendToDays: z.number().positive(),
}).refine(
  (e) => e.criticalThresholdDays < e.warnThresholdDays,
  { message: 'criticalThresholdDays must be less than warnThresholdDays' }
).refine(
  (e) => e.extendToDays > e.warnThresholdDays,
  { message: 'extendToDays must be greater than warnThresholdDays' }
);

export type WatchEntry = z.infer<typeof WatchEntrySchema>;

/**
 * Top-level guardian configuration.
 *
 * Open question resolved: a fee-payer account running low on funds is treated
 * as its own distinct critical alert (separate from TTL-critical alerts) and
 * reported in GuardianReport.feePayer.
 *
 * Open question resolved: the guardian skips re-extending an entry whose
 * current TTL is already above its warnThreshold ("already past threshold,
 * skip" logic). This avoids wasted fee spend on redundant extensions.
 * There is no separate time-based minimum re-extension interval — the
 * ledger-count threshold check is the guard.
 */
export const GuardianConfigSchema = z.object({
  /** Stellar RPC endpoint URL */
  rpcUrl: z.string().url(),
  /** Stellar network passphrase */
  networkPassphrase: z.string().min(1),
  /** Stellar secret key for the fee-payer account */
  feePayerSecret: z.string().min(1),
  /** Minimum fee-payer XLM balance before a low-balance critical alert fires */
  feePayerMinBalanceXlm: z.number().positive().default(10),
  /** Entries to watch */
  entries: z.array(WatchEntrySchema).min(1),
  /** Path to the append-only log file */
  logFile: z.string().min(1).default('ttl-guardian.log'),
});

export type GuardianConfig = z.infer<typeof GuardianConfigSchema>;

// ---------------------------------------------------------------------------
// Runtime types produced by TTLGuardian methods
// ---------------------------------------------------------------------------

/** Result of checking the current TTL for one entry. */
export interface TtlCheckResult {
  contractId: string;
  /** The ledger key XDR if this is a storage-key check; undefined for instance. */
  key: LedgerKeyXdr | undefined;
  /** Current TTL in ledgers remaining. */
  ttlLedgers: number;
  /** Estimated TTL in days, computed from current avg ledger close time. */
  ttlEstimatedDays: number;
}

/** Result of extending TTL for one entry. */
export interface TtlExtendResult {
  contractId: string;
  key: LedgerKeyXdr | undefined;
  /** Transaction hash of the extension transaction. */
  txHash: string;
  /** New TTL in ledgers after extension. */
  newTtlLedgers: number;
}

/** Status of one entry after a runOnce cycle. */
export type EntryStatus = 'ok' | 'extended' | 'critical' | 'error';

export interface EntryReport {
  contractId: string;
  key: LedgerKeyXdr | undefined;
  status: EntryStatus;
  ttlLedgers: number;
  ttlEstimatedDays: number;
  /** Set if status === 'extended' */
  extension?: TtlExtendResult;
  /** Set if status === 'error' */
  error?: string;
}

/** Fee-payer account status included in each GuardianReport. */
export interface FeePayerStatus {
  /** XLM balance of the fee-payer account. */
  balanceXlm: number;
  /** True if balance is below feePayerMinBalanceXlm — fires a critical alert. */
  isCritical: boolean;
}

/** Structured report returned by runOnce(). */
export interface GuardianReport {
  /** ISO-8601 timestamp of when this run started. */
  timestamp: string;
  entries: EntryReport[];
  feePayer: FeePayerStatus;
  /** Total count of entries checked. */
  checkedCount: number;
  /** Count of entries that were extended. */
  extendedCount: number;
  /** Count of entries in critical state. */
  criticalCount: number;
  /** Count of entries that errored. */
  errorCount: number;
}

// ---------------------------------------------------------------------------
// Log entry types (append-only log)
// ---------------------------------------------------------------------------

export type LogEventType =
  | 'check'
  | 'extend_attempt'
  | 'extend_success'
  | 'extend_failure'
  | 'critical_alert'
  | 'fee_payer_critical'
  | 'run_complete';

export interface LogEntry {
  timestamp: string;
  event: LogEventType;
  contractId?: string;
  key?: string;
  detail: Record<string, unknown>;
}
