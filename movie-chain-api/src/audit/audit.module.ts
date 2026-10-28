import { Global, Module } from '@nestjs/common';
import { AuditLog } from './audit-log.service';
import { SecurityEvents } from './security-event.service';

@Global()
@Module({ providers: [SecurityEvents, AuditLog], exports: [SecurityEvents, AuditLog] })
export class AuditModule {}
