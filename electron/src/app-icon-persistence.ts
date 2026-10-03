import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, nativeImage, shell } from 'electron';
import { dockIconFile, resolveIconFile, type AppIconName } from './icons';

/** Marks the per-user .desktop copy this module wrote, so Blurple never deletes the user's own. */
const LINUX_MARK = 'X-Trinity-App-Icon=dark';

// JXA through the system osascript: NSWorkspace sets the bundle's custom icon, or clears it for nil.
const SET_BUNDLE_ICON = `ObjC.import('AppKit');
function run([bundle, file]) {
  const image = file ? $.NSImage.alloc.initWithContentsOfFile(file) : null;
  return $.NSWorkspace.sharedWorkspace.setIconForFileOptions(image, bundle, 0);
}`;

/**
 * Keep the App icon on the surfaces that show Trinity while it is not running: the macOS
 * bundle (Dock, Finder), Trinity's Windows shortcuts and a Linux deb's .desktop entry.
 * Packaged builds only. A failure leaves the shipped Blurple icon in place.
 */
export function persistAppIcon(icon: AppIconName): void {
  if (!app.isPackaged) return;
  try {
    if (process.platform === 'darwin') persistMac(icon);
    else if (process.platform === 'win32') persistWindows(icon);
    else if (process.platform === 'linux' && !process.env['APPIMAGE'])
      persistLinux(icon);
  } catch (error) {
    console.warn('[app-icon] could not keep the icon after quit', error);
  }
}

/** Rewrites the signed bundle (an unsealed custom icon); an update replaces the bundle, so startup re-applies it. */
function persistMac(icon: AppIconName): void {
  // …/Trinity.app/Contents/MacOS/Trinity → …/Trinity.app
  const bundle = path.resolve(app.getPath('exe'), '../../..');
  const file =
    icon === 'dark' ? (resolveIconFile(dockIconFile('dark')) ?? '') : '';
  execFile(
    'osascript',
    ['-l', 'JavaScript', '-e', SET_BUNDLE_ICON, bundle, file],
    (error) => {
      if (error)
        console.warn('[app-icon] could not set the bundle icon', error);
    },
  );
}

function persistWindows(icon: AppIconName): void {
  const appData = app.getPath('appData');
  // The NSIS per-user shortcuts, plus the user's taskbar pin.
  const shortcuts = [
    path.join(appData, 'Microsoft/Windows/Start Menu/Programs/Trinity.lnk'),
    path.join(app.getPath('desktop'), 'Trinity.lnk'),
    path.join(
      appData,
      'Microsoft/Internet Explorer/Quick Launch/User Pinned/TaskBar/Trinity.lnk',
    ),
  ]
    .filter((link) => fs.existsSync(link))
    .map((link) => ({ link, details: shell.readShortcutLink(link) }))
    .filter(
      ({ details }) =>
        path.resolve(details.target) === path.resolve(process.execPath),
    );
  if (shortcuts.length === 0) return;
  const iconPath = icon === 'dark' ? darkIco() : process.execPath;
  for (const { link, details } of shortcuts) {
    shell.writeShortcutLink(link, 'update', {
      ...details,
      icon: iconPath,
      iconIndex: 0,
    });
  }
}

/** Shortcuts need an .ico: one 256 px PNG entry, which Windows reads since Vista. */
function darkIco(): string {
  const source = resolveIconFile('icon-dark.png');
  if (!source) throw new Error('icon-dark.png is missing');
  const png = nativeImage
    .createFromPath(source)
    .resize({ width: 256, height: 256 })
    .toPNG();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image; width and height 0 mean 256
  header.writeUInt16LE(1, 10); // colour planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(header.length, 18);
  const file = path.join(app.getPath('userData'), 'icon-dark.ico');
  fs.writeFileSync(file, Buffer.concat([header, png]));
  return file;
}

// ponytail: the user copy outlives an uninstall of the deb; remove it there if that ever matters.
function persistLinux(icon: AppIconName): void {
  const dataHome =
    process.env['XDG_DATA_HOME'] || path.join(os.homedir(), '.local/share');
  const dataDirs = (
    process.env['XDG_DATA_DIRS'] || '/usr/local/share:/usr/share'
  ).split(':');
  const entry = dataDirs
    .map((dir) => path.join(dir, 'applications'))
    .flatMap((dir) => {
      try {
        return fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.desktop'))
          .map((name) => path.join(dir, name));
      } catch {
        return [];
      }
    })
    .find((file) =>
      /^Exec=.*$/m
        .exec(fs.readFileSync(file, 'utf8'))?.[0]
        .includes(process.execPath),
    );
  if (!entry) return;
  // A same-named file in the user's data home overrides the system entry.
  const override = path.join(dataHome, 'applications', path.basename(entry));
  if (icon === 'blurple') {
    if (
      fs.existsSync(override) &&
      String(fs.readFileSync(override, 'utf8')).includes(LINUX_MARK)
    )
      fs.rmSync(override);
    return;
  }
  const dark = resolveIconFile('icon-dark.png');
  if (!dark) return;
  const text = String(fs.readFileSync(entry, 'utf8')).replace(
    /^Icon=.*$/m,
    `Icon=${dark}`,
  );
  fs.mkdirSync(path.dirname(override), { recursive: true });
  fs.writeFileSync(override, `${text.trimEnd()}\n${LINUX_MARK}\n`);
}
