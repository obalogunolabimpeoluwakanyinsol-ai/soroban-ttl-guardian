import { EntryReport, FeePayerStatus, GuardianReport } from './types';

/**
 * Pluggable notifier interface. Implement this to route alerts to any channel
 * (Slack, PagerDuty, webhook, email, etc.).
 *
 * The console implementation is included. For custom integrations, implement
 * this interface and pass your implementation to TTLGuardian's constructor.
 */
export interface Notifier {
  /**
   * Called when an entry crosses the critical TTL threshold.
   * @param entry The entry report with status === 'critical'
   */
  onCritical(entry: EntryReport): Promise<void>;

  /**
   * Called when the fee-payer account balance drops below the configured minimum.
   * This is a distinct critical alert from TTL-critical alerts.
   */
  onFeePayerCritical(status: FeePayerStatus): Promise<void>;

  /**
   * Called at the end of each runOnce() cycle with the full structured report.
   * Optional — useful for dashboards or aggregated alerting.
   */
  onRunComplete?(report: GuardianReport): Promise<void>;
}

/**
 * Console notifier — the default implementation.
 * Logs critical alerts to stderr and run-complete summaries to stdout.
 */
export class ConsoleNotifier implements Notifier {
  async onCritical(entry: EntryReport): Promise<void> {
    const keyStr = entry.key ? ` key=${entry.key}` : '';
    console.error(
      `[CRITICAL] ${entry.contractId}${keyStr}: TTL=${entry.ttlEstimatedDays.toFixed(2)}d (${entry.ttlLedgers} ledgers)`,
    );
  }

  async onFeePayerCritical(status: FeePayerStatus): Promise<void> {
    console.error(
      `[CRITICAL] Fee-payer balance critically low: ${status.balanceXlm.toFixed(2)} XLM`,
    );
  }

  async onRunComplete(report: GuardianReport): Promise<void> {
    console.log(
      `[RUN COMPLETE] ${report.timestamp}: checked=${report.checkedCount} extended=${report.extendedCount} critical=${report.criticalCount} errors=${report.errorCount}`,
    );
  }
}
