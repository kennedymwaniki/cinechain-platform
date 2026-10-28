import { Module } from '@nestjs/common';
import { PaymentProviders } from './payment-providers';
import { PaymentRepository } from './payment.repository';
import { PaymentWebhookController } from './payment-webhook.controller';
import { PaymentWebhookService } from './payment-webhook.service';

@Module({
  controllers: [PaymentWebhookController],
  providers: [PaymentProviders, PaymentRepository, PaymentWebhookService],
  exports: [PaymentProviders, PaymentRepository, PaymentWebhookService],
})
export class PaymentModule {}
