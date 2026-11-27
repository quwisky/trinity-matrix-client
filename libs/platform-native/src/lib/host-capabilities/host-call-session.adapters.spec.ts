import { TestBed } from '@angular/core/testing';
import { Capacitor } from '@capacitor/core';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { NativeCallSessionAdapter } from './host-call-session.adapters';

const plugin = vi.hoisted(() => ({
  begin: vi.fn(),
  end: vi.fn(),
  addListener: vi.fn(),
  listener: null as (() => void) | null,
  remove: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(() => false),
    isPluginAvailable: vi.fn(() => false),
  },
  registerPlugin: vi.fn(() => plugin),
}));

const isNative = Capacitor.isNativePlatform as unknown as Mock;
const isAvailable = Capacitor.isPluginAvailable as unknown as Mock;

function adapter(): NativeCallSessionAdapter {
  TestBed.configureTestingModule({ providers: [NativeCallSessionAdapter] });
  return TestBed.inject(NativeCallSessionAdapter);
}

describe('NativeCallSessionAdapter', () => {
  beforeEach(() => {
    isNative.mockReturnValue(false);
    isAvailable.mockReturnValue(false);
    plugin.begin.mockReset().mockResolvedValue({ started: true });
    plugin.end.mockReset().mockResolvedValue(undefined);
    plugin.remove.mockReset();
    plugin.addListener.mockReset().mockImplementation((_event, listener) => {
      plugin.listener = listener;
      return Promise.resolve({ remove: plugin.remove });
    });
  });

  it('does nothing off a native host', async () => {
    const host = adapter();
    const requests = vi.fn();
    host.hangUpRequests.subscribe(requests);

    await host.begin({ roomName: 'General' });
    await host.end();

    expect(plugin.begin).not.toHaveBeenCalled();
    expect(plugin.end).not.toHaveBeenCalled();
    expect(plugin.addListener).not.toHaveBeenCalled();
  });

  it('starts and stops the CallSession plugin on a host that has it', async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const host = adapter();

    await host.begin({ roomName: 'General' });
    await host.end();

    expect(isAvailable).toHaveBeenCalledWith('CallSession');
    expect(plugin.begin).toHaveBeenCalledExactlyOnceWith({
      roomName: 'General',
    });
    expect(plugin.end).toHaveBeenCalledTimes(1);
  });

  it("passes on the notification's Hang up and removes the listener", async () => {
    isNative.mockReturnValue(true);
    isAvailable.mockReturnValue(true);
    const requests = vi.fn();
    const subscription = adapter().hangUpRequests.subscribe(requests);

    expect(plugin.addListener).toHaveBeenCalledWith(
      'hangUp',
      expect.any(Function),
    );
    plugin.listener?.();
    expect(requests).toHaveBeenCalledTimes(1);

    subscription.unsubscribe();
    await Promise.resolve();
    expect(plugin.remove).toHaveBeenCalledTimes(1);
  });
});
