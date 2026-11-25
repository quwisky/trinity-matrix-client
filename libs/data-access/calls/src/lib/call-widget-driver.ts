import {
  OpenIDRequestState,
  UpdateDelayedEventAction,
  WidgetDriver,
  type Capability,
  type IOpenIDUpdate,
  type IRoomEvent,
  type IRtcLivekitDelegateDelayedLeaveFromWidgetRequestData,
  type IRtcLivekitDelegateDelayedLeaveFromWidgetResponseData,
  type IRtcLivekitGetTokenFromWidgetRequestData,
  type IRtcLivekitGetTokenFromWidgetResponseData,
  type IRtcTransport,
  type IRtcTransportsResult,
  type ISendDelayedEventDetails,
  type ISendEventDetails,
  type SimpleObservable,
} from 'matrix-widget-api';
import type { CallTransport, RawCallEvent } from './call-transport';

export const toRoomEvent = (event: RawCallEvent): IRoomEvent => ({
  ...event,
  unsigned: event.unsigned ?? {},
});

/**
 * Element Call runs same-origin with full app privileges, so every Matrix action it
 * asks for is checked here: the allow-list, then the call room. Methods not overridden
 * keep widget-api's rejecting defaults.
 */
export class CallWidgetDriver extends WidgetDriver {
  constructor(
    private readonly transport: CallTransport,
    private readonly allowed: ReadonlySet<string>,
  ) {
    super();
  }

  override validateCapabilities(
    requested: Set<Capability>,
  ): Promise<Set<Capability>> {
    return Promise.resolve(
      new Set([...requested].filter((cap) => this.allowed.has(cap))),
    );
  }

  override async sendEvent(
    eventType: string,
    content: unknown,
    stateKey?: string | null,
    roomId?: string | null,
  ): Promise<ISendEventDetails> {
    const callRoom = this.callRoom(roomId);
    const { eventId } = await this.transport.sendEvent(
      eventType,
      content,
      stateKey ?? undefined,
    );
    return { roomId: callRoom, eventId };
  }

  override async sendStickyEvent(
    stickyDurationMs: number,
    eventType: string,
    content: unknown,
    roomId?: string | null,
  ): Promise<ISendEventDetails> {
    const callRoom = this.callRoom(roomId);
    const { eventId } = await this.transport.sendStickyEvent(
      stickyDurationMs,
      eventType,
      content,
    );
    return { roomId: callRoom, eventId };
  }

  override async sendDelayedEvent(
    delay: number,
    eventType: string,
    content: unknown,
    stateKey?: string | null,
    roomId?: string | null,
  ): Promise<ISendDelayedEventDetails> {
    const callRoom = this.callRoom(roomId);
    const { delayId } = await this.transport.sendDelayedEvent(
      { delayMs: delay },
      eventType,
      content,
      stateKey ?? undefined,
    );
    if (!delayId) throw new Error('The homeserver returned no delay ID');
    return { roomId: callRoom, delayId };
  }

  override cancelScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.transport.updateDelayedEvent(
      delayId,
      UpdateDelayedEventAction.Cancel,
    );
  }

  override restartScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.transport.updateDelayedEvent(
      delayId,
      UpdateDelayedEventAction.Restart,
    );
  }

  override sendScheduledDelayedEvent(delayId: string): Promise<void> {
    return this.transport.updateDelayedEvent(
      delayId,
      UpdateDelayedEventAction.Send,
    );
  }

  override sendToDevice(
    eventType: string,
    encrypted: boolean,
    contentMap: Record<string, Record<string, object>>,
  ): Promise<void> {
    return this.transport.sendToDevice(
      eventType,
      encrypted,
      contentMap as Record<string, Record<string, unknown>>,
    );
  }

  override readRoomState(
    roomId: string,
    eventType: string,
    stateKey: string | undefined,
  ): Promise<IRoomEvent[]> {
    if (roomId !== this.transport.roomId) return Promise.resolve([]);
    return Promise.resolve(
      this.transport.readState(eventType, stateKey).map(toRoomEvent),
    );
  }

  override readRoomTimeline(
    roomId: string,
    eventType: string,
    _msgtype: string | undefined,
    stateKey: string | undefined,
    limit: number,
    _since: string | undefined,
  ): Promise<IRoomEvent[]> {
    if (roomId !== this.transport.roomId) return Promise.resolve([]);
    return Promise.resolve(
      this.transport
        .readTimeline(eventType, limit)
        .filter(
          (event) => stateKey === undefined || event.state_key === stateKey,
        )
        .map(toRoomEvent),
    );
  }

  override askOpenID(observer: SimpleObservable<IOpenIDUpdate>): void {
    this.transport.openIdToken().then(
      (token) => observer.update({ state: OpenIDRequestState.Allowed, token }),
      () => observer.update({ state: OpenIDRequestState.Blocked }),
    );
  }

  override async getRtcTransports(): Promise<IRtcTransportsResult> {
    return {
      rtc_transports: (await this.transport.rtcTransports()) as IRtcTransport[],
    };
  }

  override async getRtcLivekitToken(
    data: IRtcLivekitGetTokenFromWidgetRequestData,
  ): Promise<IRtcLivekitGetTokenFromWidgetResponseData> {
    this.callRoom(data.room_id);
    return this.transport.livekitToken(data);
  }

  override async delegateRtcLivekitDelayedLeave(
    data: IRtcLivekitDelegateDelayedLeaveFromWidgetRequestData,
  ): Promise<IRtcLivekitDelegateDelayedLeaveFromWidgetResponseData> {
    this.callRoom(data.room_id);
    await this.transport.delegateLivekitDelayedLeave(data);
    return {};
  }

  /** widget-api passes `null` for the viewed room; anything else must be the call room. */
  private callRoom(roomId: string | null | undefined): string {
    if (roomId != null && roomId !== this.transport.roomId) {
      throw new Error('Element Call may only act in its own room');
    }
    return this.transport.roomId;
  }
}
