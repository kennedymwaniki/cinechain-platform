import { Global, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Doors } from './doors';
import { IDENTITY_DB_PROVIDER, IdentityDb } from './identity-db.provider';
import { TENANT_DB_PROVIDER, TenantDb } from './tenant-db.provider';
import { TenantInterceptor } from './tenant.interceptor';
import { TenantRegistry } from './tenant-registry.service';

@Global()
@Module({
  providers: [TENANT_DB_PROVIDER, IDENTITY_DB_PROVIDER, TenantRegistry, Doors, { provide: APP_INTERCEPTOR, useClass: TenantInterceptor }],
  exports: [TenantDb, IdentityDb, TenantRegistry, Doors],
})
export class TenancyModule implements OnModuleInit {
  private readonly log = new Logger(TenancyModule.name);

  constructor(private readonly tenantDb: TenantDb) {}

  /** Boot assertion: an app that owns its tables voids every policy silently. */
  async onModuleInit(): Promise<void> {
    await this.tenantDb.assertSafeRole();
    this.log.log('database role verified: not owner, not BYPASSRLS, no platform access');
  }
}
