/** Every generated icon has the exact size and the pixel rule its platform requires. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodePng, OUTPUTS, renderIcons } from './generate-icons.mjs';

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
    expect(byRule('white-alpha').length).toBeGreaterThanOrEqual(11);
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
    expect(safe.length).toBeGreaterThanOrEqual(12);
    for (const icon of safe) {
      const cx = icon.width / 2;
      const cy = icon.height / 2;
      const limit = icon.safeRadius * icon.width;
      const mark = pixels(icon).filter((p) =>
        icon.rule === 'white-alpha' || icon.rule === 'mark-on-transparent'
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
      return output.copyOf
        ? !fresh.equals(current)
        : !samePixels(fresh, current);
    }).map((output) => output.path);
    expect(stale, 'run `pnpm icons:generate` and commit the results').toEqual(
      [],
    );
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
