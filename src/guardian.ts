// Stub — implemented in subsequent chunks
import { GuardianConfig, GuardianReport, LedgerKeyXdr, TtlCheckResult, TtlExtendResult } from './types';
import { Notifier, ConsoleNotifier } from './notifier';
import { Logger } from './logger';

export class TTLGuardian {
  protected readonly config: GuardianConfig;
  protected readonly notifier: Notifier;
  protected readonly logger: Logger;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(config: GuardianConfig, notifier: Notifier = new ConsoleNotifier()) {
    this.config = config;
    this.notifier = notifier;
    this.logger = new Logger(config.logFile);
  }

  async checkEntry(
    contractId: string,
    key?: LedgerKeyXdr,
  ): Promise<TtlCheckResult> {
    throw new Error('Not implemented — chunk 2');
  }

  async extendEntry(
    contractId: string,
    key: LedgerKeyXdr | undefined,
    extendToDays: number,
  ): Promise<TtlExtendResult> {
    throw new Error('Not implemented — chunk 3');
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
