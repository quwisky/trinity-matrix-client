import * as real from '@matrix-org/matrix-sdk-crypto-wasm-real';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  NativeDehydratedDevice,
  NativeDehydratedDevices,
  NativeRehydratedDevice,
} from './dehydrated';
import { SHIM_STATICS } from './install';
import { NativeOlmMachine, NativeStoreHandle } from './machine';
import {
  NativeBackupKeys,
  NativeDevice,
  NativeOtherUserIdentity,
  NativeOwnUserIdentity,
  NativeUserDevices,
} from './trust';
import { NativeQr, NativeSas, NativeVerificationRequest } from './verification';

interface Entry {
  readonly status: string;
  readonly shimImpl?: boolean;
}

const surface = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../../../../native/crypto/surface.json'),
    'utf8',
  ),
) as { stateful: Record<string, Record<string, Entry>> };

const SHIM_CLASSES: Record<string, object> = {
  OlmMachine: NativeOlmMachine.prototype,
  StoreHandle: NativeStoreHandle.prototype,
  Device: NativeDevice.prototype,
  UserDevices: NativeUserDevices.prototype,
  OwnUserIdentity: NativeOwnUserIdentity.prototype,
  OtherUserIdentity: NativeOtherUserIdentity.prototype,
  BackupKeys: NativeBackupKeys.prototype,
  VerificationRequest: NativeVerificationRequest.prototype,
  Sas: NativeSas.prototype,
  Qr: NativeQr.prototype,
  DehydratedDevices: NativeDehydratedDevices.prototype,
  DehydratedDevice: NativeDehydratedDevice.prototype,
  RehydratedDevice: NativeRehydratedDevice.prototype,
};

const claimed = Object.entries(surface.stateful).flatMap(([owner, members]) =>
  Object.entries(members)
    .filter(([, entry]) => entry.shimImpl === true)
    .map(([member]) => [owner, member] as const),
);

describe('the shim against native/crypto/surface.json', () => {
  it('claims every member a native call or the shim answers', () => {
    const unclaimed = Object.entries(surface.stateful).flatMap(
      ([owner, members]) =>
        Object.entries(members)
          .filter(
            ([, entry]) =>
              ['done', 'shim'].includes(entry.status) && !entry.shimImpl,
          )
          .map(([member]) => `${owner}.${member}`),
    );
    expect(unclaimed).toEqual([]);
    expect(claimed.length).toBeGreaterThan(0);
  });

  it.each(claimed)('implements %s.%s', (owner, member) => {
    const statics: readonly string[] =
      SHIM_STATICS[owner as keyof typeof SHIM_STATICS] ?? [];
    const prototype = SHIM_CLASSES[owner];
    expect(
      statics.includes(member) ||
        (prototype !== undefined && Object.hasOwn(prototype, member)),
    ).toBe(true);
  });

  it('stands in only for classes the WASM package has', () => {
    for (const owner of [
      ...Object.keys(SHIM_CLASSES),
      ...Object.keys(SHIM_STATICS),
    ]) {
      expect(typeof (real as Record<string, unknown>)[owner], owner).toBe(
        'function',
      );
    }
  });

  it('puts each stand-in over its WASM class', () => {
    expect(Object.create(NativeOlmMachine.prototype)).toBeInstanceOf(
      real.OlmMachine,
    );
    expect(new NativeStoreHandle()).toBeInstanceOf(real.StoreHandle);
    for (const [owner, prototype] of Object.entries(SHIM_CLASSES)) {
      expect(Object.create(prototype), owner).toBeInstanceOf(
        (real as unknown as Record<string, new () => object>)[owner]!,
      );
    }
  });
});
