import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, type OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { SecurityEvents } from '../audit/security-event.service';
import { decodeUnverified } from '../auth/jwt.service';
import { TokenVerifier } from '../auth/token-verifier';
import { HoldTokenService } from '../inventory/hold-token.service';
import { RedisLocks } from '../inventory/redis-locks';
import { Doors } from '../tenancy/doors';
import { UUID_RE } from '../tenancy/tenant-db.provider';

/** Built by the SERVER from a resolved tenant. A client never names a room. */
export const screeningRoom = (tenantId: string, screeningId: string) => `t:${tenantId}:scr:${screeningId}`;
export const holdRoom = (holdId: string) => `hold:${holdId}`;

/**
 * The live seat map (Socket.IO, namespace /seatmap, Redis adapter across
 * instances). A client sends a SCREENING ID; the server derives the tenant
 * through the same sanctioned door as HTTP and builds the room name. There is
 * no handler that accepts a room: `socket.join(body.room)` is one line, and
 * any client could then watch a competitor's live demand.
 */
@WebSocketGateway({ namespace: '/seatmap' })
export class SeatmapGateway implements OnGatewayConnection {
  private readonly log = new Logger(SeatmapGateway.name);
  @WebSocketServer() server!: Namespace;

  constructor(
    private readonly doors: Doors,
    private readonly holdTokens: HoldTokenService,
    private readonly verifier: TokenVerifier,
    private readonly security: SecurityEvents,
    private readonly locks: RedisLocks,
  ) {}

  /** The same rule as HTTP, over a different transport: a token carrying a tenant is the wrong type. */
  async handleConnection(socket: Socket): Promise<void> {
    const raw = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
    if (raw === undefined || raw === null || raw === '') return; // guests are first-class
    const token = String(raw);
    const peek = decodeUnverified(token);
    if (peek && (peek.typ === 'staff' || peek.typ === 'operator' || peek.tenant_id !== undefined)) {
      await this.security.record('wrong_token_type', { actorSub: typeof peek.sub === 'string' ? peek.sub : null, path: 'ws:/seatmap', detail: { typ: peek.typ ?? null } });
      return this.refuse(socket, 'wrong_token_type');
    }
    if (!(await this.verifier.verify('consumer-v1', token))) return this.refuse(socket, 'invalid_token');
  }

  private refuse(socket: Socket, error: string): void {
    socket.emit('error', { error });
    socket.disconnect(true);
  }

  @SubscribeMessage('subscribe')
  async subscribe(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const id = (body as { screening_id?: unknown } | null)?.screening_id;
    if (typeof id !== 'string' || !UUID_RE.test(id)) return { event: 'subscribe_error', data: { error: 'invalid_screening_id' } };
    const owner = await this.doors.resolvePublishedScreening(id);
    if (!owner) return { event: 'subscribe_error', data: { error: 'not_found' } };
    await socket.join(screeningRoom(owner.tenantId, id));
    const version = await this.locks.currentVersion(owner.tenantId, id).catch(() => null);
    return { event: 'subscribed', data: { screening_id: id, version } };
  }

  /** The private room for one hold: countdown events, joined by PRESENTING the hold token. */
  @SubscribeMessage('watch_hold')
  async watchHold(@ConnectedSocket() socket: Socket, @MessageBody() body: unknown) {
    const token = (body as { hold_token?: unknown } | null)?.hold_token;
    try {
      const c = await this.holdTokens.verify(typeof token === 'string' ? token : undefined, {});
      await socket.join(holdRoom(c.hold_id));
      return { event: 'watching_hold', data: { hold_id: c.hold_id } };
    } catch {
      return { event: 'watch_hold_error', data: { error: 'hold_token_invalid' } };
    }
  }
}
