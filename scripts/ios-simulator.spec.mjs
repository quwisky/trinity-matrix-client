import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IOS_DEVICE,
  DEFAULT_IOS_RUNTIME,
  parseSimulators,
  runtimeIdentifier,
  selectSimulator,
} from '../e2e/mobile/simulator.mts';

const LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
      { udid: 'A', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'B', name: 'iPhone 17', state: 'Booted', isAvailable: true },
      {
        udid: 'C',
        name: 'iPhone 17 Pro',
        state: 'Shutdown',
        isAvailable: true,
      },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      { udid: 'D', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'E', name: 'iPhone 17', state: 'Shutdown', isAvailable: false },
    ],
  },
});
const pinned = { device: DEFAULT_IOS_DEVICE, runtime: DEFAULT_IOS_RUNTIME };

describe('iOS E2E simulator selection', () => {
  it('maps a runtime name to its CoreSimulator key', () => {
    expect(runtimeIdentifier('iOS 26.5')).toBe(
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    );
    expect(() => runtimeIdentifier('26.5')).toThrow(/Unrecognised iOS runtime/);
  });

  it('parses only available devices with their runtime and boot state', () => {
    expect(
      parseSimulators(LIST).map(({ udid, booted }) => [udid, booted]),
    ).toEqual([
      ['A', false],
      ['B', true],
      ['C', false],
      ['D', false],
    ]);
  });

  it('prefers a booted device of the pinned type and runtime', () => {
    expect(selectSimulator(parseSimulators(LIST), pinned).udid).toBe('B');
  });

  it('honours an explicit udid and rejects an unknown one', () => {
    expect(
      selectSimulator(parseSimulators(LIST), { ...pinned, udid: 'D' }).udid,
    ).toBe('D');
    expect(() =>
      selectSimulator(parseSimulators(LIST), { ...pinned, udid: 'Z' }),
    ).toThrow(/TRINITY_IOS_UDID Z is not an available simulator/);
  });

  it('names what is available when the pin is missing', () => {
    expect(() =>
      selectSimulator(parseSimulators(LIST), {
        device: 'iPhone 17',
        runtime: 'iOS 27.0',
      }),
    ).toThrow(
      /No available iPhone 17 simulator on iOS 27.0; available: iPhone 17 \(iOS-26-5\)/,
    );
  });
});
