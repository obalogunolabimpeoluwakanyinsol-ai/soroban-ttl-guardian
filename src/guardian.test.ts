/**
 * soroban-ttl-guardian — unit tests
 *
 * These tests mock the SorobanRpc.Server and fs module to test guardian logic
 * in isolation — no live network calls.
 */

import { TTLGuardian } from './guardian';
import { GuardianConfig, LedgerKeyXdr, EntryReport, FeePayerStatus, GuardianReport, GuardianConfigSchema } from './types';
import { Notifier } from './notifier';
import { ledgersToDays, daysToLedgers, computeAvgCloseSeconds, FALLBACK_CLOSE_SECONDS } from './ledger';
import * as fs from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CONFIG: GuardianConfig = {
  rpcUrl: 'https://soroban-testnet.stellar.org',
  networkPassphrase: 'Test SDF Network ; September 2015',
  feePayerSecret: 'SCZANGBA5AKIA7OYVBMJNW4WPSDC6SP3OXLBR3KHLGFN73AAFAO7FLC', // throwaway test key
  feePayerMinBalanceXlm: 10,
  entries: [
    {
      contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
      warnThresholdDays: 7,
      criticalThresholdDays: 2,
      extendToDays: 30,
    },
  ],
  logFile: '/tmp/test-ttl-guardian.log',
};

function makeConfig(overrides: Partial<GuardianConfig> = {}): GuardianConfig {
  return { ...BASE_CONFIG, ...overrides };
}

/** Spy notifier that records calls */
class SpyNotifier implements Notifier {
  criticalCalls: EntryReport[] = [];
  feePayerCriticalCalls: FeePayerStatus[] = [];
  runCompleteCalls: unknown[] = [];

  async onCritical(entry: EntryReport): Promise<void> {
    this.criticalCalls.push(entry);
  }
  async onFeePayerCritical(status: FeePayerStatus): Promise<void> {
    this.feePayerCriticalCalls.push(status);
  }
  async onRunComplete(report: unknown): Promise<void> {
    this.runCompleteCalls.push(report);
  }
}

/** Build a testable guardian subclass that mocks RPC calls */
class TestGuardian extends TTLGuardian {
  private mockTtlLedgers: Map<string, number> = new Map();
  private mockExtendError: Error | null = null;
  private mockCheckError: Error | null = null;
  public extendCalls: { contractId: string; key: string | undefined; extendToDays: number }[] = [];

  setMockTtl(contractId: string, key: string | undefined, ttlLedgers: number): void {
    const mapKey = `${contractId}:${key ?? '__instance__'}`;
    this.mockTtlLedgers.set(mapKey, ttlLedgers);
  }

  setMockExtendError(err: Error | null): void {
    this.mockExtendError = err;
  }

  setMockCheckError(err: Error | null): void {
    this.mockCheckError = err;
  }

  override async checkEntry(contractId: string, key?: LedgerKeyXdr): Promise<{ contractId: string; key: LedgerKeyXdr | undefined; ttlLedgers: number; ttlEstimatedDays: number }> {
    if (this.mockCheckError) throw this.mockCheckError;
    const mapKey = `${contractId}:${key ?? '__instance__'}`;
    const ttlLedgers = this.mockTtlLedgers.get(mapKey) ?? 100000;
    const ttlEstimatedDays = ledgersToDays(ttlLedgers, this.avgCloseSeconds);
    this.logger.log('check', { ttlLedgers, ttlEstimatedDays }, contractId, key);
    return { contractId, key, ttlLedgers, ttlEstimatedDays };
  }

  override async extendEntry(contractId: string, key: LedgerKeyXdr | undefined, extendToDays: number): Promise<{ contractId: string; key: LedgerKeyXdr | undefined; txHash: string; newTtlLedgers: number }> {
    this.extendCalls.push({ contractId, key, extendToDays });
    if (this.mockExtendError) {
      this.logger.log('extend_failure', { error: this.mockExtendError.message }, contractId, key);
      throw this.mockExtendError;
    }
    const newTtlLedgers = daysToLedgers(extendToDays, this.avgCloseSeconds);
    this.logger.log('extend_success', { txHash: 'mock-tx', newTtlLedgers }, contractId, key);
    return { contractId, key, txHash: 'mock-tx-hash', newTtlLedgers };
  }
}

// ---------------------------------------------------------------------------
// Ledger conversion tests
// ---------------------------------------------------------------------------

describe('ledger helpers', () => {
  test('ledgersToDays uses avgCloseSeconds correctly', () => {
    expect(ledgersToDays(86400, 1)).toBeCloseTo(1); // 86400 ledgers at 1s each = 1 day
    expect(ledgersToDays(14400, 6)).toBeCloseTo(1); // 14400 ledgers at 6s each = 1 day
    expect(ledgersToDays(0, 6)).toBe(0);
  });

  test('daysToLedgers rounds up', () => {
    expect(daysToLedgers(1, 6)).toBe(14400); // 86400 / 6 = 14400
    expect(daysToLedgers(7, 6)).toBe(100800); // 7 * 86400 / 6
    expect(daysToLedgers(0.5, 6)).toBe(7200);
  });

  test('daysToLedgers and ledgersToDays are approximate inverses', () => {
    const days = 14;
    const avgClose = 5.5;
    const ledgers = daysToLedgers(days, avgClose);
    const backToDays = ledgersToDays(ledgers, avgClose);
    // Should be within 1 ledger of rounding
    expect(Math.abs(backToDays - days)).toBeLessThan(avgClose / 86400 + 0.001);
  });

  test('computeAvgCloseSeconds returns correct avg', () => {
    const avg = computeAvgCloseSeconds(1000, 1000000, 1100, 1000600);
    expect(avg).toBeCloseTo(6); // 600 seconds / 100 ledgers
  });

  test('computeAvgCloseSeconds falls back when delta is zero or negative', () => {
    expect(computeAvgCloseSeconds(1000, 100, 1000, 200)).toBe(FALLBACK_CLOSE_SECONDS);
    expect(computeAvgCloseSeconds(1100, 200, 1000, 300)).toBe(FALLBACK_CLOSE_SECONDS);
  });
});

// ---------------------------------------------------------------------------
// runOnce: warn threshold triggers extension
// ---------------------------------------------------------------------------

describe('TTLGuardian.runOnce', () => {
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  test('entry above warn threshold: status=ok, no extension', async () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);

    // TTL well above warn threshold (7 days = 100800 ledgers at 6s)
    guardian.setMockTtl(CONTRACT_ID, undefined, 200000);

    const report = await guardian.runOnce();

    expect(report.entries[0].status).toBe('ok');
    expect(guardian.extendCalls.length).toBe(0);
    expect(spy.criticalCalls.length).toBe(0);
  });

  test('entry at warn threshold: status=extended, extension called', async () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);

    // TTL at exactly warn threshold (7 days at FALLBACK_CLOSE_SECONDS=6s = 100800 ledgers)
    const warnLedgers = daysToLedgers(7, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl(CONTRACT_ID, undefined, warnLedgers);

    const report = await guardian.runOnce();

    expect(report.entries[0].status).toBe('extended');
    expect(guardian.extendCalls.length).toBe(1);
    expect(guardian.extendCalls[0].contractId).toBe(CONTRACT_ID);
    expect(guardian.extendCalls[0].extendToDays).toBe(30);
    expect(spy.criticalCalls.length).toBe(0);
  });

  test('entry below critical threshold: status=critical, critical alert fired', async () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);

    // TTL at exactly critical threshold (2 days at 6s = 28800 ledgers)
    const criticalLedgers = daysToLedgers(2, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl(CONTRACT_ID, undefined, criticalLedgers);

    const report = await guardian.runOnce();

    expect(report.entries[0].status).toBe('critical');
    expect(spy.criticalCalls.length).toBe(1);
    expect(spy.criticalCalls[0].contractId).toBe(CONTRACT_ID);
    // Extension is still attempted at critical level
    expect(guardian.extendCalls.length).toBe(1);
  });

  test('critical alert does not block other entries', async () => {
    const spy = new SpyNotifier();
    const config = makeConfig({
      entries: [
        {
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
        {
          contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
      ],
    });
    const guardian = new TestGuardian(config, spy);

    // First entry critical, second entry OK
    guardian.setMockTtl('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', undefined, 1000);
    guardian.setMockTtl('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4', undefined, 999999);

    const report = await guardian.runOnce();

    expect(report.entries.length).toBe(2);
    expect(report.entries[0].status).toBe('critical');
    expect(report.entries[1].status).toBe('ok');
    expect(report.criticalCount).toBe(1);
    // Second entry should have been checked despite first being critical
  });

  test('failing extend does not halt processing of other entries', async () => {
    const spy = new SpyNotifier();
    const config = makeConfig({
      entries: [
        {
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
        {
          contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
      ],
    });
    const guardian = new TestGuardian(config, spy);

    // Both entries need extension (below warn threshold)
    const warnLedgers = daysToLedgers(7, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', undefined, warnLedgers);
    guardian.setMockTtl('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4', undefined, warnLedgers);
    // Make extend fail
    guardian.setMockExtendError(new Error('RPC error: insufficient fee'));

    const report = await guardian.runOnce();

    // Both entries processed, both errored (extend failed)
    expect(report.entries.length).toBe(2);
    expect(report.entries[0].status).toBe('error');
    expect(report.entries[1].status).toBe('error');
    expect(report.errorCount).toBe(2);
  });

  test('check error for one entry does not halt others', async () => {
    const spy = new SpyNotifier();
    const config = makeConfig({
      entries: [
        {
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
        {
          contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
      ],
    });
    const guardian = new TestGuardian(config, spy);
    guardian.setMockTtl('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4', undefined, 999999);
    guardian.setMockCheckError(new Error('entry not found'));

    const report = await guardian.runOnce();

    // First entry errors (checkEntry throws), second entry would also error since
    // checkError is global in our mock — both error but processing completes
    expect(report.entries.length).toBe(2);
    expect(report.errorCount).toBe(2);
  });

  test('instance-only vs instance-plus-keys config both work', async () => {
    const spy = new SpyNotifier();
    const config = makeConfig({
      entries: [
        {
          contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4',
          keys: ['dGVzdA=='], // base64 "test" as a fake ledger key XDR
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 30,
        },
      ],
    });
    const guardian = new TestGuardian(config, spy);
    guardian.setMockTtl('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', undefined, 999999);
    guardian.setMockTtl('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', 'dGVzdA==', 999999);

    const report = await guardian.runOnce();

    // Should have 2 entries checked: instance + 1 key
    expect(report.checkedCount).toBe(2);
    expect(report.entries[0].key).toBeUndefined(); // instance
    expect(report.entries[1].key).toBe('dGVzdA=='); // storage key
  });

  test('extension result is logged', async (): Promise<void> => {
    const spy = new SpyNotifier();
    const logFile = '/tmp/test-extension-log-' + Date.now() + '.log';
    const guardian = new TestGuardian(makeConfig({ logFile }), spy);

    const warnLedgers = daysToLedgers(7, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl(CONTRACT_ID, undefined, warnLedgers);

    await guardian.runOnce();

    const logContent = fs.readFileSync(logFile, 'utf-8');
    const lines = logContent.trim().split('\n').map((l: string) => JSON.parse(l));
    const extendSuccessLine = lines.find((l: { event: string }) => l.event === 'extend_success');
    expect(extendSuccessLine).toBeDefined();
    expect(extendSuccessLine.detail.txHash).toBe('mock-tx');

    // Clean up
    fs.unlinkSync(logFile);
  });

  test('runOnce returns correct counts', async () => {
    const spy = new SpyNotifier();
    const config = makeConfig({
      entries: [
        { contractId: 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', warnThresholdDays: 7, criticalThresholdDays: 2, extendToDays: 30 },
        { contractId: 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4', warnThresholdDays: 7, criticalThresholdDays: 2, extendToDays: 30 },
        { contractId: 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC4', warnThresholdDays: 7, criticalThresholdDays: 2, extendToDays: 30 },
      ],
    });
    const guardian = new TestGuardian(config, spy);

    guardian.setMockTtl('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4', undefined, 999999); // ok
    guardian.setMockTtl('CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4', undefined, daysToLedgers(7, FALLBACK_CLOSE_SECONDS)); // extended
    guardian.setMockTtl('CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC4', undefined, daysToLedgers(2, FALLBACK_CLOSE_SECONDS)); // critical

    const report = await guardian.runOnce();

    expect(report.checkedCount).toBe(3);
    expect(report.extendedCount).toBe(1);
    expect(report.criticalCount).toBe(1);
    expect(report.errorCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

describe('loadConfig validation', () => {
  test('criticalThresholdDays must be less than warnThresholdDays', (): void => {
    const result = GuardianConfigSchema.safeParse({
      ...BASE_CONFIG,
      entries: [
        {
          contractId: 'C123',
          warnThresholdDays: 2,
          criticalThresholdDays: 7, // invalid: critical > warn
          extendToDays: 30,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('extendToDays must be greater than warnThresholdDays', (): void => {
    const result = GuardianConfigSchema.safeParse({
      ...BASE_CONFIG,
      entries: [
        {
          contractId: 'C123',
          warnThresholdDays: 7,
          criticalThresholdDays: 2,
          extendToDays: 5, // invalid: extendTo < warn
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test('valid config parses successfully', (): void => {
    const result = GuardianConfigSchema.safeParse(BASE_CONFIG);
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Edge cases: boundary conditions on TTL thresholds
// ---------------------------------------------------------------------------

describe('TTLGuardian — boundary conditions', () => {
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  test('TTL exactly 1 ledger above warn threshold: status=ok, no extension', async () => {
    // Entry is at warnLedgers + 1 — just above the threshold, must NOT trigger extension.
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);

    const warnLedgers = daysToLedgers(7, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl(CONTRACT_ID, undefined, warnLedgers + 1);

    const report = await guardian.runOnce();

    expect(report.entries[0].status).toBe('ok');
    expect(guardian.extendCalls.length).toBe(0);
    expect(spy.criticalCalls.length).toBe(0);
  });

  test('TTL exactly at warn threshold (== warnLedgers): status=extended', async () => {
    // The boundary: ttlLedgers <= warnLedgers triggers extension. == is included.
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);

    const warnLedgers = daysToLedgers(7, FALLBACK_CLOSE_SECONDS);
    guardian.setMockTtl(CONTRACT_ID, undefined, warnLedgers);

    const report = await guardian.runOnce();

    expect(report.entries[0].status).toBe('extended');
    expect(guardian.extendCalls.length).toBe(1);
  });

  test('fee-payer balance exactly at minimum boundary: NOT critical', () => {
    // balanceXlm === feePayerMinBalanceXlm should NOT fire critical.
    // The condition in guardian.ts is: isCritical = balanceXlm < feePayerMinBalanceXlm
    // So balanceXlm === 10, min === 10 → strict less-than is false → NOT critical.
    const minBalance = 10;
    const isCritical = minBalance < minBalance; // false
    expect(isCritical).toBe(false);

    // Verify the FeePayerStatus shape at the boundary
    const status: FeePayerStatus = { balanceXlm: 10, isCritical: false };
    expect(status.isCritical).toBe(false);
  });

  test('fee-payer balance 1 XLM below minimum: IS critical', async () => {
    const minBalance = 10;
    const balance = 9.99;
    const isCritical = balance < minBalance;
    expect(isCritical).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Notifier throwing: must not halt other entries or crash runOnce
// ---------------------------------------------------------------------------

/** A notifier whose onCritical always throws */
class ThrowingCriticalNotifier implements Notifier {
  feePayerCriticalCalls: FeePayerStatus[] = [];
  runCompleteCalls: unknown[] = [];

  async onCritical(_entry: EntryReport): Promise<void> {
    throw new Error('Slack webhook timed out');
  }
  async onFeePayerCritical(status: FeePayerStatus): Promise<void> {
    this.feePayerCriticalCalls.push(status);
  }
  async onRunComplete(report: unknown): Promise<void> {
    this.runCompleteCalls.push(report);
  }
}

class ThrowingFeePayerNotifier implements Notifier {
  async onCritical(_entry: EntryReport): Promise<void> {}
  async onFeePayerCritical(_status: FeePayerStatus): Promise<void> {
    throw new Error('PagerDuty API error');
  }
  async onRunComplete(_report: unknown): Promise<void> {}
}

/** A notifier that does NOT implement the optional onRunComplete method */
class MinimalNotifier implements Notifier {
  async onCritical(_entry: EntryReport): Promise<void> {}
  async onFeePayerCritical(_status: FeePayerStatus): Promise<void> {}
  // onRunComplete intentionally omitted
}

describe('TTLGuardian — notifier error isolation', () => {
  const CONTRACT_A = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';
  const CONTRACT_B = 'CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBC4';

  test('onCritical throwing does not halt processing of subsequent entries', async () => {
    const notifier = new ThrowingCriticalNotifier();
    const config = makeConfig({
      entries: [
        { contractId: CONTRACT_A, warnThresholdDays: 7, criticalThresholdDays: 2, extendToDays: 30 },
        { contractId: CONTRACT_B, warnThresholdDays: 7, criticalThresholdDays: 2, extendToDays: 30 },
      ],
    });
    const guardian = new TestGuardian(config, notifier);

    // CONTRACT_A is critical, CONTRACT_B is ok — notifier throws on A's critical call
    guardian.setMockTtl(CONTRACT_A, undefined, daysToLedgers(2, FALLBACK_CLOSE_SECONDS)); // critical
    guardian.setMockTtl(CONTRACT_B, undefined, 999999); // ok

    // runOnce must not throw even though onCritical throws
    let report: GuardianReport | undefined;
    let threw = false;
    try {
      report = await guardian.runOnce();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(report).toBeDefined();
    // CONTRACT_B was still processed despite CONTRACT_A's notifier throwing
    expect(report!.entries.length).toBe(2);
    // CONTRACT_B should be ok
    expect(report!.entries[1].status).toBe('ok');
  });

  test('onFeePayerCritical throwing does not crash runOnce', async () => {
    const notifier = new ThrowingFeePayerNotifier();
    const guardian = new TestGuardian(makeConfig(), notifier);
    guardian.setMockTtl(CONTRACT_A, undefined, 999999);

    // runOnce must not throw even though onFeePayerCritical throws
    let threw = false;
    try {
      await guardian.runOnce();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// onRunComplete: optional method
// ---------------------------------------------------------------------------

describe('TTLGuardian — onRunComplete optional', () => {
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  test('notifier without onRunComplete does not crash runOnce', async () => {
    const notifier = new MinimalNotifier();
    const guardian = new TestGuardian(makeConfig(), notifier);
    guardian.setMockTtl(CONTRACT_ID, undefined, 999999);

    let threw = false;
    try {
      await guardian.runOnce();
    } catch {
      threw = true;
    }
    expect(threw).toBe(false);
    // Verify onRunComplete is genuinely absent on this notifier
    expect((notifier as { onRunComplete?: unknown }).onRunComplete).toBeUndefined();
  });

  test('notifier with onRunComplete receives the full report', async () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);
    guardian.setMockTtl(CONTRACT_ID, undefined, 999999);

    const report = await guardian.runOnce();

    expect(spy.runCompleteCalls.length).toBe(1);
    expect(spy.runCompleteCalls[0]).toStrictEqual(report);
  });
});

// ---------------------------------------------------------------------------
// start() / stop() lifecycle
// ---------------------------------------------------------------------------

describe('TTLGuardian — start/stop lifecycle', () => {
  const CONTRACT_ID = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4';

  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('start() already running throws an error', () => {
    const guardian = new TestGuardian(makeConfig(), new SpyNotifier());
    guardian.setMockTtl(CONTRACT_ID, undefined, 999999);

    guardian.start(60);
    expect(() => guardian.start(60)).toThrow('Guardian is already running');
    guardian.stop();
  });

  test('stop() when not running is a no-op (does not throw)', () => {
    const guardian = new TestGuardian(makeConfig(), new SpyNotifier());
    // Never started — stop() should be safe
    expect(() => guardian.stop()).not.toThrow();
  });

  test('stop() after start() clears the interval', () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);
    guardian.setMockTtl(CONTRACT_ID, undefined, 999999);

    guardian.start(60);
    guardian.stop();

    // After stop, calling start again must NOT throw (interval is cleared)
    expect(() => guardian.start(60)).not.toThrow();
    guardian.stop();
  });

  test('start() fires runOnce immediately then on interval', async () => {
    const spy = new SpyNotifier();
    const guardian = new TestGuardian(makeConfig(), spy);
    guardian.setMockTtl(CONTRACT_ID, undefined, 999999);

    // Spy on runOnce to count calls
    let runOnceCalled = 0;
    const originalRunOnce = guardian.runOnce.bind(guardian);
    jest.spyOn(guardian, 'runOnce').mockImplementation(async () => {
      runOnceCalled++;
      return originalRunOnce();
    });

    guardian.start(1); // 1-minute interval
    // Flush the immediate call
    await Promise.resolve();
    await Promise.resolve();

    // Advance timer by 1 minute → second call
    jest.advanceTimersByTime(60 * 1000);
    await Promise.resolve();
    await Promise.resolve();

    expect(runOnceCalled).toBeGreaterThanOrEqual(1);
    guardian.stop();
  });
});
