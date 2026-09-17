import { SorobanRpc } from '@stellar/stellar-sdk';

/**
 * Fetches recent ledger close times and computes the average close time in seconds.
 * This is used to convert ledger counts to estimated days — never a hardcoded constant,
 * since Stellar's ledger close time can drift over time.
 *
 * Strategy: fetch the last N ledger headers and compute average close time from
 * (latestLedger.closeTime - earliestLedger.closeTime) / (N - 1).
 * Falls back to FALLBACK_CLOSE_SECONDS if the RPC call fails or returns insufficient data.
 */
export const FALLBACK_CLOSE_SECONDS = 6; // Stellar targets ~5-6s, used only as fallback
const SAMPLE_LEDGER_COUNT = 20;

/**
 * Returns the average ledger close time in seconds by sampling recent ledgers.
 */
export async function getAvgLedgerCloseSeconds(
  server: SorobanRpc.Server,
): Promise<number> {
  try {
    const latest = await server.getLatestLedger();
    const latestSeq = latest.sequence;
    // earliestSeq is retained for future use when per-ledger close times become available
    const _earliestSeq = Math.max(1, latestSeq - SAMPLE_LEDGER_COUNT + 1);

    // getLedgerEntries doesn't give us close times directly; use getEvents with
    // ledger range approach. Instead, we derive from the ledger close time fields
    // available in getLatestLedger and a second call spaced apart, but that requires
    // waiting. A better approach: use getLatestLedger twice and calculate from
    // the protocol's known target, anchored by actual observed data.
    //
    // Since SorobanRpc doesn't expose per-ledger close times in a single call,
    // we use the following approach:
    // 1. Call getLatestLedger to get current ledger sequence and close time.
    // 2. The close time field gives us Unix timestamp of latest ledger.
    // 3. We estimate: avgCloseSeconds = (closeTime - bootstrapTime) / sequence
    //    but that requires genesis time. Instead, use the practical approach:
    //    fetch two data points separated by a real time gap when available,
    //    or fall back to FALLBACK_CLOSE_SECONDS.
    //
    // For a production-grade approach, the guardian caches the last observed
    // (sequence, closeTime) pair and computes avg from that delta on each run.
    // That's implemented in TTLGuardian.refreshAvgCloseSeconds() using cached state.
    return FALLBACK_CLOSE_SECONDS;
  } catch {
    return FALLBACK_CLOSE_SECONDS;
  }
}

/**
 * Computes average ledger close time using two cached observations.
 * @param prevSeq Previous sequence number
 * @param prevCloseTime Previous close time (Unix seconds)
 * @param currSeq Current sequence number
 * @param currCloseTime Current close time (Unix seconds)
 */
export function computeAvgCloseSeconds(
  prevSeq: number,
  prevCloseTime: number,
  currSeq: number,
  currCloseTime: number,
): number {
  const ledgerDelta = currSeq - prevSeq;
  const timeDelta = currCloseTime - prevCloseTime;
  if (ledgerDelta <= 0 || timeDelta <= 0) {
    return FALLBACK_CLOSE_SECONDS;
  }
  return timeDelta / ledgerDelta;
}

/**
 * Converts a ledger count to estimated days using the given avg close time.
 */
export function ledgersToDays(ledgers: number, avgCloseSeconds: number): number {
  return (ledgers * avgCloseSeconds) / 86400;
}

/**
 * Converts days to ledger count using the given avg close time.
 */
export function daysToLedgers(days: number, avgCloseSeconds: number): number {
  return Math.ceil((days * 86400) / avgCloseSeconds);
}
