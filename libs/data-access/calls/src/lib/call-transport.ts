import type { Observable } from 'rxjs';

export interface RawCallEvent {
  type: string;
  event_id: string;
  room_id: string;
  sender: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  state_key?: string;
  unsigned?: Record<string, unknown>;
}

export interface CallToDevice {
  type: string;
  sender: string;
  content: Record<string, unknown>;
  encrypted: boolean;
}

export type DelayedEventAction = 'cancel' | 'restart' | 'send';

export interface CallTransport {
  readonly roomId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly homeserverUrl: string;
  sendEvent(
    type: string,
    content: unknown,
    stateKey?: string,
  ): Promise<{ eventId: string }>;
  sendDelayedEvent(
    delay: { delayMs?: number; parentDelayId?: string },
    type: string,
    content: unknown,
    stateKey?: string,
  ): Promise<{ delayId?: string; eventId?: string }>;
  updateDelayedEvent(
    delayId: string,
    action: DelayedEventAction,
  ): Promise<void>;
  sendStickyEvent(
    durationMs: number,
    type: string,
    content: unknown,
  ): Promise<{ eventId: string }>;
  sendDelayedStickyEvent(
    delay: { delayMs?: number; parentDelayId?: string },
    durationMs: number,
    type: string,
    content: unknown,
  ): Promise<{ delayId?: string; eventId?: string }>;
  sendToDevice(
    type: string,
    encrypted: boolean,
    messages: Record<string, Record<string, unknown>>,
  ): Promise<void>;
  readState(type: string, stateKey?: string): RawCallEvent[];
  /** Newest first; `limit` 0 means no limit. */
  readTimeline(type: string, limit: number): RawCallEvent[];
  readStickyEvents(): RawCallEvent[];
  readRelations(
    eventId: string,
    opts: {
      relType?: string;
      eventType?: string;
      from?: string;
      limit?: number;
      direction?: 'f' | 'b';
    },
  ): Promise<{ chunk: RawCallEvent[]; nextBatch?: string; prevBatch?: string }>;
  openIdToken(): Promise<{
    access_token: string;
    token_type: string;
    matrix_server_name: string;
    expires_in: number;
  }>;
  rtcTransports(): Promise<unknown[]>;
  livekitToken(body: Record<string, unknown>): Promise<{ jwt: string }>;
  delegateLivekitDelayedLeave(body: Record<string, unknown>): Promise<void>;
  /** Decrypted timeline and state events of `roomId`. */
  roomEvents(): Observable<RawCallEvent>;
  /** Decrypted, all types; the runtime filters. */
  toDevice(): Observable<CallToDevice>;
}
