import { desktopCapturer, Menu } from 'electron';
import { isAppUrl, isCallFrameUrl } from './scheme';
import { getMainWindow } from './window';

type Frame = { readonly url: string; readonly parent: Frame | null };
type Source = { readonly id: string; readonly name: string };

/** Only the bundled call frame, directly inside the app's main frame, may capture the screen. */
export function mayCaptureScreen(frame: Frame | null): boolean {
  const parent = frame?.parent;
  return (
    !!frame &&
    !!parent &&
    parent.parent === null &&
    isAppUrl(parent.url) &&
    isCallFrameUrl(frame.url)
  );
}

/** Screens, then windows, without Trinity's own window. */
export function captureChoices<T extends Source>(
  sources: readonly T[],
  ownWindowId: string | undefined,
): T[] {
  const choices = sources.filter((source) => source.id !== ownWindowId);
  return [
    ...choices.filter((source) => source.id.startsWith('screen:')),
    ...choices.filter((source) => !source.id.startsWith('screen:')),
  ];
}

// A single source needs no menu: on Wayland the desktop portal has already asked the user.
function pick<T extends Source>(choices: readonly T[]): Promise<T | undefined> {
  if (choices.length <= 1) return Promise.resolve(choices[0]);
  return new Promise((resolve) => {
    Menu.buildFromTemplate(
      choices.map((source) => ({
        label: source.name,
        click: () => resolve(source),
      })),
    ).popup({
      window: getMainWindow() ?? undefined,
      // The close callback may run before the picked item's click; let the click win.
      callback: () => setImmediate(() => resolve(undefined)),
    });
  });
}

async function chooseStream(
  frame: Frame | null,
): Promise<Electron.Streams | null> {
  if (!mayCaptureScreen(frame)) return null;
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 0, height: 0 },
  });
  const source = await pick(
    captureChoices(sources, getMainWindow()?.getMediaSourceId()),
  );
  return source ? { video: source } : null;
}

/**
 * Answer `getDisplayMedia` from the call frame with a screen or window the user picks, video
 * only. Every other request, a dismissed menu and a failure all answer `null`, which rejects
 * the page's promise instead of leaving it pending. macOS 15+ shows its own picker instead.
 */
export function installScreenShare(session: Electron.Session): void {
  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      chooseStream(request.frame).then(callback, () => callback(null));
    },
    { useSystemPicker: true },
  );
}
