import { describe, expect, it } from 'vitest';
import {
  chooseEmulatorPort,
  parseDevices,
  parseOnlineDevices,
  reverseTarget,
  validateEmulator,
} from '../e2e/android/device.mts';

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

  it('rejects physical, wrong-API, and wrong-ABI targets independently', () => {
    expect(
      validateEmulator({ qemu: '0', apiLevel: '35', abi: 'arm64-v8a' }),
    ).toEqual([
      'target is not an emulator',
      'API 35 is not 36',
      'ABI arm64-v8a is not x86_64',
    ]);
    expect(
      validateEmulator({ qemu: '1', apiLevel: '36', abi: 'x86_64' }),
    ).toEqual([]);
  });
});
