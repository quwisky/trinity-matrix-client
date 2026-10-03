/**
 * Render every platform icon from Trinity's two SVG sources.
 *
 * Sources (apps/trinity/src/assets/icon/): icon-plated.svg (white mark on the blurple
 * tile) and icon.svg (transparent blurple mark, recoloured here per platform). Edit
 * those, run `pnpm icons:generate`, commit the results; scripts/generate-icons.spec.mjs
 * fails when a committed icon no longer matches a fresh render.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { crc32, deflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';

const ROOT = resolve(import.meta.dirname, '..');
const ICON_DIR = 'apps/trinity/src/assets/icon';
const BRAND = '#5865f2';
const DARK_TILE = '#1e1f22';
const DARK_MARK = '#8891f7';
const TINT_MARK = '#cccccc';
const MARK_BOX = { x: 158, y: 118, width: 708, height: 638 };

const read = (name) => readFileSync(join(ROOT, ICON_DIR, name), 'utf8');
const inner = (svg) =>
  svg.slice(
    svg.indexOf('>', svg.indexOf('<svg')) + 1,
    svg.lastIndexOf('</svg>'),
  );
const MARK = inner(read('icon.svg'));
const PLATED = inner(read('icon-plated.svg'));
const PLATED_SQUARE = PLATED.replaceAll('rx="224"', 'rx="0"');
/** The square plate's gradient and sheen without the mark. */
const PLATE_ONLY = PLATED_SQUARE.replace(/<g stroke[\s\S]*$/, '');

const doc = (w, h, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`;
const rect = (w, h, fill) =>
  `<rect width="${w}" height="${h}" fill="${fill}"/>`;
/** The 1024 plate (rounded or square) placed at x,y with side s. */
const plate = (x, y, s, body = PLATED) =>
  `<svg x="${x}" y="${y}" width="${s}" height="${s}" viewBox="0 0 1024 1024">${body}</svg>`;
/** The mark recoloured, its bounding box scaled to `fraction` of the canvas width, centred. */
const mark = (w, h, color, fraction) => {
  const mw = w * fraction;
  const mh = (mw * MARK_BOX.height) / MARK_BOX.width;
  return `<svg x="${(w - mw) / 2}" y="${(h - mh) / 2}" width="${mw}" height="${mh}" viewBox="${MARK_BOX.x} ${MARK_BOX.y} ${MARK_BOX.width} ${MARK_BOX.height}">${MARK.replaceAll(BRAND, color)}</svg>`;
};

/** The dark plate in the same 1024 space as PLATED: DARK_MARK on a DARK_TILE tile. */
const DARK_MARK_LAYER = mark(1024, 1024, DARK_MARK, 0.66);
const DARK_PLATED = `<rect width="1024" height="1024" rx="224" fill="${DARK_TILE}"/>${DARK_MARK_LAYER}`;
const DARK_SQUARE = `<rect width="1024" height="1024" fill="${DARK_TILE}"/>${DARK_MARK_LAYER}`;

const plated = (s, body = PLATED) => doc(s, s, plate(0, 0, s, body));
const platedSquare = (s) => doc(s, s, plate(0, 0, s, PLATED_SQUARE));
const platedRound = (s, body = PLATED_SQUARE) =>
  doc(
    s,
    s,
    `<clipPath id="c"><circle cx="${s / 2}" cy="${s / 2}" r="${s / 2}"/></clipPath><g clip-path="url(#c)">${plate(0, 0, s, body)}</g>`,
  );
/** Apple's macOS grid: an 824 tile centred on a transparent 1024 canvas. */
const macGrid = (s, body = PLATED) =>
  doc(
    s,
    s,
    `<defs><filter id="shadow" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="${s * 0.0098}" stdDeviation="${s * 0.0098}" flood-color="#000000" flood-opacity="0.3"/></filter></defs><g filter="url(#shadow)">${plate(s * 0.0977, s * 0.0977, s * 0.8047, body)}</g>`,
  );
const markOnly = (s, color, fraction) => doc(s, s, mark(s, s, color, fraction));
const markOnTile = (s, tile, color, fraction) =>
  doc(s, s, rect(s, s, tile) + mark(s, s, color, fraction));
const maskable = (s) =>
  doc(s, s, plate(0, 0, s, PLATE_ONLY) + mark(s, s, '#ffffff', 0.56));
const splash = (w, h) => {
  const side = Math.round(Math.min(w, h) * 0.25);
  return doc(
    w,
    h,
    rect(w, h, '#ffffff') + plate((w - side) / 2, (h - side) / 2, side),
  );
};

const DPI = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };
const RES = 'android/app/src/main/res';
const IOS = 'ios/App/App/Assets.xcassets';
const out = (path, width, height, svg, extra = {}) => ({
  path,
  width,
  height,
  svg,
  alpha: true,
  ...extra,
});

/** Every committed icon, in write order. `svg` builds the document; `rule`/`safeRadius` feed the spec. */
export const OUTPUTS = [
  // Desktop: electron-builder derives .ico and Linux sizes from icon.png, .icns from icon-mac.png
  out('electron/build/icon.png', 1024, 1024, () => plated(1024)),
  // macOS only: Apple's grid insets the tile (electron-builder mac.icon).
  out('electron/build/icon-mac.png', 1024, 1024, () => macGrid(1024)),
  out(
    'electron/build/trinityTrayTemplate.png',
    16,
    16,
    () => markOnly(16, '#000000', 0.95),
    { rule: 'black-alpha' },
  ),
  out(
    'electron/build/trinityTrayTemplate@2x.png',
    32,
    32,
    () => markOnly(32, '#000000', 0.95),
    { rule: 'black-alpha' },
  ),
  out('electron/build/trinityTray.png', 16, 16, () => plated(16)),
  out('electron/build/trinityTray@2x.png', 32, 32, () => plated(32)),
  // Linux AppIndicators draw larger than the Windows notification area.
  out('electron/build/trinityTrayLinux.png', 32, 32, () => plated(32)),
  out('electron/build/trinityTrayLinux@2x.png', 64, 64, () => plated(64)),
  out('electron/build/notificationIcon.png', 256, 256, () => plated(256)),
  // Dark twins, swapped in at runtime by the App icon preference (electron/src/app-icon.ts).
  out('electron/build/icon-dark.png', 1024, 1024, () =>
    plated(1024, DARK_PLATED),
  ),
  out('electron/build/icon-mac-dark.png', 1024, 1024, () =>
    macGrid(1024, DARK_PLATED),
  ),
  out('electron/build/trinityTray-dark.png', 16, 16, () =>
    plated(16, DARK_PLATED),
  ),
  out('electron/build/trinityTray-dark@2x.png', 32, 32, () =>
    plated(32, DARK_PLATED),
  ),
  out('electron/build/trinityTrayLinux-dark.png', 32, 32, () =>
    plated(32, DARK_PLATED),
  ),
  out('electron/build/trinityTrayLinux-dark@2x.png', 64, 64, () =>
    plated(64, DARK_PLATED),
  ),
  // Web and PWA
  out(`${ICON_DIR}/icon-1024.png`, 1024, 1024, () => plated(1024)),
  out(`${ICON_DIR}/icon-192.png`, 192, 192, () => plated(192)),
  out(`${ICON_DIR}/icon-512.png`, 512, 512, () => plated(512)),
  out(`${ICON_DIR}/icon-maskable-192.png`, 192, 192, () => maskable(192), {
    safeRadius: 0.4,
    rule: 'mark-on-tile',
  }),
  out(`${ICON_DIR}/icon-maskable-512.png`, 512, 512, () => maskable(512), {
    safeRadius: 0.4,
    rule: 'mark-on-tile',
  }),
  out(
    `${ICON_DIR}/icon-monochrome-512.png`,
    512,
    512,
    () => markOnly(512, '#ffffff', 0.6),
    { rule: 'white-alpha' },
  ),
  out(`${ICON_DIR}/favicon.png`, 256, 256, () => plated(256)),
  out(`${ICON_DIR}/favicon-dark.png`, 256, 256, () => plated(256, DARK_PLATED)),
  out(`${ICON_DIR}/apple-touch-icon.png`, 180, 180, () => platedSquare(180), {
    alpha: false,
  }),
  // Android launcher (108 dp adaptive canvas; 66 dp safe circle → radius 0.3056)
  ...Object.entries(DPI).flatMap(([dpi, k]) => [
    out(
      `${RES}/mipmap-${dpi}/ic_launcher_foreground.png`,
      108 * k,
      108 * k,
      () => markOnly(108 * k, '#ffffff', 0.42),
      { rule: 'white-alpha', safeRadius: 0.3056 },
    ),
    out(
      `${RES}/mipmap-${dpi}/ic_launcher_monochrome.png`,
      108 * k,
      108 * k,
      () => markOnly(108 * k, '#ffffff', 0.42),
      { rule: 'white-alpha', safeRadius: 0.3056 },
    ),
    out(
      `${RES}/mipmap-${dpi}/ic_launcher_background.png`,
      108 * k,
      108 * k,
      () => doc(108 * k, 108 * k, plate(0, 0, 108 * k, PLATE_ONLY)),
    ),
    out(`${RES}/mipmap-${dpi}/ic_launcher.png`, 48 * k, 48 * k, () =>
      plated(48 * k),
    ),
    out(`${RES}/mipmap-${dpi}/ic_launcher_round.png`, 48 * k, 48 * k, () =>
      platedRound(48 * k),
    ),
    out(
      `${RES}/drawable-${dpi}/ic_stat_trinity.png`,
      24 * k,
      24 * k,
      () => markOnly(24 * k, '#ffffff', 0.83),
      { rule: 'white-alpha' },
    ),
    out(
      `${RES}/mipmap-${dpi}/ic_launcher_dark_foreground.png`,
      108 * k,
      108 * k,
      () => markOnly(108 * k, DARK_MARK, 0.42),
      { safeRadius: 0.3056 },
    ),
    out(
      `${RES}/mipmap-${dpi}/ic_launcher_dark_background.png`,
      108 * k,
      108 * k,
      () => doc(108 * k, 108 * k, rect(108 * k, 108 * k, DARK_TILE)),
    ),
    out(`${RES}/mipmap-${dpi}/ic_launcher_dark.png`, 48 * k, 48 * k, () =>
      plated(48 * k, DARK_PLATED),
    ),
    out(`${RES}/mipmap-${dpi}/ic_launcher_dark_round.png`, 48 * k, 48 * k, () =>
      platedRound(48 * k, DARK_SQUARE),
    ),
  ]),
  // Android splash (existing sizes)
  out(`${RES}/drawable/splash.png`, 480, 320, () => splash(480, 320), {
    alpha: false,
  }),
  ...[
    ['mdpi', 320, 480],
    ['hdpi', 480, 800],
    ['xhdpi', 720, 1280],
    ['xxhdpi', 960, 1600],
    ['xxxhdpi', 1280, 1920],
  ].flatMap(([dpi, w, h]) => [
    out(`${RES}/drawable-port-${dpi}/splash.png`, w, h, () => splash(w, h), {
      alpha: false,
    }),
    out(`${RES}/drawable-land-${dpi}/splash.png`, h, w, () => splash(h, w), {
      alpha: false,
    }),
  ]),
  // iOS
  out(
    `${IOS}/AppIcon.appiconset/AppIcon-light.png`,
    1024,
    1024,
    () => platedSquare(1024),
    { alpha: false },
  ),
  out(
    `${IOS}/AppIcon.appiconset/AppIcon-dark.png`,
    1024,
    1024,
    () => markOnTile(1024, DARK_TILE, DARK_MARK, 0.66),
    { alpha: false },
  ),
  out(
    `${IOS}/AppIcon.appiconset/AppIcon-tinted.png`,
    1024,
    1024,
    () => markOnly(1024, TINT_MARK, 0.66),
    { rule: 'mark-on-transparent' },
  ),
  // Alternate icons for the App icon preference (MainViewController.swift AppIconPlugin).
  {
    path: `${IOS}/AppIconBlurple.appiconset/AppIcon.png`,
    copyOf: `${IOS}/AppIcon.appiconset/AppIcon-light.png`,
    fromOutput: true,
  },
  {
    path: `${IOS}/AppIconDark.appiconset/AppIcon.png`,
    copyOf: `${IOS}/AppIcon.appiconset/AppIcon-dark.png`,
    fromOutput: true,
  },
  out(
    `${IOS}/Splash.imageset/splash-2732x2732.png`,
    2732,
    2732,
    () => splash(2732, 2732),
    { alpha: false },
  ),
  // The other two scales are the same image; copy it instead of rendering it again.
  ...['splash-2732x2732-1.png', 'splash-2732x2732-2.png'].map((name) => ({
    path: `${IOS}/Splash.imageset/${name}`,
    copyOf: `${IOS}/Splash.imageset/splash-2732x2732.png`,
    fromOutput: true,
  })),
  // Copied, not rendered: the transparent mark as an SVG favicon.
  { path: `${ICON_DIR}/favicon.svg`, copyOf: `${ICON_DIR}/icon.svg` },
];

/** Minimal deterministic PNG encoder: 8-bit RGBA (colour type 6) or opaque RGB (type 2). */
export function encodePng(width, height, rgba, alpha) {
  const channels = alpha ? 4 : 3;
  const raw = Buffer.alloc((width * channels + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    for (let x = 0; x < width; x += 1) {
      const src = (y * width + x) * 4;
      if (!alpha && rgba[src + 3] !== 255) {
        throw new Error(
          `Pixel ${x},${y} is not opaque; this icon must have no alpha channel.`,
        );
      }
      rgba.subarray(src, src + channels).forEach((v, c) => {
        raw[row + 1 + x * channels + c] = v;
      });
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Render every output under `outRoot` and return them (rendered ones with pixels). */
export function renderIcons(outRoot = ROOT) {
  const rendered = [];
  for (const output of OUTPUTS) {
    const target = join(outRoot, output.path);
    mkdirSync(dirname(target), { recursive: true });
    if (output.copyOf) {
      writeFileSync(
        target,
        readFileSync(join(output.fromOutput ? outRoot : ROOT, output.copyOf)),
      );
      continue;
    }
    const image = new Resvg(output.svg(), {
      fitTo: { mode: 'original' },
    }).render();
    if (image.width !== output.width || image.height !== output.height) {
      throw new Error(`${output.path} rendered ${image.width}x${image.height}`);
    }
    // resvg returns premultiplied RGBA; PNG stores straight alpha.
    const rgba = Uint8Array.from(image.pixels);
    for (let i = 0; i < rgba.length; i += 4) {
      const a = rgba[i + 3];
      if (a > 0 && a < 255) {
        for (let c = 0; c < 3; c += 1)
          rgba[i + c] = Math.min(255, Math.round((rgba[i + c] * 255) / a));
      }
    }
    const png = encodePng(output.width, output.height, rgba, output.alpha);
    writeFileSync(target, png);
    const { svg: _svg, ...meta } = output;
    rendered.push({ ...meta, rgba, png });
  }
  return rendered;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const written = renderIcons(values.out ? resolve(values.out) : ROOT);
  console.log(
    `Wrote ${written.length} icons and ${OUTPUTS.length - written.length} copies.`,
  );
}
