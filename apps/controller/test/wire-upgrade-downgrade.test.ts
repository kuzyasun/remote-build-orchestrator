import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { negotiateProtocolVersion } from '@rbo/protocol';
import { RBO_WIRE_PROTOCOL_MAX_VERSION, RBO_WIRE_PROTOCOL_MIN_VERSION } from '@rbo/shared';
import { describe, expect, it } from 'vitest';
import {
  getSchemaVersion,
  migrateDown,
  migrateToLatest,
  migrateUp,
  openDatabase,
} from '../src/storage/database.js';
import { MIGRATIONS } from '../src/storage/migrations.js';

/** Peer is eligible for lease/data tokens only when negotiation succeeds. */
function assertPeerEligibleForLease(negotiated: number | null): asserts negotiated is number {
  if (negotiated === null) {
    throw new Error('incompatible_protocol_peer');
  }
}

describe('Wire protocol upgrade/downgrade compatibility', () => {
  it('negotiates within frozen wire range', () => {
    expect(RBO_WIRE_PROTOCOL_MIN_VERSION).toBe(1);
    expect(RBO_WIRE_PROTOCOL_MAX_VERSION).toBe(1);
    expect(negotiateProtocolVersion({ min_version: 1, max_version: 1 })).toBe(1);
  });

  it('incompatible peer gets no lease eligibility', () => {
    const negotiated = negotiateProtocolVersion({ min_version: 2, max_version: 9 });
    expect(negotiated).toBeNull();
    expect(() => assertPeerEligibleForLease(negotiated)).toThrow(/incompatible_protocol_peer/);
  });

  it('supports SQLite migrate up and down without corruption', () => {
    const db = openDatabase(':memory:');
    migrateToLatest(db);
    expect(getSchemaVersion(db)).toBe(MIGRATIONS[MIGRATIONS.length - 1]?.version);
    migrateDown(db, 0);
    expect(getSchemaVersion(db)).toBe(0);
    migrateUp(db, 1);
    expect(getSchemaVersion(db)).toBe(1);
    db.close();
  });

  it('runbook documents install through uninstall procedures', async () => {
    const runbook = await readFile(join(process.cwd(), 'docs', 'ops', 'runbook.md'), 'utf8');
    for (const heading of [
      '## Install',
      '## Pair',
      '## Approve',
      '## Drain',
      '## Revoke',
      '## Repair',
      '## Update',
      '## Backup',
      '## Restore',
      '## Uninstall',
    ]) {
      expect(runbook).toContain(heading);
    }
  });
});
