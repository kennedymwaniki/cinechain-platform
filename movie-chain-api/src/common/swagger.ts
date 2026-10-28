import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** API: /api/v1/docs (JSON /api/v1/docs-json). Disabled in production. */
export function setupSwagger(app: INestApplication): void {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('CineChain API')
      .setDescription(
        'Multi-tenant cinema ticketing. Staff tokens carry tenant_id; consumer tokens never do; ' +
          'guests need no token at all.',
      )
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('api/v1/docs', app, doc, { jsonDocumentUrl: 'api/v1/docs-json' });
}

/** Control plane: /admin/docs (JSON /admin/docs-json). Loopback-only process. */
export function setupControlSwagger(app: INestApplication): void {
  const doc = SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('CineChain Control Plane')
      .setDescription('Operator API: onboarding and tenant lifecycle. Requires a control-v1 operator token.')
      .setVersion('1')
      .addBearerAuth()
      .build(),
  );
  SwaggerModule.setup('admin/docs', app, doc, { jsonDocumentUrl: 'admin/docs-json' });
}
