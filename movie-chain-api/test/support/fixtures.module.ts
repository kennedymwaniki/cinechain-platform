/**
 * Test-only endpoints that exercise the step-7 conventions before any real
 * business module exists. Never imported by the application.
 */
import { Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { AuditLog } from '../../src/audit/audit-log.service';
import { notFound } from '../../src/common/errors/api-error';
import { Idempotent } from '../../src/common/idempotency/idempotent.decorator';
import { createZodDto } from '../../src/common/validation/zod-dto';
import { tenantCustomer } from '../../src/db/schema/app';
import { currentTenant, db } from '../../src/tenancy/tenant-context';

class CreateCustomerDto extends createZodDto(z.object({ email: z.email(), display_name: z.string().min(1) }).strict()) {}

export const handlerCalls = { create: 0 };

@Controller('fixtures/customers')
class FixtureController {
  constructor(private readonly audit: AuditLog) {}

  @Idempotent()
  @Post()
  async create(@Body() body: CreateCustomerDto) {
    handlerCalls.create++;
    const [row] = await db()
      .insert(tenantCustomer)
      .values({ tenantId: currentTenant().tenantId, email: body.email, displayName: body.display_name })
      .returning({ email: tenantCustomer.email, display_name: tenantCustomer.displayName, first_seen_at: tenantCustomer.firstSeenAt });
    await this.audit.record('customer.created', 'tenant_customer', body.email);
    return row;
  }

  @Get(':email')
  async get(@Param('email') email: string) {
    const [row] = await db().select({ email: tenantCustomer.email }).from(tenantCustomer).where(eq(tenantCustomer.email, email));
    if (!row) throw notFound();
    return row;
  }

  /** Simulates a BUG: writes a row stamped with a caller-chosen tenant. RLS must stop it. */
  @Post('buggy-write/:victim')
  async buggy(@Param('victim') victim: string) {
    await db().insert(tenantCustomer).values({ tenantId: victim, email: 'planted@example.test' });
    return { written: true };
  }

  @Get('boom/now')
  boom(): never {
    throw new Error('secret internal detail: connection string postgres://user:pw@db');
  }
}

@Module({ controllers: [FixtureController] })
export class FixturesModule {}
