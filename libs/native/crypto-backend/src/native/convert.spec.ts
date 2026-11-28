import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';

import {
  encryptionSettingsJson,
  roomSettingsJson,
  strategyName,
  toDecryptedRoomEvent,
  toIdentityKeys,
  toMegolmDecryptionError,
  toProcessedToDeviceEvent,
  toRequest,
  toRoomSettings,
} from './convert';
import { NotOnNativeError } from './guard';

beforeAll(() => real.initAsync());

describe('requests from the crate', () => {
  it.each([
    [{ id: 'u', type: 0, body: '{}' }, real.KeysUploadRequest],
    [{ id: 'q', type: 1, body: '{}' }, real.KeysQueryRequest],
    [{ id: 'c', type: 2, body: '{}' }, real.KeysClaimRequest],
    [
      {
        id: 't',
        type: 3,
        body: '{}',
        event_type: 'm.room.encrypted',
        txn_id: 'tx',
      },
      real.ToDeviceRequest,
    ],
    [{ id: 's', type: 4, body: '{}' }, real.SignatureUploadRequest],
    [
      {
        id: 'r',
        type: 5,
        body: '{}',
        event_type: 'm.room.message',
        txn_id: 'tx',
        room_id: '!r:example.org',
      },
      real.RoomMessageRequest,
    ],
    [{ id: 'b', type: 6, body: '{}', version: '1' }, real.KeysBackupRequest],
  ])('builds the real WASM request class (%o)', (json, kind) => {
    const request = toRequest(json);
    expect(request).toBeInstanceOf(kind);
    expect(request.id).toBe(json.id);
    expect(request.type).toBe(json.type);
    expect(request.body).toBe('{}');
  });

  it('keeps the fields of a to-device and a room message request', () => {
    const toDevice = toRequest({
      id: 't',
      type: 3,
      body: '{"messages":{}}',
      event_type: 'm.x',
      txn_id: 'tx',
    });
    expect(toDevice).toMatchObject({
      event_type: 'm.x',
      txn_id: 'tx',
      body: '{"messages":{}}',
    });
    const message = toRequest({
      id: 'r',
      type: 5,
      body: '{}',
      event_type: 'm.y',
      txn_id: 'tx2',
      room_id: '!r:x',
    });
    expect(message).toMatchObject({
      room_id: '!r:x',
      txn_id: 'tx2',
      event_type: 'm.y',
    });
  });

  it('refuses an unknown type or a missing field', () => {
    expect(() => toRequest({ id: 'x', type: 9, body: '{}' })).toThrow(
      /unknown type 9/,
    );
    expect(() => toRequest({ id: 'x', type: 3, body: '{}' })).toThrow(
      /no event_type/,
    );
  });
});

describe('settings to the crate', () => {
  it.each([
    [true, false, 'onlyTrustedDevices'],
    [true, true, 'onlyTrustedDevices'],
    [false, true, 'errorOnUnverifiedUserProblem'],
    [false, false, 'allDevices'],
  ])(
    'maps deviceBasedStrategy(%s, %s) in WASM order',
    (onlyTrusted, errorOnProblem, name) => {
      expect(
        strategyName(
          real.CollectStrategy.deviceBasedStrategy(onlyTrusted, errorOnProblem),
        ),
      ).toBe(name);
    },
  );

  it('maps identityBasedStrategy and every encryption setting', () => {
    const settings = new real.EncryptionSettings();
    settings.sharingStrategy = real.CollectStrategy.identityBasedStrategy();
    settings.historyVisibility = real.HistoryVisibility.Joined;
    settings.rotationPeriod = 1_000_000n;
    settings.rotationPeriodMessages = 5n;
    expect(encryptionSettingsJson(settings)).toEqual({
      algorithm: real.EncryptionAlgorithm.MegolmV1AesSha2,
      encryptStateEvents: false,
      historyVisibility: real.HistoryVisibility.Joined,
      rotationPeriod: 1_000_000,
      rotationPeriodMessages: 5,
      sharingStrategy: 'identityBasedStrategy',
    });
  });

  it('round-trips room settings through real RoomSettings objects', () => {
    const json = {
      algorithm: real.EncryptionAlgorithm.MegolmV1AesSha2,
      encryptStateEvents: false,
      onlyAllowTrustedDevices: true,
      sessionRotationPeriodMs: 1000,
      sessionRotationPeriodMessages: 10,
    };
    const settings = toRoomSettings(json);
    expect(settings).toBeInstanceOf(real.RoomSettings);
    expect(roomSettingsJson(settings)).toEqual(json);
    const { sessionRotationPeriodMs, sessionRotationPeriodMessages, ...bare } =
      json;
    expect(roomSettingsJson(toRoomSettings(bare))).toEqual(bare);
    expect([sessionRotationPeriodMs, sessionRotationPeriodMessages]).toEqual([
      1000, 10,
    ]);
  });
});

describe('answers of the crate', () => {
  const info = {
    sender: '@bob:example.org',
    senderDevice: 'BOB',
    senderCurve25519Key: 'curve',
    senderClaimedEd25519Key: 'ed',
    shieldState: {
      lax: { color: 2 },
      strict: { color: 0, code: 4, message: 'unverified' },
    },
  };

  it('turns a decrypted event into a guarded DecryptedRoomEvent', () => {
    const event = toDecryptedRoomEvent({
      ...info,
      event: '{"type":"m.room.message"}',
      forwardingCurve25519KeyChain: [],
    });
    expect(event).toBeInstanceOf(real.DecryptedRoomEvent);
    expect(event.event).toBe('{"type":"m.room.message"}');
    expect(event.sender.toString()).toBe('@bob:example.org');
    expect(event.senderDevice?.toString()).toBe('BOB');
    expect(event.forwarder).toBeUndefined();
    expect(event.senderClaimedEd25519Key).toBe('ed');
    expect(event.shieldState(false)).toMatchObject({
      color: real.ShieldColor.None,
      code: undefined,
    });
    expect(event.shieldState(true)).toMatchObject({
      color: real.ShieldColor.Red,
      code: 4,
      message: 'unverified',
    });
    expect(() => event.free()).not.toThrow();
  });

  it('throws a MegolmDecryptionError matrix-js-sdk recognises', () => {
    const error = toMegolmDecryptionError({
      code: real.DecryptionErrorCode.MissingRoomKey,
      description: 'no key',
      withheldCode: 'm.unverified',
      maybe_withheld:
        'The sender has disabled encrypting to unverified devices.',
    });
    expect(error).toBeInstanceOf(real.MegolmDecryptionError);
    expect(error.code).toBe(real.DecryptionErrorCode.MissingRoomKey);
    expect(error.maybe_withheld).toMatch(/unverified devices/);
  });

  it('turns processed to-device events into their WASM classes', () => {
    const decrypted = toProcessedToDeviceEvent({
      type: 0,
      rawEvent: '{}',
      encryptionInfo: {
        sender: '@bob:example.org',
        senderCurve25519Key: 'curve',
        isSenderVerified: true,
      },
    });
    expect(decrypted).toBeInstanceOf(real.DecryptedToDeviceEvent);
    const { encryptionInfo } = decrypted as real.DecryptedToDeviceEvent;
    expect(encryptionInfo.isSenderVerified()).toBe(true);
    expect(encryptionInfo.senderDevice).toBeUndefined();
    expect(
      toProcessedToDeviceEvent({
        type: 1,
        rawEvent: '{}',
        utdInfo: { reason: 2 },
      }),
    ).toBeInstanceOf(real.UTDToDeviceEvent);
    expect(
      toProcessedToDeviceEvent({ type: 2, rawEvent: '{}' }),
    ).toBeInstanceOf(real.PlainTextToDeviceEvent);
    expect(
      toProcessedToDeviceEvent({ type: 3, rawEvent: '{}' }),
    ).toBeInstanceOf(real.InvalidToDeviceEvent);
  });

  it('throws for a member of a value object it does not fill', () => {
    const { ed25519 } = toIdentityKeys({
      ed25519: 'ed',
      curve25519: 'mB7Ywmbd9WlFtWhT/4ZbVlUFkNmz04hxkx1bt+QBJ0E',
    });
    expect(ed25519).toBeInstanceOf(real.Ed25519PublicKey);
    expect(ed25519.toBase64()).toBe('ed');
    expect(() => ed25519.length).toThrow(NotOnNativeError);
  });
});
