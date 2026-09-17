#!/usr/bin/env node
/**
 * soroban-ttl-guardian CLI
 *
 * Commands:
 *   check --config <file> --contract <id> [--key <xdr>]
 *   extend --config <file> --contract <id> [--key <xdr>] --days <n>
 *   run --config <file> [--interval <minutes>]
 */
import { Command } from 'commander';
import { loadConfig } from './config';
import { TTLGuardian } from './guardian';

const program = new Command();

program
  .name('ttl-guardian')
  .description('Monitor and auto-extend TTL for Soroban contract instances and storage entries')
  .version('0.1.0');

program
  .command('check')
  .description('Check the current TTL for a contract instance or storage key')
  .requiredOption('-c, --config <file>', 'Path to guardian config JSON file')
  .requiredOption('--contract <id>', 'Stellar contract ID')
  .option('--key <xdr>', 'Ledger key XDR (base64) for a specific storage entry')
  .action(async (opts: { config: string; contract: string; key?: string }) => {
    const config = loadConfig(opts.config);
    const guardian = new TTLGuardian(config);
    const result = await guardian.checkEntry(opts.contract, opts.key);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('extend')
  .description('Extend TTL for a contract instance or storage key')
  .requiredOption('-c, --config <file>', 'Path to guardian config JSON file')
  .requiredOption('--contract <id>', 'Stellar contract ID')
  .option('--key <xdr>', 'Ledger key XDR (base64) for a specific storage entry')
  .requiredOption('--days <n>', 'Number of days to extend TTL to', parseFloat)
  .action(async (opts: { config: string; contract: string; key?: string; days: number }) => {
    const config = loadConfig(opts.config);
    const guardian = new TTLGuardian(config);
    const result = await guardian.extendEntry(opts.contract, opts.key, opts.days);
    console.log(JSON.stringify(result, null, 2));
  });

program
  .command('run')
  .description('Run the guardian (once, or continuously with --interval)')
  .requiredOption('-c, --config <file>', 'Path to guardian config JSON file')
  .option('--interval <minutes>', 'Run continuously every N minutes', parseFloat)
  .action(async (opts: { config: string; interval?: number }) => {
    const config = loadConfig(opts.config);
    const guardian = new TTLGuardian(config);
    if (opts.interval !== undefined) {
      console.log(`Starting guardian, interval=${opts.interval}m. Press Ctrl+C to stop.`);
      guardian.start(opts.interval);
      // Keep process alive until SIGINT
      process.on('SIGINT', () => {
        guardian.stop();
        process.exit(0);
      });
    } else {
      const report = await guardian.runOnce();
      console.log(JSON.stringify(report, null, 2));
    }
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
