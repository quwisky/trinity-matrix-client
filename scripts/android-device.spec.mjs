import { describe, expect, it } from 'vitest';
import {
  chooseEmulatorPort,
  parseDevices,
  parseOnlineDevices,
  reverseTarget,
  validateEmulator,
} from '../e2e/mobile/device.mts';

describe('Android E2E device selection', () => {
  it('retains offline emulator targets for safe port allocation', () => {
    expect(
      parseDevices(`List of devices attached
emulator-5554\tdevice
emulator-5556\toffline
R58M123\tunauthorized

`),
    ).toEqual([
      { serial: 'emulator-5554', state: 'device' },
      { serial: 'emulator-5556', state: 'offline' },
      { serial: 'R58M123', state: 'unauthorized' },
    ]);
    expect(chooseEmulatorPort(['emulator-5554', 'emulator-5556'])).toBe(5558);
  });

  it('returns only fully-online targets from adb devices', () => {
    expect(
      parseOnlineDevices(`List of devices attached
emulator-5554\tdevice
emulator-5556\toffline
R58M123\tunauthorized

`),
    ).toEqual(['emulator-5554']);
  });

  it('allocates an unused even emulator console port', () => {
    expect(chooseEmulatorPort(['emulator-5554', 'emulator-5558'])).toBe(5556);
  });

  it('preserves the previous target for the exact reverse socket', () => {
    expect(reverseTarget('host-17 tcp:8448 tcp:9448\n', 'tcp:8448')).toBe(
      'tcp:9448',
    );
    expect(
      reverseTarget('host-17 tcp:5555 tcp:5555\n', 'tcp:8448'),
    ).toBeUndefined();
  });

  it('rejects physical and wrong-API targets independently', () => {
    expect(validateEmulator({ qemu: '0', apiLevel: '35' })).toEqual([
      'target is not an emulator',
      'API 35 is not 36',
    ]);
  });

  // CI boots x86_64; Apple-silicon hosts can only boot arm64-v8a. The app ships no
  // native code of its own, so the ABI is not part of what makes a test emulator.
  it('accepts an API 36 emulator whatever its ABI', () => {
    expect(validateEmulator({ qemu: '1', apiLevel: '36' })).toEqual([]);
  });
});
