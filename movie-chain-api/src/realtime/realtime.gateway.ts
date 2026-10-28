import { SubscribeMessage, WebSocketGateway, type WsResponse } from '@nestjs/websockets';

/**
 * Step 1: liveness only. Seat-map rooms, the hold room and token checks on
 * connect arrive in step 21. Clients will never name a room themselves.
 */
@WebSocketGateway({ namespace: '/realtime' })
export class RealtimeGateway {
  @SubscribeMessage('ping')
  ping(): WsResponse<{ at: string }> {
    return { event: 'pong', data: { at: new Date().toISOString() } };
  }
}
