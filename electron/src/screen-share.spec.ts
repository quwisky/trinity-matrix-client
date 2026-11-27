import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSources, buildFromTemplate, popup, mainWindow } = vi.hoisted(() => ({
  getSources: vi.fn(),
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
  mainWindow: { current: null as unknown },
}));
vi.mock('electron', () => ({
  desktopCapturer: { getSources },
  Menu: { buildFromTemplate },
  protocol: {},
}));
vi.mock('./window', () => ({ getMainWindow: () => mainWindow.current }));

import {
  captureChoices,
  installScreenShare,
  mayCaptureScreen,
} from './screen-share';

type Frame = { url: string; parent: Frame | null };
type Template = { label: string; click: () => void }[];

const appMain: Frame = { url: 'trinity://app/rooms/!a', parent: null };
const callFrame: Frame = {
  url: 'trinity://app/element-call/index.html#?roomId=!a',
  parent: appMain,
};
const screen = (n: number) => ({ id: `screen:${n}:0`, name: `Screen ${n}` });
const window = (n: number, name = `Window ${n}`) => ({
  id: `window:${n}:0`,
  name,
});

describe('mayCaptureScreen', () => {
  it('lets the bundled call frame inside the app capture', () => {
    expect(mayCaptureScreen(callFrame)).toBe(true);
  });

  it.each<[string, Frame | null]>([
    ['a destroyed frame', null],
    ['the app main frame', appMain],
    ['a main frame at the call page', { url: callFrame.url, parent: null }],
    [
      'an app subframe outside the call',
      { url: 'trinity://app/index.html', parent: appMain },
    ],
    [
      'a remote widget frame',
      { url: 'https://widget.example/', parent: appMain },
    ],
    [
      'a call page under a remote frame',
      {
        url: callFrame.url,
        parent: { url: 'https://widget.example/', parent: appMain },
      },
    ],
    [
      'a call page under a remote main frame',
      {
        url: callFrame.url,
        parent: { url: 'https://evil.example/', parent: null },
      },
    ],
    [
      'a spoofed host',
      { url: 'trinity://app.evil/element-call/index.html', parent: appMain },
    ],
  ])('refuses %s', (_name, frame) => {
    expect(mayCaptureScreen(frame)).toBe(false);
  });
});

describe('captureChoices', () => {
  it('lists screens before windows and leaves out the Trinity window', () => {
    const sources = [
      window(3),
      screen(1),
      { id: 'window:7:1', name: 'Trinity' },
      screen(2),
    ];
    expect(captureChoices(sources, 'window:7:1')).toEqual([
      screen(1),
      screen(2),
      window(3),
    ]);
  });

  it('recognises the Trinity window by its window id whatever follows it', () => {
    const sources = [
      { id: 'window:7:1', name: 'Trinity' },
      { id: 'window:70:0', name: 'Editor' },
    ];
    expect(captureChoices(sources, 'window:7:0')).toEqual([
      { id: 'window:70:0', name: 'Editor' },
    ]);
  });
});

describe('installScreenShare', () => {
  type Handler = (
    request: { frame: Frame | null },
    callback: (streams: unknown) => void,
  ) => void;
  type FakeWindow = EventEmitter & {
    isVisible: () => boolean;
    getMediaSourceId: () => string;
  };

  let handler: Handler;
  let opts: unknown;
  let win: FakeWindow;
  const platform = process.platform;

  beforeEach(() => {
    getSources.mockReset();
    buildFromTemplate.mockReset().mockReturnValue({ popup });
    popup.mockReset();
    win = Object.assign(new EventEmitter(), {
      isVisible: () => true,
      getMediaSourceId: () => 'window:7:0',
    });
    mainWindow.current = win;
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    const session = {
      setDisplayMediaRequestHandler: vi.fn((h: Handler, o: unknown) => {
        handler = h;
        opts = o;
      }),
    };
    installScreenShare(session as never);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', { value: platform });
  });

  const answer = (frame: Frame | null = callFrame) =>
    new Promise((resolve) => handler({ frame }, resolve));
  const menu = (n = 0) => buildFromTemplate.mock.calls[n][0] as Template;
  const closeMenu = (n = 0) => popup.mock.calls[n][0].callback();
  const menuOpened = (times = 1) =>
    vi.waitFor(() => expect(popup).toHaveBeenCalledTimes(times));

  it('asks for the system picker where one exists', () => {
    expect(opts).toEqual({ useSystemPicker: true });
  });

  it('refuses another frame without listing sources', async () => {
    await expect(
      answer({ url: 'https://widget.example/', parent: appMain }),
    ).resolves.toBeNull();
    await expect(answer(null)).resolves.toBeNull();
    expect(getSources).not.toHaveBeenCalled();
  });

  it('asks the user even when there is only one source', async () => {
    getSources.mockResolvedValue([screen(1)]);
    const result = answer();
    await menuOpened();

    expect(menu().map((item) => item.label)).toEqual(['Screen 1']);
    menu()[0].click();
    await expect(result).resolves.toEqual({ video: screen(1) });
    expect(getSources).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['screen', 'window'] }),
    );
  });

  it('shares the one source the Wayland portal returned without a menu', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('XDG_SESSION_TYPE', 'wayland');
    getSources.mockResolvedValue([screen(1)]);

    await expect(answer()).resolves.toEqual({ video: screen(1) });
    expect(buildFromTemplate).not.toHaveBeenCalled();
  });

  it('shares the source the user picks from the menu, video only', async () => {
    getSources.mockResolvedValue([window(3, 'Editor'), screen(1)]);
    const result = answer();
    await menuOpened();

    expect(menu().map((item) => item.label)).toEqual(['Screen 1', 'Editor']);
    expect(popup).toHaveBeenCalledWith(
      expect.objectContaining({ window: win }),
    );
    menu()[1].click();
    closeMenu();
    await expect(result).resolves.toEqual({ video: window(3, 'Editor') });
    expect(win.listenerCount('closed')).toBe(0);
  });

  it('keeps a pick whose click arrives just after the menu closes', async () => {
    getSources.mockResolvedValue([screen(1), screen(2)]);
    const result = answer();
    await menuOpened();

    closeMenu();
    menu()[1].click();
    await expect(result).resolves.toEqual({ video: screen(2) });
  });

  it('refuses when the menu closes without a pick', async () => {
    getSources.mockResolvedValue([screen(1), screen(2)]);
    const result = answer();
    await menuOpened();

    closeMenu();
    await expect(result).resolves.toBeNull();
    expect(win.listenerCount('closed')).toBe(0);
  });

  it('refuses when the window closes while the menu is open', async () => {
    getSources.mockResolvedValue([screen(1), screen(2)]);
    const result = answer();
    await menuOpened();

    win.emit('closed');
    await expect(result).resolves.toBeNull();
  });

  it.each([
    ['there is no window', () => (mainWindow.current = null)],
    ['the window is hidden', () => (win.isVisible = () => false)],
  ])('refuses when %s', async (_name, arrange) => {
    arrange();
    await expect(answer()).resolves.toBeNull();
    expect(getSources).not.toHaveBeenCalled();
  });

  it('refuses a second request while one is open, then serves the next', async () => {
    getSources.mockResolvedValue([screen(1), screen(2)]);
    const first = answer();
    await menuOpened();

    await expect(answer()).resolves.toBeNull();
    closeMenu();
    await expect(first).resolves.toBeNull();

    const next = answer();
    await menuOpened(2);
    menu(1)[0].click();
    await expect(next).resolves.toEqual({ video: screen(1) });
  });

  it('refuses when there is nothing to share', async () => {
    getSources.mockResolvedValue([{ id: 'window:7:1', name: 'Trinity' }]);
    await expect(answer()).resolves.toBeNull();
  });

  it('refuses when the sources cannot be listed, and serves the next request', async () => {
    getSources.mockRejectedValueOnce(new Error('no portal'));
    await expect(answer()).resolves.toBeNull();

    getSources.mockResolvedValue([]);
    await expect(answer()).resolves.toBeNull();
    expect(getSources).toHaveBeenCalledTimes(2);
  });

  it('survives a frame that is gone by the time it is answered', async () => {
    getSources.mockResolvedValue([screen(1), screen(2)]);
    const answered = vi.fn(() => {
      throw new Error('Render frame was disposed');
    });
    handler({ frame: callFrame }, answered);
    await menuOpened();
    menu()[0].click();
    await vi.waitFor(() => expect(answered).toHaveBeenCalledOnce());

    getSources.mockResolvedValue([]);
    await expect(answer()).resolves.toBeNull();
  });
});
