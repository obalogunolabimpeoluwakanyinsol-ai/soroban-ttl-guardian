import * as fs from 'fs';
import { LogEntry, LogEventType } from './types';

/**
 * Append-only logger that writes NDJSON (newline-delimited JSON) to a file.
 * Every check and extension attempt is recorded here — not just printed to stdout.
 * This is a monitoring tool; losing the history defeats its purpose.
 */
export class Logger {
  private readonly logFile: string;

  constructor(logFile: string) {
    this.logFile = logFile;
  }

  log(
    event: LogEventType,
    detail: Record<string, unknown>,
    contractId?: string,
    key?: string,
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      event,
      ...(contractId !== undefined && { contractId }),
      ...(key !== undefined && { key }),
      detail,
    };
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(this.logFile, line, 'utf-8');
  }
}
