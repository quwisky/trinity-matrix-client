import { MatrixCapabilities } from 'matrix-widget-api';
import { describe, expect, it } from 'vitest';
import { callCapabilities } from './call-capabilities';

const caps = callCapabilities('!r:hs', '@a:hs', 'DEV');
const sendState = 'org.matrix.msc2762.send.state_event:';
const member = 'org.matrix.msc3401.call.member';

describe('callCapabilities', () => {
  it('scopes the timeline and state to the call room', () => {
    expect(caps).toContain('org.matrix.msc2762.timeline:!r:hs');
    expect(caps).toContain('org.matrix.msc2762.state:!r:hs');
    expect(caps).not.toContain('org.matrix.msc2762.timeline:*');
  });

  it("lets the widget write only the user's own call member state", () => {
    for (const key of [
      '@a:hs_DEV_m.call',
      '_@a:hs_DEV_m.call',
      '@a:hs_DEV',
      '_@a:hs_DEV',
      '@a:hs',
    ]) {
      expect(caps).toContain(`${sendState}${member}#${key}`);
    }
    expect([...caps].filter((cap) => cap.includes('@b:hs'))).toEqual([]);
    expect([...caps].filter((cap) => cap.startsWith(sendState))).toHaveLength(
      5,
    );
  });

  it('sends and receives the call room events', () => {
    for (const type of [
      'io.element.call.encryption_keys',
      'io.element.call.reaction',
      'm.reaction',
      'm.room.redaction',
      'org.matrix.msc4075.rtc.notification',
      'org.matrix.msc4075.call.notify',
      'm.rtc.notification',
      'org.matrix.msc4310.rtc.decline',
      'org.matrix.msc4143.rtc.member',
    ]) {
      expect(caps).toContain(`org.matrix.msc2762.send.event:${type}`);
      expect(caps).toContain(`org.matrix.msc2762.receive.event:${type}`);
    }
  });

  it('receives the room state the call reads', () => {
    for (const type of [
      'm.room.member',
      'm.room.create',
      'm.room.encryption',
      'm.room.name',
      'org.matrix.msc3401.call',
      member,
    ]) {
      expect(caps).toContain(`org.matrix.msc2762.receive.state_event:${type}`);
    }
  });

  it('exchanges encryption keys to-device', () => {
    expect(caps).toContain(
      'org.matrix.msc3819.send.to_device:io.element.call.encryption_keys',
    );
    expect(caps).toContain(
      'org.matrix.msc3819.receive.to_device:io.element.call.encryption_keys',
    );
  });

  it('grants the MatrixRTC capabilities', () => {
    for (const cap of [
      MatrixCapabilities.MSC4157SendDelayedEvent,
      MatrixCapabilities.MSC4157UpdateDelayedEvent,
      MatrixCapabilities.MSC4407SendStickyEvent,
      MatrixCapabilities.MSC4407ReceiveStickyEvent,
      MatrixCapabilities.MSC4515RtcTransports,
      MatrixCapabilities.MSC4533RtcLivekitGetToken,
      MatrixCapabilities.MSC4533RtcLivekitDelegateDelayedLeave,
      MatrixCapabilities.AlwaysOnScreen,
    ]) {
      expect(caps).toContain(cap);
    }
  });

  it('grants no TURN, media, navigation or directory access', () => {
    for (const cap of [
      MatrixCapabilities.MSC3846TurnServers,
      'org.matrix.msc3846.turn_servers',
      MatrixCapabilities.MSC4039UploadFile,
      MatrixCapabilities.MSC4039DownloadFile,
      MatrixCapabilities.MSC2931Navigate,
      MatrixCapabilities.MSC3973UserDirectorySearch,
    ]) {
      expect(caps).not.toContain(cap);
    }
  });
});
