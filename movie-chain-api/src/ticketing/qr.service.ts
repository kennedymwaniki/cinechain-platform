import { Inject, Injectable } from '@nestjs/common';
import QRCode from 'qrcode';
import { JwtService } from '../auth/jwt.service';
import { unauthorized } from '../common/errors/api-error';
import { APP_CONFIG, type AppConfig } from '../config/app-config';
import { TicketCodeService } from './ticket-code.service';

export const QR_URL_TTL_S = 15 * 60;

/**
 * QR images for tickets. The URL carries a short-lived signed token naming
 * the ticket — never the code itself, so a URL that lands in a log, a proxy
 * or a browser history is useless after 15 minutes. The image is rendered on
 * request and never stored.
 */
@Injectable()
export class TicketQrService {
  constructor(
    private readonly jwt: JwtService,
    private readonly codes: TicketCodeService,
    @Inject(APP_CONFIG) private readonly cfg: AppConfig,
  ) {}

  async urlFor(tenantId: string, ticketId: string): Promise<string> {
    const { token } = await this.jwt.sign('booking-v1', { typ: 'ticket_qr', tenant_id: tenantId, ticket_id: ticketId }, QR_URL_TTL_S);
    return `${this.cfg.publicUrl}/api/v1/tickets/qr?token=${token}`;
  }

  async render(token: string | undefined): Promise<Buffer> {
    const c = token ? await this.jwt.verify('booking-v1', token) : null;
    if (!c || c.typ !== 'ticket_qr') throw unauthorized('qr_link_invalid', 'This ticket image link is invalid or has expired');
    return QRCode.toBuffer(this.codes.codeFor(c.tenant_id, c.ticket_id), { errorCorrectionLevel: 'M', margin: 2, width: 320 });
  }
}
