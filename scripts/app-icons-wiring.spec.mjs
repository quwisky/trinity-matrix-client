/** Each platform references the generated icons it needs. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

  it('ships iOS alternate icons the build includes and the plugin can name', () => {
    const catalog = 'ios/App/App/Assets.xcassets';
    for (const set of ['AppIconBlurple', 'AppIconDark']) {
      const images = JSON.parse(
        read(`${catalog}/${set}.appiconset/Contents.json`),
      ).images;
      expect(images).toEqual([
        {
          filename: 'AppIcon.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
      ]);
      expect(
        existsSync(join(root, catalog, `${set}.appiconset/AppIcon.png`)),
      ).toBe(true);
    }
    const project = read('ios/App/App.xcodeproj/project.pbxproj');
    expect(
      project.match(
        /ASSETCATALOG_COMPILER_ALTERNATE_APPICON_NAMES = "AppIconBlurple AppIconDark";/g,
      ),
    ).toHaveLength(2);
    expect(
      project.match(/ASSETCATALOG_COMPILER_INCLUDE_ALL_APPICON_ASSETS = YES;/g),
    ).toHaveLength(2);
    const swift = read('ios/App/App/MainViewController.swift');
    expect(swift).toContain('bridge?.registerPluginInstance(AppIconPlugin())');
    expect(swift).toContain('let jsName = "AppIcon"');
  });

  it('gives Android a blurple and a dark launcher alias with exactly one enabled', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    const main = manifest.match(/<activity\b[\s\S]*?<\/activity>/)[0];
    expect(main).toContain('android:name=".MainActivity"');
    expect(main).toContain('android:exported="true"');
    expect(main).not.toContain('android.intent.category.LAUNCHER');
    expect(main).toContain('android:scheme="eu.qwky.trinity"');
    const aliases = [
      ...manifest.matchAll(/<activity-alias\b[\s\S]*?<\/activity-alias>/g),
    ].map((m) => m[0]);
    expect(aliases).toHaveLength(2);
    const [blurple, dark] = aliases;
    expect(blurple).toContain('android:name=".LauncherBlurple"');
    expect(blurple).toContain('android:enabled="true"');
    expect(blurple).toContain('android:icon="@mipmap/ic_launcher"');
    expect(dark).toContain('android:name=".LauncherDark"');
    expect(dark).toContain('android:enabled="false"');
    expect(dark).toContain('android:icon="@mipmap/ic_launcher_dark"');
    expect(dark).toContain(
      'android:roundIcon="@mipmap/ic_launcher_dark_round"',
    );
    for (const alias of aliases) {
      expect(alias).toContain('android:targetActivity=".MainActivity"');
      expect(alias).toContain('android.intent.category.LAUNCHER');
    }
    for (const file of ['ic_launcher_dark.xml', 'ic_launcher_dark_round.xml']) {
      const xml = read(`${RES}/mipmap-anydpi-v26/${file}`);
      expect(xml).toContain(
        '<background android:drawable="@mipmap/ic_launcher_dark_background"/>',
      );
      expect(xml).toContain(
        '<foreground android:drawable="@mipmap/ic_launcher_dark_foreground"/>',
      );
      expect(xml).toContain(
        '<monochrome android:drawable="@mipmap/ic_launcher_monochrome"/>',
      );
    }
    const plugin = read(
      'android/app/src/main/java/eu/qwky/trinity/AppIconPlugin.java',
    );
    expect(plugin).toContain('@CapacitorPlugin(name = "AppIcon")');
    // Enable before disable, so Trinity never has zero launcher entries.
    expect(plugin.indexOf('COMPONENT_ENABLED_STATE_ENABLED,')).toBeLessThan(
      plugin.indexOf('COMPONENT_ENABLED_STATE_DISABLED,'),
    );
    expect(
      read('android/app/src/main/java/eu/qwky/trinity/MainActivity.java'),
    ).toContain('registerPlugin(AppIconPlugin.class);');
  });
});

describe('desktop icon wiring', () => {
  it('takes window and tray icons from the tested icon helpers and the dedicated notification icon', () => {
    expect(read('electron/src/window.ts')).toContain(
      '...windowIconOptions(process.platform, storedAppIcon())',
    );
    expect(read('electron/src/tray.ts')).toContain(
      'trayIconFile(process.platform, icon)',
    );
    expect(read('electron/src/notifications.ts')).toContain(
      "iconCandidatePaths('notificationIcon.png')",
    );
  });

  it('gives macOS its Apple-grid icon and everything else the full-bleed one', () => {
    const config = read('electron/electron-builder.yml');
    expect(config).toMatch(/^mac:\n(?:  .*\n)*?  icon: build\/icon-mac\.png$/m);
    expect(existsSync(join(root, 'electron/build/icon-mac.png'))).toBe(true);
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
      'icon-dark.png',
      'icon-mac-dark.png',
      'trinityTray-dark.png',
      'trinityTray-dark@2x.png',
      'trinityTrayLinux-dark.png',
      'trinityTrayLinux-dark@2x.png',
    ]) {
      expect(config, file).toContain(`from: build/${file}`);
      expect(existsSync(join(root, 'electron/build', file)), file).toBe(true);
    }
  });
});
