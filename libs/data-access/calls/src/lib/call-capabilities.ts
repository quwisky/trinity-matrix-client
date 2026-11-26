const CALL_MEMBER = 'org.matrix.msc3401.call.member';
const ENCRYPTION_KEYS = 'io.element.call.encryption_keys';

/** Room events Element Call both sends and receives. */
const ROOM_EVENTS = [
  ENCRYPTION_KEYS,
  'io.element.call.reaction',
  'm.reaction',
  'm.room.redaction',
  'org.matrix.msc4075.rtc.notification',
  'org.matrix.msc4075.call.notify',
  'm.rtc.notification',
  'org.matrix.msc4310.rtc.decline',
  'org.matrix.msc4143.rtc.member',
];

const RECEIVED_STATE = [
  'm.room.member',
  'm.room.create',
  'm.room.encryption',
  'm.room.name',
  'org.matrix.msc3401.call',
  CALL_MEMBER,
];

/**
 * The widget capabilities a call may hold: the call room only, the user's own member
 * state keys only. Plain strings so the allow-list loads without matrix-widget-api.
 */
export function callCapabilities(
  roomId: string,
  userId: string,
  deviceId: string,
): ReadonlySet<string> {
  const ownMemberKeys = [
    `${userId}_${deviceId}_m.call`,
    `_${userId}_${deviceId}_m.call`,
    `${userId}_${deviceId}`,
    `_${userId}_${deviceId}`,
    userId,
  ];
  return new Set([
    `org.matrix.msc2762.timeline:${roomId}`,
    `org.matrix.msc2762.state:${roomId}`,
    ...ownMemberKeys.map(
      (key) => `org.matrix.msc2762.send.state_event:${CALL_MEMBER}#${key}`,
    ),
    ...ROOM_EVENTS.flatMap((type) => [
      `org.matrix.msc2762.send.event:${type}`,
      `org.matrix.msc2762.receive.event:${type}`,
    ]),
    ...RECEIVED_STATE.map(
      (type) => `org.matrix.msc2762.receive.state_event:${type}`,
    ),
    `org.matrix.msc3819.send.to_device:${ENCRYPTION_KEYS}`,
    `org.matrix.msc3819.receive.to_device:${ENCRYPTION_KEYS}`,
    'org.matrix.msc4157.send.delayed_event',
    'org.matrix.msc4157.update_delayed_event',
    'org.matrix.msc4407.send.sticky_event',
    'org.matrix.msc4407.receive.sticky_event',
    'org.matrix.msc4515.rtc_transports',
    'org.matrix.msc4533.rtc_livekit_get_token',
    'org.matrix.msc4533.rtc_livekit_delegate_delayed_leave',
    'm.always_on_screen',
  ]);
}
