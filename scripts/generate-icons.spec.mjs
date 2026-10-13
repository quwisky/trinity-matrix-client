/** Every generated icon has the exact size and the pixel rule its platform requires. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  encodePng,
  ICON_COMPOSER,
  OUTPUTS,
  renderIcons,
} from './generate-icons.mjs';

let out;
let icons;
// Rendering every icon (three 2732² splashes among them) takes ~7 s alone and twice
// that beside the rest of the scripts project, past Vitest's 10 s hook default.
beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), 'trinity-icons-'));
  icons = renderIcons(out);
}, 120_000);
afterAll(() => rmSync(out, { recursive: true, force: true }));

const pixels = (icon) => {
  const list = [];
  for (let i = 0; i < icon.rgba.length; i += 4) {
    const p = i / 4;
    list.push({
      x: p % icon.width,
      y: Math.floor(p / icon.width),
      r: icon.rgba[i],
      g: icon.rgba[i + 1],
      b: icon.rgba[i + 2],
      a: icon.rgba[i + 3],
    });
  }
  return list;
};
const byRule = (rule) => icons.filter((icon) => icon.rule === rule);

describe('generated icons', () => {
  const find = (path) => icons.find((i) => i.path === path);
  const alphaAt = (icon, x, y) => icon.rgba[(y * icon.width + x) * 4 + 3];

  it('renders the iOS splash once and copies it for the other scales', () => {
    const splashes = OUTPUTS.filter((o) => o.path.includes('Splash.imageset/'));
    expect(splashes.filter((o) => o.width).map((o) => o.path)).toEqual([
      'ios/App/App/Assets.xcassets/Splash.imageset/splash-2732x2732.png',
    ]);
    expect(splashes.filter((o) => o.copyOf)).toHaveLength(2);
  });

  it('keeps the Android notification mark within the 20 dp live area', () => {
    const icon = find(
      'android/app/src/main/res/drawable-xxxhdpi/ic_stat_trinity.png',
    );
    let min = icon.width;
    let max = -1;
    for (let i = 0; i < icon.rgba.length; i += 4) {
      if (icon.rgba[i + 3] > 0) {
        const x = (i / 4) % icon.width;
        min = Math.min(min, x);
        max = Math.max(max, x);
      }
    }
    expect(max - min + 1).toBeLessThanOrEqual((20 / 24) * icon.width);
  });

  it('gives the adaptive icon an opaque gradient background without the mark', () => {
    const icon = find(
      'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_background.png',
    );
    expect([icon.width, icon.height]).toEqual([432, 432]);
    const px = (x, y) =>
      icon.rgba.subarray(
        (y * icon.width + x) * 4,
        (y * icon.width + x) * 4 + 4,
      );
    for (let i = 3; i < icon.rgba.length; i += 4)
      expect(icon.rgba[i]).toBe(255);
    expect(px(10, 10)).not.toEqual(px(420, 420));
    let white = 0;
    for (let i = 0; i < icon.rgba.length; i += 4) {
      if (
        icon.rgba[i] > 240 &&
        icon.rgba[i + 1] > 240 &&
        icon.rgba[i + 2] > 240
      )
        white += 1;
    }
    expect(white).toBe(0);
  });

  it('casts a soft shadow below the macOS tile', () => {
    const icon = find('electron/build/icon-mac.png');
    const below = Math.round(1024 * (0.0977 + 0.8047)) + 8;
    const a = alphaAt(icon, 512, below);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
  });

  it('sizes the Windows tray for 16 px and the Linux tray for 32 px, each with @2x', () => {
    expect(
      [
        'electron/build/trinityTray.png',
        'electron/build/trinityTray@2x.png',
        'electron/build/trinityTrayLinux.png',
        'electron/build/trinityTrayLinux@2x.png',
      ].map((path) => find(path)?.width),
    ).toEqual([16, 32, 32, 64]);
  });

  it('keeps the Windows/Linux icon full-bleed and insets only the macOS one', () => {
    const at = (path, x, y) => {
      const icon = icons.find((i) => i.path === path);
      return icon.rgba[(y * icon.width + x) * 4 + 3];
    };
    // 6 % in from the left edge, half-way down: inside a full-bleed tile, outside Apple's grid.
    expect(at('electron/build/icon.png', 61, 512)).toBe(255);
    expect(at('electron/build/icon-mac.png', 61, 512)).toBe(0);
  });

  it('renders every declared output at its exact size', () => {
    expect(icons.map((icon) => icon.path)).toEqual(
      OUTPUTS.filter((o) => o.width).map((o) => o.path),
    );
    for (const icon of icons) {
      expect(icon.png.readUInt32BE(16), icon.path).toBe(icon.width);
      expect(icon.png.readUInt32BE(20), icon.path).toBe(icon.height);
    }
  });

  it('encodes opaque icons without an alpha channel and the rest with one', () => {
    for (const icon of icons) {
      expect(icon.png[25], icon.path).toBe(icon.alpha ? 6 : 2);
    }
    expect(icons.filter((i) => !i.alpha).map((i) => i.path)).toEqual(
      expect.arrayContaining([
        'apps/trinity/src/assets/icon/apple-touch-icon.png',
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-light.png',
        'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-dark.png',
      ]),
    );
  });

  it('keeps macOS menu-bar templates black so the OS can tint them', () => {
    expect(byRule('black-alpha').map((i) => i.path)).toEqual([
      'electron/build/trinityTrayTemplate.png',
      'electron/build/trinityTrayTemplate@2x.png',
    ]);
    for (const icon of byRule('black-alpha')) {
      const drawn = pixels(icon).filter((p) => p.a > 0);
      expect(drawn.length, icon.path).toBeGreaterThan(0);
      expect(
        drawn.every((p) => p.r === 0 && p.g === 0 && p.b === 0),
        icon.path,
      ).toBe(true);
    }
  });

  it('keeps Android notification and monochrome layers white-only', () => {
    expect(byRule('white-alpha').length).toBeGreaterThan(0);
    for (const icon of byRule('white-alpha')) {
      const drawn = pixels(icon).filter((p) => p.a > 0);
      expect(drawn.length, icon.path).toBeGreaterThan(0);
      expect(
        drawn.every((p) => p.r === 255 && p.g === 255 && p.b === 255),
        icon.path,
      ).toBe(true);
    }
  });

  it('keeps adaptive and maskable marks inside their safe circle', () => {
    const safe = icons.filter((icon) => icon.safeRadius);
    expect(safe.length).toBeGreaterThan(0);
    for (const icon of safe) {
      const cx = icon.width / 2;
      const cy = icon.height / 2;
      const limit = icon.safeRadius * icon.width;
      const mark = pixels(icon).filter((p) =>
        icon.rule === 'white-alpha'
          ? p.a > 0
          : p.r > 240 && p.g > 240 && p.b > 240,
      );
      expect(mark.length, icon.path).toBeGreaterThan(0);
      for (const p of mark) {
        expect(
          Math.hypot(p.x + 0.5 - cx, p.y + 0.5 - cy),
          icon.path,
        ).toBeLessThanOrEqual(limit);
      }
    }
  });

  it('encodes an RGB PNG that round-trips through the header', () => {
    const png = encodePng(
      2,
      1,
      Uint8Array.from([255, 0, 0, 255, 0, 0, 255, 255]),
      false,
    );
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    );
    expect(png.readUInt32BE(16)).toBe(2);
    expect(png[25]).toBe(2);
    expect(() =>
      encodePng(1, 1, Uint8Array.from([0, 0, 0, 128]), false),
    ).toThrow(/opaque/);
  });
});

/**
 * PNG header plus decompressed pixel rows. Compressed bytes depend on Node's bundled zlib,
 * so comparing them would fail on a Node update with no icon change.
 */
const decoded = (png) => {
  if (png.length < 8) return null;
  const idat = [];
  let header = null;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('ascii', at + 4, at + 8);
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') header = Buffer.from(data);
    if (type === 'IDAT') idat.push(data);
    at += 12 + length;
  }
  return Buffer.concat([header, inflateSync(Buffer.concat(idat))]);
};
const samePixels = (a, b) => {
  const left = decoded(a);
  const right = decoded(b);
  return left !== null && right !== null && left.equals(right);
};

describe('committed icons', () => {
  const root = resolve(import.meta.dirname, '..');
  const committed = (path) => {
    try {
      return readFileSync(join(root, path));
    } catch {
      return Buffer.alloc(0);
    }
  };

  it('compares pixels, not zlib output', () => {
    const rgba = Uint8Array.from(
      { length: 64 * 64 * 4 },
      (_, i) => (i * 7) % 256,
    );
    const level9 = encodePng(64, 64, rgba, true);
    const raw = deflateSync(Buffer.from(decoded(level9).subarray(13)), {
      level: 1,
    });
    const level1 = Buffer.concat([
      level9.subarray(0, 33),
      (() => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(raw.length);
        const body = Buffer.concat([Buffer.from('IDAT'), raw]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(crc32(body));
        return Buffer.concat([len, body, crc]);
      })(),
      level9.subarray(level9.length - 12),
    ]);
    expect(level1.equals(level9)).toBe(false);
    expect(samePixels(level1, level9)).toBe(true);
  });

  it('match a fresh render', () => {
    const stale = OUTPUTS.filter((output) => {
      const fresh = readFileSync(join(out, output.path));
      const current = committed(output.path);
      // A copy is byte-for-byte its committed source, which is checked by pixels in turn.
      // Comparing it with the fresh render instead tied it to this platform's zlib output:
      // the same pixels encode to different bytes on macOS arm64 and Linux x64.
      return output.copyOf
        ? !current.equals(committed(output.copyOf))
        : !samePixels(fresh, current);
    }).map((output) => output.path);
    expect(stale, 'run `pnpm icons:generate` and commit the results').toEqual(
      [],
    );
  });

  it('include the current Icon Composer source', () => {
    for (const [path, text] of Object.entries(ICON_COMPOSER)) {
      expect(readFileSync(join(out, path), 'utf8'), path).toBe(text);
      expect(committed(path).toString(), path).toBe(text);
    }
  });
});

describe('Icon Composer source', () => {
  it('gives macOS a white mark on the blurple gradient and a blurple mark on the dark tile', () => {
    const icon = JSON.parse(
      ICON_COMPOSER['electron/build/Trinity.icon/icon.json'],
    );
    expect(icon['fill-specializations']).toEqual([
      {
        value: {
          'linear-gradient': [
            'srgb:0.43137,0.47451,0.96078,1.00000',
            'srgb:0.27843,0.32157,0.76863,1.00000',
          ],
        },
      },
      {
        appearance: 'dark',
        value: {
          'linear-gradient': [
            'srgb:0.11765,0.12157,0.13333,1.00000',
            'srgb:0.11765,0.12157,0.13333,1.00000',
          ],
        },
      },
    ]);
    expect(icon.groups[0].layers).toEqual([
      {
        'fill-specializations': [
          { value: { solid: 'srgb:1.00000,1.00000,1.00000,1.00000' } },
          {
            appearance: 'dark',
            value: { solid: 'srgb:0.53333,0.56863,0.96863,1.00000' },
          },
        ],
        glass: true,
        'image-name': 'Mark.svg',
        name: 'Mark',
      },
    ]);
    expect(icon['supported-platforms']).toEqual({ squares: ['macOS'] });
    const mark = ICON_COMPOSER['electron/build/Trinity.icon/Assets/Mark.svg'];
    expect(mark).toContain('#ffffff');
    expect(mark).not.toContain('#5865f2');
  });
});

describe('generator module', () => {
  it('can be imported without a script entry point', () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `const m = await import(${JSON.stringify(resolve(import.meta.dirname, 'generate-icons.mjs'))}); process.stdout.write(String(m.OUTPUTS.length));`,
      ],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(Number(result.stdout.trim())).toBeGreaterThan(0);
  });
});
