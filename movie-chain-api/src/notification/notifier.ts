import { Injectable, Logger } from '@nestjs/common';

/**
 * Where tickets go out. A real SMS gateway and mail provider implement this;
 * until then the log implementation records what would have been sent (and
 * tests read its outbox), like the identity plane's verification mailer.
 */
export abstract class Notifier {
  abstract email(to: string, subject: string, text: string): Promise<void>;
  abstract sms(to: string, text: string): Promise<void>;
}

@Injectable()
export class LogNotifier extends Notifier {
  private readonly log = new Logger('Notifier');
  readonly sent: { channel: 'email' | 'sms'; to: string; subject?: string; text: string }[] = [];
  /** Tests set this to make the next delivery fail. */
  failNext = 0;

  async email(to: string, subject: string, text: string): Promise<void> {
    this.maybeFail();
    this.sent.push({ channel: 'email', to, subject, text });
    this.log.log(`email → ${to}: ${subject}`);
  }

  async sms(to: string, text: string): Promise<void> {
    this.maybeFail();
    this.sent.push({ channel: 'sms', to, text });
    this.log.log(`sms → ${to}`);
  }

  private maybeFail(): void {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('simulated delivery failure');
    }
  }
}
