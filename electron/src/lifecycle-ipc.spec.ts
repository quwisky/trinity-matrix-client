import { afterEach, describe, expect, it, vi } from 'vitest';

const { handlers, mainWindowRef } = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  mainWindowRef: {
    current: null as {
      webContents: object;
      isDestroyed(): boolean;
      isVisible(): boolean;
      isMinimized(): boolean;
    } | null,
  },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (
      channel: string,
      handler: (event: unknown, ...args: unknown[]) => unknown,
    ) => {
      handlers.set(channel, handler);
    },
  },
}));

vi.mock('./window', () => ({
  getMainWindow: () => mainWindowRef.current,
}));

import {
  VISIBILITY_QUERY_CHANNEL,
  registerLifecycleIpc,
} from './lifecycle-ipc';

registerLifecycleIpc();
const handler = handlers.get(VISIBILITY_QUERY_CHANNEL);

function window(visible: boolean, minimized = false) {
  return {
    webContents: {},
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
  };
}

describe('registerLifecycleIpc', () => {
  afterEach(() => {
    mainWindowRef.current = null;
  });

  it.each([
    ['on screen', window(true), 'visible'],
    ['hidden in the tray', window(false), 'hidden'],
    ['minimised', window(true, true), 'hidden'],
  ])('tells a renderer starting while the window is %s', (_, win, expected) => {
    mainWindowRef.current = win;

    expect(handler?.({ sender: win.webContents })).toBe(expected);
  });

  it('answers only the main window’s own renderer', () => {
    mainWindowRef.current = window(false);

    expect(handler?.({ sender: {} })).toBeNull();
  });

  it('answers nothing without a live main window', () => {
    expect(handler?.({ sender: {} })).toBeNull();
    mainWindowRef.current = { ...window(true), isDestroyed: () => true };
    expect(handler?.({ sender: mainWindowRef.current.webContents })).toBeNull();
  });
});
