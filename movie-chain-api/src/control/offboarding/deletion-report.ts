import { Injectable } from '@nestjs/common';
import { CompactSign, compactVerify } from 'jose';
import { KeyStore } from '../../auth/key-store';
import type { DeletedTable, ExportedTable } from '../../lifecycle/tenant-data';

export interface DeletionReport {
  tenant_id: string;
  requested_at: string;
  completed_at: string;
  deadline_at: string;
  export: { tables: number; rows: number; verified_at: string; retained_until: string; keys: string[] };
  tables: DeletedTable[]; // EVERY table in TENANT_TABLES, before and after
  redis: { deleted: number; remaining: number };
  queues: { removed: number; remaining: number };
  objects: { deleted: number; remaining_outside_export: number; retained_export: number };
  retained: string[]; // what is deliberately kept, and why
  complete: boolean;
}

/**
 * The proof. Signed with the control plane's Ed25519 key (a JWS), so an
 * archived report cannot be edited after the fact without the signature
 * failing. Regulators ask; "we have never tried" is an expensive answer.
 */
@Injectable()
export class DeletionReportSigner {
  constructor(private readonly keys: KeyStore) {}

  sign(report: DeletionReport): Promise<string> {
    return new CompactSign(new TextEncoder().encode(JSON.stringify(report)))
      .setProtectedHeader({ alg: 'EdDSA', kid: 'control-v1', typ: 'cinechain-deletion-report' })
      .sign(this.keys.get('control-v1').privateKey);
  }

  async verify(jws: string): Promise<DeletionReport | null> {
    try {
      const { payload } = await compactVerify(jws, this.keys.get('control-v1').publicKey);
      return JSON.parse(new TextDecoder().decode(payload)) as DeletionReport;
    } catch {
      return null;
    }
  }
}

export const isExportManifest = (v: unknown): v is ExportedTable[] =>
  Array.isArray(v) && v.every((t) => t && typeof t === 'object' && 'table' in t && 'sha256' in t && 'key' in t);
