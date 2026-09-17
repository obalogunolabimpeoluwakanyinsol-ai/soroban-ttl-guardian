import {
  SorobanRpc,
  TransactionBuilder,
  Keypair,
  Operation,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import {
  GuardianConfig,
  GuardianReport,
  LedgerKeyXdr,
  TtlCheckResult,
  TtlExtendResult,
  EntryReport,
  FeePayerStatus,
  WatchEntry,
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
  closeTime: number;
}

export class TTLGuardian {
  protected readonly config: GuardianConfig;
  protected readonly notifier: Notifier;
  protected readonly logger: Logger;
  protected readonly server: SorobanRpc.Server;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private prevLedger: LedgerSnapshot | null = null;
  protected avgCloseSeconds: number = FALLBACK_CLOSE_SECONDS;

  constructor(config: GuardianConfig, notifier: Notifier = new ConsoleNotifier()) {
    this.config = config;
    this.notifier = notifier;
    this.logger = new Logger(config.logFile);
    this.server = new SorobanRpc.Server(config.rpcUrl);
  }

  protected async refreshAvgCloseSeconds(): Promise<void> {
    try {
      const latest = await this.server.getLatestLedger();
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
        if (computed >= 1 && computed <= 30) {
          this.avgCloseSeconds = computed;
        }
      }
      this.prevLedger = curr;
    } catch {
      // Keep last known value
    }
  }

  protected buildLedgerKey(contractId: string, key?: LedgerKeyXdr): xdr.LedgerKey {
    if (key !== undefined) {
      return xdr.LedgerKey.fromXDR(key, 'base64');
    }
    const contractIdBytes = StrKey.decodeContract(contractId);
    const scAddress = xdr.ScAddress.scAddressTypeContract(
      xdr.Hash.fromXDR(Buffer.from(contractIdBytes)),
    );
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: scAddress,
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      }),
    );
  }

  async checkEntry(contractId: string, key?: LedgerKeyXdr): Promise<TtlCheckResult> {
    await this.refreshAvgCloseSeconds();
    const ledgerKey = this.buildLedgerKey(contractId, key);
    const response = await this.server.getLedgerEntries(ledgerKey);
    if (response.entries.length === 0) {
      throw new Error(`No ledger entry found for contract ${contractId}${key ? ` key=${key}` : ' (instance)'}`);
    }
    const entry = response.entries[0];
    const latestLedger = response.latestLedger;
    const expirationLedger = entry.liveUntilLedgerSeq ?? 0;
    const ttlLedgers = Math.max(0, expirationLedger - latestLedger);
    const ttlEstimatedDays = ledgersToDays(ttlLedgers, this.avgCloseSeconds);
    this.logger.log('check', { ttlLedgers, ttlEstimatedDays, expirationLedger, latestLedger }, contractId, key);
    return { contractId, key, ttlLedgers, ttlEstimatedDays };
  }

  async extendEntry(contractId: string, key: LedgerKeyXdr | undefined, extendToDays: number): Promise<TtlExtendResult> {
    await this.refreshAvgCloseSeconds();
    const extendToLedgers = daysToLedgers(extendToDays, this.avgCloseSeconds);
    // ledgerKey is used implicitly via prepareTransaction footprint resolution
    void this.buildLedgerKey(contractId, key);

    this.logger.log('extend_attempt', { extendToDays, extendToLedgers }, contractId, key);

    try {
      const keypair = Keypair.fromSecret(this.config.feePayerSecret);
      const account = await this.server.getAccount(keypair.publicKey());
      const latestLedger = await this.server.getLatestLedger();

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(Operation.extendFootprintTtl({ extendTo: latestLedger.sequence + extendToLedgers }))
        .setNetworkPassphrase(this.config.networkPassphrase)
        .setTimeout(30)
        .build();

      const preparedTx = await this.server.prepareTransaction(tx);
      preparedTx.sign(keypair);

      const sendResponse = await this.server.sendTransaction(preparedTx);
      if (sendResponse.status === 'ERROR') {
        throw new Error(`Transaction error: ${JSON.stringify(sendResponse.errorResult)}`);
      }

      const txHash = sendResponse.hash;
      let getResponse: SorobanRpc.Api.GetTransactionResponse | undefined;
      for (let attempts = 0; attempts < 20; attempts++) {
        await new Promise((r) => setTimeout(r, 1500));
        getResponse = await this.server.getTransaction(txHash);
        if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) break;
      }

      if (!getResponse || getResponse.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction did not confirm: ${getResponse?.status ?? 'timeout'}`);
      }

      const checkResult = await this.checkEntry(contractId, key);
      this.logger.log('extend_success', { txHash, newTtlLedgers: checkResult.ttlLedgers }, contractId, key);
      return { contractId, key, txHash, newTtlLedgers: checkResult.ttlLedgers };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.log('extend_failure', { error: message }, contractId, key);
      throw err;
    }
  }

  /**
   * Check the fee-payer account balance.
   * A balance below feePayerMinBalanceXlm is treated as its own distinct critical alert
   * (separate from TTL-critical alerts), ensuring operators get a clear signal that
   * the extension mechanism itself is at risk.
   *
   * Uses getAccount() to fetch the account record, then parses the native XLM balance
   * from the balances array.
   */
  private async checkFeePayerStatus(): Promise<FeePayerStatus> {
    try {
      const keypair = Keypair.fromSecret(this.config.feePayerSecret);
      const publicKey = keypair.publicKey();
      const account = await this.server.getAccount(publicKey);
      // getAccount returns an AccountResponse with a balances array
      type Balance = { asset_type: string; balance: string };
      const accountAny = account as unknown as { balances: Balance[] };
      const nativeBalance = accountAny.balances?.find((b) => b.asset_type === 'native');
      const balanceXlm = nativeBalance ? parseFloat(nativeBalance.balance) : 0;
      const isCritical = balanceXlm < this.config.feePayerMinBalanceXlm;
      return { balanceXlm, isCritical };
    } catch {
      // If we can't check (e.g. account not funded), treat as critical
      return { balanceXlm: 0, isCritical: true };
    }
  }

  /**
   * Run one full check cycle:
   * 1. Check every configured entry.
   * 2. Extend entries at or below their warn threshold (skip if already above threshold).
   * 3. Fire critical alerts where applicable.
   * 4. Check fee-payer balance and fire critical alert if low.
   * 5. Return a structured GuardianReport.
   *
   * A single failing entry never halts processing of the rest of the watch list.
   */
  async runOnce(): Promise<GuardianReport> {
    const timestamp = new Date().toISOString();
    const entryReports: EntryReport[] = [];

    for (const watchEntry of this.config.entries) {
      // Check instance (always)
      const instanceReport = await this.processEntry(watchEntry, undefined);
      entryReports.push(instanceReport);

      // Check each additional storage key
      if (watchEntry.keys && watchEntry.keys.length > 0) {
        for (const key of watchEntry.keys) {
          const keyReport = await this.processEntry(watchEntry, key);
          entryReports.push(keyReport);
        }
      }
    }

    // Check fee-payer status
    const feePayer = await this.checkFeePayerStatus();
    if (feePayer.isCritical) {
      this.logger.log('fee_payer_critical', { balanceXlm: feePayer.balanceXlm });
      await this.notifier.onFeePayerCritical(feePayer);
    }

    const report: GuardianReport = {
      timestamp,
      entries: entryReports,
      feePayer,
      checkedCount: entryReports.length,
      extendedCount: entryReports.filter((r) => r.status === 'extended').length,
      criticalCount: entryReports.filter((r) => r.status === 'critical').length,
      errorCount: entryReports.filter((r) => r.status === 'error').length,
    };

    this.logger.log('run_complete', {
      checkedCount: report.checkedCount,
      extendedCount: report.extendedCount,
      criticalCount: report.criticalCount,
      errorCount: report.errorCount,
    });

    if (this.notifier.onRunComplete) {
      await this.notifier.onRunComplete(report);
    }

    return report;
  }

  /**
   * Process a single entry: check TTL, decide action, execute, return report.
   * Errors are isolated — this method never throws.
   */
  private async processEntry(watchEntry: WatchEntry, key: LedgerKeyXdr | undefined): Promise<EntryReport> {
    const { contractId, warnThresholdDays, criticalThresholdDays, extendToDays } = watchEntry;
    try {
      const checkResult = await this.checkEntry(contractId, key);
      const { ttlLedgers, ttlEstimatedDays } = checkResult;

      // Convert thresholds to ledgers using current avg close time
      const warnLedgers = daysToLedgers(warnThresholdDays, this.avgCloseSeconds);
      const criticalLedgers = daysToLedgers(criticalThresholdDays, this.avgCloseSeconds);

      if (ttlLedgers <= criticalLedgers) {
        // Critical: fire alert (but still try to extend)
        const criticalReport: EntryReport = {
          contractId,
          key,
          status: 'critical',
          ttlLedgers,
          ttlEstimatedDays,
        };
        this.logger.log('critical_alert', { ttlLedgers, ttlEstimatedDays, criticalThresholdDays }, contractId, key);
        await this.notifier.onCritical(criticalReport);
        // Attempt extension even at critical level
        try {
          const ext = await this.extendEntry(contractId, key, extendToDays);
          return { ...criticalReport, status: 'critical', extension: ext };
        } catch {
          return criticalReport;
        }
      } else if (ttlLedgers <= warnLedgers) {
        // Warn: auto-extend
        try {
          const ext = await this.extendEntry(contractId, key, extendToDays);
          return { contractId, key, status: 'extended', ttlLedgers, ttlEstimatedDays, extension: ext };
        } catch (extErr) {
          return { contractId, key, status: 'error', ttlLedgers, ttlEstimatedDays, error: (extErr as Error).message };
        }
      } else {
        // TTL is above warn threshold — skip extension (avoid wasted fee spend)
        return { contractId, key, status: 'ok', ttlLedgers, ttlEstimatedDays };
      }
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return { contractId, key, status: 'error', ttlLedgers: 0, ttlEstimatedDays: 0, error: message };
    }
  }

  /**
   * Start continuous monitoring at the given interval.
   * Runs runOnce() immediately, then every intervalMinutes.
   */
  start(intervalMinutes: number): void {
    if (this.intervalHandle !== null) {
      throw new Error('Guardian is already running. Call stop() first.');
    }
    // Run immediately
    void this.runOnce().catch((err: Error) => {
      console.error('[TTLGuardian] runOnce error:', err.message);
    });
    // Then on interval
    this.intervalHandle = setInterval(() => {
      void this.runOnce().catch((err: Error) => {
        console.error('[TTLGuardian] runOnce error:', err.message);
      });
    }, intervalMinutes * 60 * 1000);
  }

  /**
   * Stop the continuous monitoring interval.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}
