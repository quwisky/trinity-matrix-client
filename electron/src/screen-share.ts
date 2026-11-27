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
  ownWindowId: string,
): T[] {
  // Only `window:<id>:` names the window; what follows can differ between the two APIs.
  const own = `${ownWindowId.split(':').slice(0, 2).join(':')}:`;
  const choices = sources.filter((source) => !source.id.startsWith(own));
  return [
    ...choices.filter((source) => source.id.startsWith('screen:')),
    ...choices.filter((source) => !source.id.startsWith('screen:')),
  ];
}

// Wayland's desktop portal has already asked the user and returns only the source picked there.
function portalHasAsked(): boolean {
  return (
    process.platform === 'linux' &&
    process.env['XDG_SESSION_TYPE'] === 'wayland'
  );
}

function pick<T extends Source>(
  choices: readonly T[],
  window: Electron.BrowserWindow,
): Promise<T | undefined> {
  if (choices.length === 0) return Promise.resolve(undefined);
  if (choices.length === 1 && portalHasAsked()) {
    return Promise.resolve(choices[0]);
  }
  return new Promise((resolve) => {
    const closed = () => settle(undefined);
    const settle = (source: T | undefined) => {
      window.removeListener('closed', closed);
      resolve(source);
    };
    window.once('closed', closed);
    Menu.buildFromTemplate(
      choices.map((source) => ({
        label: source.name,
        click: () => settle(source),
      })),
    ).popup({
      window,
      // The close callback may run before the picked item's click; let the click win.
      callback: () => setImmediate(() => settle(undefined)),
    });
  });
}

// One picker at a time: a second menu could answer the wrong request.
let picking = false;

async function chooseStream(
  frame: Frame | null,
): Promise<Electron.Streams | null> {
  const window = getMainWindow();
  if (!mayCaptureScreen(frame) || !window?.isVisible() || picking) return null;
  picking = true;
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 0, height: 0 },
    });
    const source = await pick(
      captureChoices(sources, window.getMediaSourceId()),
      window,
    );
    return source ? { video: source } : null;
  } finally {
    picking = false;
  }
}

/**
 * Answer `getDisplayMedia` from the call frame with a screen or window the user picks, video
 * only. Every other request, a dismissed menu and a failure all answer `null`, which rejects
 * the page's promise instead of leaving it pending. macOS 15+ shows its own picker instead,
 * without calling this handler.
 */
export function installScreenShare(session: Electron.Session): void {
  session.setDisplayMediaRequestHandler(
    (request, callback) => {
      void chooseStream(request.frame)
        .catch(() => null)
        .then((streams) => {
          try {
            callback(streams);
          } catch {
            // The requesting frame is gone; there is no one left to answer.
          }
        });
    },
    { useSystemPicker: true },
  );
}
