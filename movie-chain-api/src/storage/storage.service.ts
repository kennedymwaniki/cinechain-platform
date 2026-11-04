import { DeleteObjectsCommand, HeadBucketCommand, ListObjectsV2Command, PutObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * S3-compatible object storage (MinIO locally). Configured in step 1, first
 * used in step 10. Every key is built here as `t/<tenant_id>/<path>` — callers
 * supply a path, never a prefix, so one tenant's objects cannot be addressed
 * from another tenant's request.
 */
@Injectable()
export class StorageService implements OnApplicationShutdown {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.bucket = cfg.storage.bucket;
    this.s3 = new S3Client({
      endpoint: cfg.storage.endpoint,
      region: cfg.storage.region,
      forcePathStyle: true,
      credentials: { accessKeyId: cfg.storage.accessKey, secretAccessKey: cfg.storage.secretKey },
    });
  }

  static tenantKey(tenantId: string, path: string[]): string {
    if (!UUID_RE.test(tenantId)) throw new Error('tenantId is not a uuid');
    if (path.length === 0 || !path.every((p) => SAFE_SEGMENT.test(p) && p !== '.' && p !== '..'))
      throw new Error('invalid object path');
    return ['t', tenantId.toLowerCase(), ...path].join('/');
  }

  async putObject(tenantId: string, path: string[], body: Buffer, contentType: string): Promise<string> {
    const key = StorageService.tenantKey(tenantId, path);
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }

  async getSignedUrl(tenantId: string, path: string[], expiresInSeconds = 300): Promise<string> {
    const key = StorageService.tenantKey(tenantId, path);
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  /**
   * Signs a key previously RETURNED by putObject and stored on a tenant row
   * (read under RLS). Refuses anything not shaped like a tenant key, and a
   * key for a different tenant than the caller's scope is never stored on
   * that tenant's rows in the first place.
   */
  async getSignedUrlForKey(key: string, expiresInSeconds = 300): Promise<string> {
    if (!/^t\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) throw new Error('not a tenant object key');
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.bucket, Key: key }), { expiresIn: expiresInSeconds });
  }

  /** Bytes stored under t/<tenant_id>/ (metering, step 24). Pages through the whole prefix. */
  async prefixBytes(tenantId: string): Promise<number> {
    const prefix = `${StorageService.tenantKey(tenantId, ['x']).slice(0, -1)}`;
    let total = 0;
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) total += o.Size ?? 0;
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return total;
  }

  /** Every object key under t/<tenant_id>/ (offboarding: what exists, what remains). */
  async listTenantKeys(tenantId: string): Promise<string[]> {
    const prefix = StorageService.tenantKey(tenantId, ['x']).slice(0, -1);
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of page.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return keys;
  }

  /** Reads back an object the platform wrote (export verification). Tenant keys only. */
  async getObjectBytes(key: string): Promise<Buffer> {
    if (!/^t\/[0-9a-f-]{36}\/[A-Za-z0-9._/-]+$/.test(key) || key.includes('..')) throw new Error('not a tenant object key');
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }

  /** Deletes the given TENANT keys (1 000 per request). */
  async deleteTenantKeys(tenantId: string, keys: string[]): Promise<number> {
    const prefix = StorageService.tenantKey(tenantId, ['x']).slice(0, -1);
    if (keys.some((k) => !k.startsWith(prefix))) throw new Error('refusing to delete a key outside this tenant prefix');
    let deleted = 0;
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true } }));
      deleted += batch.length;
    }
    return deleted;
  }

  /** Platform records kept OUTSIDE any tenant prefix (signed offboarding reports): audit/<path>. */
  async putAuditObject(path: string[], body: Buffer, contentType: string): Promise<string> {
    if (!path.length || !path.every((p) => SAFE_SEGMENT.test(p) && p !== '.' && p !== '..')) throw new Error('invalid object path');
    const key = ['audit', ...path].join('/');
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
    return key;
  }

  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  onApplicationShutdown(): void {
    this.s3.destroy();
  }
}
