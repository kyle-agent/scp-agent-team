import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditRecord } from '@scp/contracts';

/**
 * Append-only audit log (SPEC §18).
 *
 * Every invocation is recorded with its access_mode, so Local Agent and Portal
 * usage can be compared directly. One JSON object per line - trivially shippable
 * to Loki/Elastic later.
 */
export class AuditLog {
  constructor(private readonly filePath?: string) {
    if (filePath) mkdirSync(dirname(filePath), { recursive: true });
  }

  write(record: AuditRecord): void {
    const line = JSON.stringify(record);
    if (this.filePath) {
      try {
        appendFileSync(this.filePath, line + '\n');
      } catch (err) {
        console.error('[audit] write failed:', (err as Error).message);
      }
    }
    console.log(`[audit] ${line}`);
  }
}
