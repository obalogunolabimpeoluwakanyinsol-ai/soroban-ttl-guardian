import * as fs from 'fs';
import { GuardianConfig, GuardianConfigSchema } from './types';

/**
 * Load and validate a guardian config from a JSON file.
 * Throws a descriptive error if the file is missing or config is invalid.
 */
export function loadConfig(filePath: string): GuardianConfig {
  let raw: unknown;
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    raw = JSON.parse(content);
  } catch (err) {
    throw new Error(`Failed to read config file '${filePath}': ${(err as Error).message}`);
  }

  const result = GuardianConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid guardian config:\n${issues}`);
  }

  return result.data;
}
