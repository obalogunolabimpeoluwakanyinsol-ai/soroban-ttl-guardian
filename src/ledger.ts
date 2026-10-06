/**
 * Default ledger close time used when no explicit value is configured.
 * Stellar mainnet targets ~5 s; override via config.ledgerCloseSeconds.
 */
export const FALLBACK_CLOSE_SECONDS = 5;
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
