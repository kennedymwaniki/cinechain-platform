import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import type { PaymentProviderName } from '../db/schema/payment';
import type { PaymentProvider } from './payment.provider';
import { CardProvider } from './providers/card.provider';
import { MpesaProvider } from './providers/mpesa.provider';
import { StubGateway } from './providers/stub-gateway';

/** The configured providers, by name. Online payment methods only; cash is settled at the counter. */
@Injectable()
export class PaymentProviders {
  readonly mpesa: MpesaProvider;
  readonly card: CardProvider;

  constructor(@Inject(APP_CONFIG) cfg: AppConfig) {
    this.mpesa = new MpesaProvider(new StubGateway(), cfg.payments.mpesaWebhookSecret);
    this.card = new CardProvider(new StubGateway(), cfg.payments.cardWebhookSecret);
  }

  get(name: string): PaymentProvider | null {
    return name === 'mpesa' ? this.mpesa : name === 'card' ? this.card : null;
  }

  names(): PaymentProviderName[] {
    return ['mpesa', 'card'];
  }
}
