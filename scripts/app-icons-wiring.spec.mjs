/** Each platform references the generated icons it needs. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

const root = resolve(import.meta.dirname, '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const RES = 'android/app/src/main/res';

describe('icon wiring', () => {
  it('lists PNG any, maskable and monochrome icons in the PWA manifest', () => {
    const icons = JSON.parse(
      read('apps/trinity/src/manifest.webmanifest'),
    ).icons;
    expect(icons.map(({ sizes, purpose }) => `${sizes} ${purpose}`)).toEqual([
      '192x192 any',
      '512x512 any',
      '192x192 maskable',
      '512x512 maskable',
      '512x512 monochrome',
    ]);
    for (const icon of icons) {
      expect(icon.type).toBe('image/png');
      expect(
        existsSync(join(root, 'apps/trinity/src', icon.src)),
        icon.src,
      ).toBe(true);
    }
  });

  it('serves an SVG favicon before the PNG fallback', () => {
    const html = read('apps/trinity/src/index.html');
    expect(html.indexOf('assets/icon/favicon.svg')).toBeGreaterThan(-1);
    expect(html.indexOf('assets/icon/favicon.svg')).toBeLessThan(
      html.indexOf('assets/icon/favicon.png'),
    );
  });

  it('gives Android a themed layer, brand background and notification icon', () => {
    for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      expect(read(`${RES}/mipmap-anydpi-v26/${file}`)).toContain(
        '<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>',
      );
    }
    expect(read(`${RES}/values/ic_launcher_background.xml`)).toContain(
      '#5865F2',
    );
    for (const file of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
      expect(read(`${RES}/mipmap-anydpi-v26/${file}`)).toContain(
        '<background android:drawable="@mipmap/ic_launcher_background"/>',
      );
    }
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain(
      'com.google.firebase.messaging.default_notification_icon',
    );
    expect(manifest).toContain('@drawable/ic_stat_trinity');
    expect(manifest).toContain(
      'com.google.firebase.messaging.default_notification_color',
    );
    expect(read('capacitor.config.ts')).toMatch(
      /LocalNotifications:\s*{[^}]*smallIcon:\s*'ic_stat_trinity'/,
    );
    const styles = read(`${RES}/values/styles.xml`);
    expect(styles).toContain(
      '<item name="windowSplashScreenBackground">@android:color/white</item>',
    );
    expect(styles).toContain(
      '<item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>',
    );
  });

  it('declares iOS light, dark and tinted app icons that exist', () => {
    const dir = 'ios/App/App/Assets.xcassets/AppIcon.appiconset';
    const images = JSON.parse(read(`${dir}/Contents.json`)).images;
    expect(images.map((i) => i.appearances?.[0]?.value ?? 'light')).toEqual([
      'light',
      'dark',
      'tinted',
    ]);
    for (const image of images) {
      expect(image.size).toBe('1024x1024');
      expect(existsSync(join(root, dir, image.filename)), image.filename).toBe(
        true,
      );
    }
  });
});

describe('desktop icon wiring', () => {
  it('takes window and tray icons from the tested icon helpers and the dedicated notification icon', () => {
    expect(read('electron/src/window.ts')).toContain(
      '...windowIconOptions(process.platform)',
    );
    expect(read('electron/src/tray.ts')).toContain(
      'trayIconFile(process.platform)',
    );
    expect(read('electron/src/notifications.ts')).toContain(
      "iconCandidatePaths('notificationIcon.png')",
    );
  });

  it('gives macOS its Apple-grid icon and everything else the full-bleed one', () => {
    const config = read('electron/electron-builder.yml');
    // Icon Composer: macOS 26 themes it (Default, Dark, Clear, Tinted); electron-builder
    // compiles it with Xcode 26's actool and derives the legacy .icns from it.
    expect(config).toMatch(/^mac:\n(?:  .*\n)*?  icon: build\/Trinity\.icon$/m);
    expect(
      existsSync(join(root, 'electron/build/Trinity.icon/icon.json')),
    ).toBe(true);
    // The job that packs the macOS app runs actool, so it needs Xcode 26.
    const { jobs } = parse(read('.github/workflows/release.yml'));
    const packing = Object.values(jobs).filter((job) =>
      job.steps?.some((step) =>
        /electron-builder --mac\b/.test(step.run ?? ''),
      ),
    );
    expect(packing.length).toBeGreaterThan(0);
    for (const job of packing) expect(job['runs-on']).toBe('macos-26');
  });

  it('ships every runtime icon through extraResources', () => {
    const config = read('electron/electron-builder.yml');
    for (const file of [
      'icon.png',
      'trinityTray.png',
      'trinityTray@2x.png',
      'trinityTrayLinux.png',
      'trinityTrayLinux@2x.png',
      'trinityTrayTemplate.png',
      'trinityTrayTemplate@2x.png',
      'notificationIcon.png',
      'unreadOverlay.png',
    ]) {
      expect(config, file).toContain(`from: build/${file}`);
      expect(existsSync(join(root, 'electron/build', file)), file).toBe(true);
    }
  });
});
