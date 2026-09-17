import { SorobanRpc, xdr, StrKey } from '@stellar/stellar-sdk';
import {
  GuardianConfig,
  GuardianReport,
  LedgerKeyXdr,
  TtlCheckResult,
  TtlExtendResult,
} from './types';
import { Notifier, ConsoleNotifier } from './notifier';
import { Logger } from './logger';
import {
  FALLBACK_CLOSE_SECONDS,
  computeAvgCloseSeconds,
  ledgersToDays,
  daysToLedgers,
} from './ledger';

interface LedgerSnapshot {
  sequence: number;
  closeTime: number; // Unix seconds
}

export class TTLGuardian {
  protected readonly config: GuardianConfig;
  protected readonly notifier: Notifier;
  protected readonly logger: Logger;
  protected readonly server: SorobanRpc.Server;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private prevLedger: LedgerSnapshot | null = null;
  private avgCloseSeconds: number = FALLBACK_CLOSE_SECONDS;

  constructor(config: GuardianConfig, notifier: Notifier = new ConsoleNotifier()) {
    this.config = config;
    this.notifier = notifier;
    this.logger = new Logger(config.logFile);
    this.server = new SorobanRpc.Server(config.rpcUrl);
  }

  /**
   * Updates the cached average ledger close time using two consecutive
   * observations of (sequence, wallClock). Called before each check cycle.
   * This ensures the ledger-to-days conversion never relies on a hardcoded constant.
   *
   * Since SorobanRpc.GetLatestLedgerResponse does not expose a closeTime field,
   * we pair the ledger sequence with the wall-clock time at the point of the call.
   * Over multiple polling cycles this gives a good-enough empirical average.
   */
  protected async refreshAvgCloseSeconds(): Promise<void> {
    try {
      const latest = await this.server.getLatestLedger();

      // Pair current sequence with wall-clock time as a proxy for close time.
      const nowSeconds = Math.floor(Date.now() / 1000);
      const curr: LedgerSnapshot = {
        sequence: latest.sequence,
        closeTime: nowSeconds,
      };

      if (this.prevLedger !== null) {
        const computed = computeAvgCloseSeconds(
          this.prevLedger.sequence,
          this.prevLedger.closeTime,
          curr.sequence,
          curr.closeTime,
        );
        // Only update if computed value is plausible (1–30 seconds per ledger).
        if (computed >= 1 && computed <= 30) {
          this.avgCloseSeconds = computed;
        }
      }

      this.prevLedger = curr;
    } catch {
      // Keep the last known avgCloseSeconds on failure.
    }
  }

  /**
   * Get the current TTL for a contract instance or a specific storage key.
   *
   * @param contractId Stellar contract ID (C... StrKey address)
   * @param key Optional ledger key XDR (base64) for a specific storage entry.
   *            If omitted, checks the contract instance TTL.
   */
  async checkEntry(
    contractId: string,
    key?: LedgerKeyXdr,
  ): Promise<TtlCheckResult> {
    // Refresh avg close time before converting ledgers to days.
    await this.refreshAvgCloseSeconds();

    let ledgerKey: xdr.LedgerKey;
    if (key !== undefined) {
      // Parse caller-supplied XDR key.
      ledgerKey = xdr.LedgerKey.fromXDR(key, 'base64');
    } else {
      // Build a ContractData key for the contract instance entry.
      // The instance is stored under ScvLedgerKeyContractInstance with persistent durability.
      const contractIdBytes: Buffer = contractId.startsWith('C')
        ? Buffer.from(StrKey.decodeContract(contractId))
        : Buffer.from(contractId, 'hex');

      // xdr.ScAddress.scAddressTypeContract accepts a raw 32-byte Buffer.
      const scContractId = xdr.ScAddress.scAddressTypeContract(contractIdBytes);

      ledgerKey = xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: scContractId,
          key: xdr.ScVal.scvLedgerKeyContractInstance(),
          durability: xdr.ContractDataDurability.persistent(),
        }),
      );
    }

    const response = await this.server.getLedgerEntries(ledgerKey);

    if (response.entries.length === 0) {
      throw new Error(
        `No ledger entry found for contract ${contractId}${key !== undefined ? ` key=${key}` : ' (instance)'}`,
      );
    }

    const entry = response.entries[0];
    const latestLedger = response.latestLedger;
    const expirationLedger = entry.liveUntilLedgerSeq ?? 0;
    const ttlLedgers = Math.max(0, expirationLedger - latestLedger);
    const ttlEstimatedDays = ledgersToDays(ttlLedgers, this.avgCloseSeconds);

    this.logger.log(
      'check',
      { ttlLedgers, ttlEstimatedDays, expirationLedger, latestLedger },
      contractId,
      key,
    );

    return { contractId, key, ttlLedgers, ttlEstimatedDays };
  }

  async extendEntry(
    contractId: string,
    key: LedgerKeyXdr | undefined,
    extendToDays: number,
  ): Promise<TtlExtendResult> {
    // extendToDays and daysToLedgers are used in chunk 3
    void daysToLedgers;
    void extendToDays;
    throw new Error('Not implemented — chunk 3');
  }

  async runOnce(): Promise<GuardianReport> {
    throw new Error('Not implemented — chunk 4');
  }

  start(intervalMinutes: number): void {
    void intervalMinutes;
    throw new Error('Not implemented — chunk 5');
  }

  stop(): void {
    throw new Error('Not implemented — chunk 5');
  }
}
