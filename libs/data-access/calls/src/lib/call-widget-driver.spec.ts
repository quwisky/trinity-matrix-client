import {
  OpenIDRequestState,
  SimpleObservable,
  UpdateDelayedEventAction,
} from 'matrix-widget-api';
import { NEVER } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { callCapabilities } from './call-capabilities';
import type { CallTransport, RawCallEvent } from './call-transport';
import { CallWidgetDriver } from './call-widget-driver';

const memberEvent: RawCallEvent = {
  type: 'org.matrix.msc3401.call.member',
  event_id: '$m',
  room_id: '!r:hs',
  sender: '@a:hs',
  origin_server_ts: 1,
  content: {},
  state_key: '@a:hs',
};

function fakeTransport(): CallTransport {
  return {
    roomId: '!r:hs',
    userId: '@a:hs',
    deviceId: 'DEV',
    homeserverUrl: 'https://hs',
    sendEvent: vi.fn().mockResolvedValue({ eventId: '$e' }),
    sendDelayedEvent: vi.fn().mockResolvedValue({ delayId: 'd1' }),
    updateDelayedEvent: vi.fn().mockResolvedValue(undefined),
    sendStickyEvent: vi.fn().mockResolvedValue({ eventId: '$s' }),
    sendToDevice: vi.fn().mockResolvedValue(undefined),
    readState: vi.fn().mockReturnValue([memberEvent]),
    readTimeline: vi.fn().mockReturnValue([memberEvent]),
    readRelations: vi.fn(),
    openIdToken: vi.fn().mockResolvedValue({
      access_token: 'tok',
      token_type: 'Bearer',
      matrix_server_name: 'hs',
      expires_in: 3600,
    }),
    rtcTransports: vi.fn().mockResolvedValue([{ type: 'livekit' }]),
    livekitToken: vi.fn().mockResolvedValue({ jwt: 'jwt' }),
    delegateLivekitDelayedLeave: vi.fn().mockResolvedValue(undefined),
    roomEvents: () => NEVER,
    toDevice: () => NEVER,
  };
}

const allowed = callCapabilities('!r:hs', '@a:hs', 'DEV');
const setup = () => {
  const transport = fakeTransport();
  return { transport, driver: new CallWidgetDriver(transport, allowed) };
};

describe('CallWidgetDriver', () => {
  it('grants only the allow-listed capabilities', async () => {
    const { driver } = setup();
    const granted = 'org.matrix.msc2762.timeline:!r:hs';

    await expect(
      driver.validateCapabilities(
        new Set([
          granted,
          'org.matrix.msc2762.timeline:!other:hs',
          'org.matrix.msc2762.send.state_event:org.matrix.msc3401.call.member#@b:hs',
        ]),
      ),
    ).resolves.toEqual(new Set([granted]));
  });

  it('sends room events to the call room only', async () => {
    const { driver, transport } = setup();
    const content = { key: '👍' };

    await expect(
      driver.sendEvent('m.reaction', content, null, '!r:hs'),
    ).resolves.toEqual({ roomId: '!r:hs', eventId: '$e' });
    expect(transport.sendEvent).toHaveBeenCalledWith(
      'm.reaction',
      content,
      undefined,
    );
    await expect(
      driver.sendEvent('m.reaction', content, null, '!other:hs'),
    ).rejects.toThrow();
    expect(transport.sendEvent).toHaveBeenCalledTimes(1);
  });

  it('sends sticky events to the call room', async () => {
    const { driver, transport } = setup();

    await expect(
      driver.sendStickyEvent(60_000, 'org.matrix.msc4143.rtc.member', {}),
    ).resolves.toEqual({ roomId: '!r:hs', eventId: '$s' });
    expect(transport.sendStickyEvent).toHaveBeenCalledWith(
      60_000,
      'org.matrix.msc4143.rtc.member',
      {},
    );
  });

  it('schedules and updates delayed events', async () => {
    const { driver, transport } = setup();
    const type = 'org.matrix.msc3401.call.member';

    await expect(
      driver.sendDelayedEvent(5000, type, {}, '_@a:hs_DEV_m.call'),
    ).resolves.toEqual({ roomId: '!r:hs', delayId: 'd1' });
    expect(transport.sendDelayedEvent).toHaveBeenCalledWith(
      { delayMs: 5000 },
      type,
      {},
      '_@a:hs_DEV_m.call',
    );

    await driver.restartScheduledDelayedEvent('d1');
    await driver.cancelScheduledDelayedEvent('d2');
    await driver.sendScheduledDelayedEvent('d3');
    expect(transport.updateDelayedEvent).toHaveBeenNthCalledWith(
      1,
      'd1',
      UpdateDelayedEventAction.Restart,
    );
    expect(transport.updateDelayedEvent).toHaveBeenNthCalledWith(
      2,
      'd2',
      UpdateDelayedEventAction.Cancel,
    );
    expect(transport.updateDelayedEvent).toHaveBeenNthCalledWith(
      3,
      'd3',
      UpdateDelayedEventAction.Send,
    );
  });

  it('sends to-device messages', async () => {
    const { driver, transport } = setup();
    const map = { '@b:hs': { B: { keys: [] } } };

    await driver.sendToDevice('io.element.call.encryption_keys', true, map);

    expect(transport.sendToDevice).toHaveBeenCalledWith(
      'io.element.call.encryption_keys',
      true,
      map,
    );
  });

  it('answers OpenID requests with the transport token', async () => {
    const { driver, transport } = setup();
    const token = await transport.openIdToken();
    const update = vi.fn();

    driver.askOpenID(new SimpleObservable(update));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        state: OpenIDRequestState.Allowed,
        token,
      }),
    );
  });

  it('blocks OpenID when the token request fails', async () => {
    const { driver, transport } = setup();
    vi.mocked(transport.openIdToken).mockRejectedValue(new Error('nope'));
    const update = vi.fn();

    driver.askOpenID(new SimpleObservable(update));

    await vi.waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        state: OpenIDRequestState.Blocked,
      }),
    );
  });

  it('relays the RTC transports and LiveKit requests', async () => {
    const { driver, transport } = setup();
    const data = {
      server_name: 'hs',
      url: 'https://sfu',
      room_id: '!r:hs',
      slot_id: 'm.call#ROOM',
      member_id: 'm1',
    };
    const leave = { ...data, delay_id: 'd1' };

    await expect(driver.getRtcTransports()).resolves.toEqual({
      rtc_transports: [{ type: 'livekit' }],
    });
    await expect(driver.getRtcLivekitToken(data)).resolves.toEqual({
      jwt: 'jwt',
    });
    expect(transport.livekitToken).toHaveBeenCalledWith(data);
    await expect(driver.delegateRtcLivekitDelayedLeave(leave)).resolves.toEqual(
      {},
    );
    expect(transport.delegateLivekitDelayedLeave).toHaveBeenCalledWith(leave);
  });

  it('refuses LiveKit requests for another room', async () => {
    const { driver, transport } = setup();
    const data = {
      server_name: 'hs',
      url: 'https://sfu',
      room_id: '!other:hs',
      slot_id: 'm.call#ROOM',
      member_id: 'm1',
    };

    await expect(driver.getRtcLivekitToken(data)).rejects.toThrow();
    await expect(
      driver.delegateRtcLivekitDelayedLeave({ ...data, delay_id: 'd1' }),
    ).rejects.toThrow();
    expect(transport.livekitToken).not.toHaveBeenCalled();
    expect(transport.delegateLivekitDelayedLeave).not.toHaveBeenCalled();
  });

  it('reads state and timeline of the call room only', async () => {
    const { driver, transport } = setup();
    const type = 'org.matrix.msc3401.call.member';

    await expect(driver.readRoomState('!r:hs', type, '@a:hs')).resolves.toEqual(
      [{ ...memberEvent, unsigned: {} }],
    );
    expect(transport.readState).toHaveBeenCalledWith(type, '@a:hs');
    await expect(
      driver.readRoomTimeline(
        '!r:hs',
        type,
        undefined,
        undefined,
        10,
        undefined,
      ),
    ).resolves.toEqual([{ ...memberEvent, unsigned: {} }]);
    expect(transport.readTimeline).toHaveBeenCalledWith(type, 10);

    await expect(
      driver.readRoomState('!other:hs', type, undefined),
    ).resolves.toEqual([]);
    await expect(
      driver.readRoomTimeline(
        '!other:hs',
        type,
        undefined,
        undefined,
        10,
        undefined,
      ),
    ).resolves.toEqual([]);
    expect(transport.readState).toHaveBeenCalledTimes(1);
    expect(transport.readTimeline).toHaveBeenCalledTimes(1);
  });
});
