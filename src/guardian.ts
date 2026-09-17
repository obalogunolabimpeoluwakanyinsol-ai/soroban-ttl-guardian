import {
  SorobanRpc,
  TransactionBuilder,
  Networks,
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
    // Contract instance key
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

  async checkEntry(
    contractId: string,
    key?: LedgerKeyXdr,
  ): Promise<TtlCheckResult> {
    await this.refreshAvgCloseSeconds();

    const ledgerKey = this.buildLedgerKey(contractId, key);
    const response = await this.server.getLedgerEntries(ledgerKey);

    if (response.entries.length === 0) {
      throw new Error(
        `No ledger entry found for contract ${contractId}${key ? ` key=${key}` : ' (instance)'}`,
      );
    }

    const entry = response.entries[0];
    const latestLedger = response.latestLedger;
    const expirationLedger = entry.liveUntilLedgerSeq ?? 0;
    const ttlLedgers = Math.max(0, expirationLedger - latestLedger);
    const ttlEstimatedDays = ledgersToDays(ttlLedgers, this.avgCloseSeconds);

    this.logger.log('check', { ttlLedgers, ttlEstimatedDays, expirationLedger, latestLedger }, contractId, key);

    return { contractId, key, ttlLedgers, ttlEstimatedDays };
  }

  /**
   * Extend the TTL for a contract instance or storage key.
   *
   * Submits an ExtendFootprintTTL operation to the Stellar network.
   * The extension target is computed as: current_ledger + daysToLedgers(extendToDays).
   *
   * Every attempt (success or failure) is written to the append-only log.
   * A single entry failing to extend never halts processing of other entries.
   */
  async extendEntry(
    contractId: string,
    key: LedgerKeyXdr | undefined,
    extendToDays: number,
  ): Promise<TtlExtendResult> {
    await this.refreshAvgCloseSeconds();

    const extendToLedgers = daysToLedgers(extendToDays, this.avgCloseSeconds);
    const ledgerKey = this.buildLedgerKey(contractId, key);
    const keyB64 = ledgerKey.toXDR('base64');

    this.logger.log(
      'extend_attempt',
      { extendToDays, extendToLedgers },
      contractId,
      key,
    );

    try {
      const keypair = Keypair.fromSecret(this.config.feePayerSecret);
      const account = await this.server.getAccount(keypair.publicKey());

      const latestLedger = await this.server.getLatestLedger();

      const tx = new TransactionBuilder(account, {
        fee: '100',
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          Operation.extendFootprintTtl({
            extendTo: latestLedger.sequence + extendToLedgers,
          }),
        )
        .setNetworkPassphrase(this.config.networkPassphrase)
        .setTimeout(30)
        .build();

      // Prepare the transaction (sets footprint automatically)
      const preparedTx = await this.server.prepareTransaction(tx);
      preparedTx.sign(keypair);

      const sendResponse = await this.server.sendTransaction(preparedTx);
      if (sendResponse.status === 'ERROR') {
        throw new Error(`Transaction error: ${JSON.stringify(sendResponse.errorResult)}`);
      }

      // Poll for confirmation
      const txHash = sendResponse.hash;
      let getResponse: SorobanRpc.Api.GetTransactionResponse | undefined;
      for (let attempts = 0; attempts < 20; attempts++) {
        await new Promise((r) => setTimeout(r, 1500));
        getResponse = await this.server.getTransaction(txHash);
        if (getResponse.status !== SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
          break;
        }
      }

      if (!getResponse || getResponse.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(
          `Transaction did not confirm: ${getResponse?.status ?? 'timeout'}`,
        );
      }

      // Read back the new TTL
      const checkResult = await this.checkEntry(contractId, key);

      this.logger.log(
        'extend_success',
        { txHash, newTtlLedgers: checkResult.ttlLedgers },
        contractId,
        key,
      );

      return { contractId, key, txHash, newTtlLedgers: checkResult.ttlLedgers };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.logger.log('extend_failure', { error: message }, contractId, key);
      throw err;
    }
  }

  async runOnce(): Promise<GuardianReport> {
    throw new Error('Not implemented — chunk 4');
  }

  start(intervalMinutes: number): void {
    throw new Error('Not implemented — chunk 5');
  }

  stop(): void {
    throw new Error('Not implemented — chunk 5');
  }
}
