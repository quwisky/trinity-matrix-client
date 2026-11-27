import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getSources, buildFromTemplate, popup } = vi.hoisted(() => ({
  getSources: vi.fn(),
  buildFromTemplate: vi.fn(),
  popup: vi.fn(),
}));
vi.mock('electron', () => ({
  desktopCapturer: { getSources },
  Menu: { buildFromTemplate },
  protocol: {},
}));
vi.mock('./window', () => ({
  getMainWindow: () => ({ getMediaSourceId: () => 'window:7:1' }),
}));

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
});

describe('installScreenShare', () => {
  type Handler = (
    request: { frame: Frame | null },
    callback: (streams: unknown) => void,
  ) => void;

  let handler: Handler;
  let opts: unknown;

  beforeEach(() => {
    getSources.mockReset();
    buildFromTemplate.mockReset().mockReturnValue({ popup });
    popup.mockReset();
    const session = {
      setDisplayMediaRequestHandler: vi.fn((h: Handler, o: unknown) => {
        handler = h;
        opts = o;
      }),
    };
    installScreenShare(session as never);
  });

  const answer = (frame: Frame | null = callFrame) =>
    new Promise((resolve) => handler({ frame }, resolve));
  const menu = () => buildFromTemplate.mock.calls[0][0] as Template;
  const closeMenu = () => popup.mock.calls[0][0].callback();
  const menuOpened = () => vi.waitFor(() => expect(popup).toHaveBeenCalled());

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

  it('shares the one source directly, video only', async () => {
    getSources.mockResolvedValue([screen(1)]);
    await expect(answer()).resolves.toEqual({ video: screen(1) });
    expect(getSources).toHaveBeenCalledWith(
      expect.objectContaining({ types: ['screen', 'window'] }),
    );
    expect(buildFromTemplate).not.toHaveBeenCalled();
  });

  it('shares the source the user picks from the menu', async () => {
    getSources.mockResolvedValue([window(3, 'Editor'), screen(1)]);
    const result = answer();
    await menuOpened();

    expect(menu().map((item) => item.label)).toEqual(['Screen 1', 'Editor']);
    menu()[1].click();
    closeMenu();
    await expect(result).resolves.toEqual({ video: window(3, 'Editor') });
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
  });

  it('refuses when there is nothing to share', async () => {
    getSources.mockResolvedValue([{ id: 'window:7:1', name: 'Trinity' }]);
    await expect(answer()).resolves.toBeNull();
  });

  it('refuses when the sources cannot be listed', async () => {
    getSources.mockRejectedValue(new Error('no portal'));
    await expect(answer()).resolves.toBeNull();
  });
});
