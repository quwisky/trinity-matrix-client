import { test, expect, type Page } from './fixtures.mts';
import { type ElectronApplication, type Frame } from 'playwright';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { launchApp } from './support/launch.mts';

type PickerGlobals = { trinityPick?: string; trinityMenus: string[][] };
type Source = { id: string; name: string };
type MenuItem = { label: string; click: () => void };
type ElectronModules = {
  desktopCapturer: { getSources: (options: unknown) => Promise<Source[]> };
  Menu: {
    buildFromTemplate: (template: MenuItem[]) => {
      popup: (options?: { callback?: () => void }) => void;
    };
  };
};

const SECOND_SCREEN = 'Second screen';
let app: ElectronApplication;
let page: Page;
let callFrame: Frame;

/** Frame an app or remote document the way the call host frames Element Call. */
async function addFrame(src: string): Promise<Frame> {
  await page.evaluate((url) => {
    const frame = document.createElement('iframe');
    frame.src = url;
    frame.allow =
      'camera; microphone; display-capture; autoplay; clipboard-write';
    document.body.append(frame);
  }, src);
  await expect
    .poll(() => page.frames().some((frame) => frame.url().startsWith(src)))
    .toBe(true);
  const frame = page
    .frames()
    .find((candidate) => candidate.url().startsWith(src))!;
  await frame.waitForLoadState('domcontentloaded');
  return frame;
}

function shareScreen(frame: Frame): Promise<string> {
  return frame.evaluate(() =>
    navigator.mediaDevices.getDisplayMedia({ video: true, audio: true }).then(
      (stream) => {
        const tracks = stream.getTracks().map((track) => track.kind);
        stream.getTracks().forEach((track) => track.stop());
        return tracks.join(',');
      },
      (error: Error) => error.name,
    ),
  );
}

const menus = () =>
  app.evaluate(() =>
    (globalThis as unknown as PickerGlobals).trinityMenus.splice(0),
  );
const pickNext = (label: string | undefined) =>
  app.evaluate((_electron, pick) => {
    (globalThis as unknown as PickerGlobals).trinityPick = pick;
  }, label);

test.beforeAll(async () => {
  app = await launchApp();
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // Playwright cannot drive a native menu, and bare Xvfb lists a single screen; stand in for
  // both so the shell's own policy, source handling and capture still run for real.
  await app.evaluate(({ desktopCapturer, Menu }: ElectronModules) => {
    const globals = globalThis as unknown as PickerGlobals;
    globals.trinityMenus = [];
    const listSources = desktopCapturer.getSources.bind(desktopCapturer);
    desktopCapturer.getSources = async (options) => {
      const sources = await listSources(options);
      const screen = sources.find((source) => source.id.startsWith('screen:'))!;
      return [...sources, { ...screen, name: 'Second screen' }];
    };
    const buildMenu = Menu.buildFromTemplate.bind(Menu);
    Menu.buildFromTemplate = (template) => {
      const menu = buildMenu(template);
      menu.popup = ({ callback } = {}) => {
        globals.trinityMenus.push(template.map((item) => item.label));
        template.find((item) => item.label === globals.trinityPick)?.click();
        callback?.();
      };
      return menu;
    };
  });
  callFrame = await addFrame('trinity://app/element-call/index.html');
});

test.afterAll(async () => {
  await app?.close();
});

test('shares the screen the user picks with the call frame, video only', async () => {
  await pickNext(SECOND_SCREEN);

  expect(await shareScreen(callFrame)).toBe('video');
  const [listed] = await menus();
  expect(listed.at(-1)).toBe(SECOND_SCREEN);
  expect(listed.indexOf(SECOND_SCREEN)).toBeGreaterThan(0);
});

test('rejects the call frame when the user dismisses the picker', async () => {
  await pickNext(undefined);

  // Electron rejects every refusal from the display-media handler this way.
  expect(await shareScreen(callFrame)).toBe('AbortError');
  expect(await menus()).toHaveLength(1);
});

test('refuses the app itself and frames other than the call frame', async () => {
  const server = createServer(
    {
      key: readFileSync(
        new URL('./fixtures/localhost-key.pem', import.meta.url),
      ),
      cert: readFileSync(
        new URL('./fixtures/localhost-cert.pem', import.meta.url),
      ),
    },
    (_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>widget</title>');
    },
  );
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const remote = await addFrame(
      `https://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    );
    await pickNext(SECOND_SCREEN);

    expect(await shareScreen(page.mainFrame())).toBe('NotAllowedError');
    expect(await shareScreen(remote)).toBe('NotAllowedError');
    expect(await menus()).toEqual([]);
  } finally {
    server.close();
  }
});
