import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { createNodeAccount } from '../support/node-account.mts';
import { createNodeEncryptedRoom } from '../support/node-encrypted-room.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { openMaestroViewport } from './maestro-viewport.mts';
import { redactMaestroArtifacts } from './maestro-session.mts';
import {
  captureNativeShellProof,
  evaluateNative,
  navigateNativeShell,
  readNativeShellSurface,
  readNativeShellUiState,
  readNativeStatusBar,
  startNativeShellClient,
  waitForNativeShellState,
  type NativeShellApplicationId,
} from './native-shell-client.mts';

const applicationId: NativeShellApplicationId = 'eu.qwky.trinity';
const appPackage = 'eu.qwky.trinity';
const pattern = (text: string): string =>
  `(?s).*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*`;

void test(
  'Android native shell journeys',
  { timeout: 1_080_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot, 'dist/.playwright'),
          'native-shell',
        );
        await mkdir(output, { recursive: true });
        type StageEntry = {
          id: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          error?: string;
          artifact: string;
        };
        const stages: StageEntry[] = [];
        const stage = async (id: string, operation: () => Promise<void>): Promise<void> => {
          const entry: StageEntry = { id, status: 'running', durationMs: 0, artifact: `${id}*.json/png` };
          stages.push(entry);
          const started = performance.now();
          console.info(`[native-shell] ${id} start`);
          try {
            await operation();
            entry.status = 'passed';
          } catch (error) {
            entry.status = 'failed';
            entry.error =
              error instanceof Error ? `${error.name}: ${error.message}` : String(error);
            throw error;
          } finally {
            entry.durationMs = performance.now() - started;
            console.info(`[native-shell] ${id} end ${entry.status} ${entry.durationMs.toFixed(0)}ms`);
            await writeFile(join(output, 'journeys.json'), `${JSON.stringify({ stages }, null, 2)}\n`);
          }
        };

        const account = await createNodeAccount(matrixResources, signal, 'native-shell');
        const other = await createNodeAccount(matrixResources, signal, 'native-shell-peer');
        const room = await createNodeEncryptedRoom(matrixResources, [account, other], signal);
        const roomPath = `/rooms/${Buffer.from(room.id).toString('base64url')}`;
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Native shell Android device', () => device.close());
        let active: { pid: string; webview: Awaited<ReturnType<typeof startNativeShellClient>>['webview'] } | undefined;
        matrixResources.cleanup('Native shell WebView', async () => active?.webview.close());

        async function activate(): Promise<void> {
          await active?.webview.close();
          await device.adb('shell', 'am', 'force-stop', appPackage);
          active = await startNativeShellClient(device, applicationId, signal);
        }
        function current(): NonNullable<typeof active> {
          assert(active, 'Native shell WebView is active');
          return active;
        }
        async function flow(name: string, variables: Readonly<Record<string, string>> = {}): Promise<void> {
          await device.runFlow(join(session.workspaceRoot, `e2e/android/flows/${name}.yaml`), {
            APP_ID: applicationId,
            ...variables,
          });
        }
        async function roomsReady(): Promise<void> {
          await waitForNativeShellState(
            () => readNativeShellSurface(current().webview),
            (surface) => {
              const url = new URL(surface.url);
              return url.pathname.startsWith('/rooms') &&
                url.searchParams.get('account') === `@${account.username}:localhost` &&
                surface.body.includes('Recent activity');
            },
            'account-qualified Rooms surface',
            signal,
          );
          await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.roomsVisible, 'rendered Rooms surface', signal);
        }
        async function openRoom(): Promise<void> {
          if (!(await readNativeShellUiState(current().webview)).composerVisible) {
            await flow('native-shell-rooms');
            const roomNavigation = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.roomsRailCurrent === 'true', 'Rooms rail aria-current state', signal);
            await record(`rooms-navigation-${stages.at(-1)?.id}`, roomNavigation);
            await flow('critical-open-room', { ROOM_PATTERN: pattern(room.name) });
          }
          await waitForNativeShellState(
            () => readNativeShellSurface(current().webview),
            (surface) => new URL(surface.url).pathname === roomPath && surface.composer !== null,
            'native room composer',
            signal,
          );
          await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.composerVisible, 'visible room composer', signal);
        }
        async function capture(name: string): Promise<void> {
          await captureNativeShellProof(device, current().webview, output, name);
        }
        async function record(name: string, value: unknown): Promise<void> {
          await writeFile(join(output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
        }

        try {
          await device.install(join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'));
          assert.equal(await device.adb('shell', 'pm', 'clear', applicationId), 'Success');
          await device.adb('shell', 'pm', 'grant', applicationId, 'android.permission.POST_NOTIFICATIONS');
          await activate();

          await stage('unauthenticated-shell', async () => {
            const webview = current().webview;
            await waitForNativeShellState(
              () => readNativeShellSurface(webview),
              (surface) => new URL(surface.url).pathname === '/login',
              'visible native login shell',
              signal,
            );
            const login = await waitForNativeShellState(() => readNativeShellUiState(webview), (value) => value.homeserverVisible && value.continueVisible, 'visible Homeserver input and Continue button', signal);
            await record('unauthenticated-login-state', login);
            const navigated = await navigateNativeShell(webview, 'https://localhost/settings', signal);
            await record('unauthenticated-protected-navigation', navigated);
            await waitForNativeShellState(
              () => readNativeShellSurface(webview),
              (surface) => new URL(surface.url).pathname === '/login',
              'unauthenticated settings redirect to login',
              signal,
            );
            await waitForNativeShellState(() => readNativeShellUiState(webview), (value) => value.homeserverVisible && value.continueVisible, 'visible login controls after protected redirect', signal);
            await capture('unauthenticated-shell');
          });

          await stage('settings-touch-back', async () => {
            await flow('critical-login', { HOMESERVER: account.homeserver, USERNAME: account.username, PASSWORD: account.password });
            await roomsReady();
            await flow('native-shell-settings');
            const settings = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.settingsSectionsVisible && value.settingsHeadingVisible, 'visible Settings heading and sections', signal);
            await record('settings-touch-state', settings);
            await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => new URL(surface.url).pathname === '/settings' && surface.body.includes('Settings'),
              'native Settings surface',
              signal,
            );
            await flow('native-shell-back');
            await roomsReady();
            await capture('settings-touch-back');
          });

          await stage('authenticated-process-restart', async () => {
            const previousPid = current().pid;
            await activate();
            assert.notEqual(current().pid, previousPid, 'process restart creates a new native process');
            await roomsReady();
            await capture('authenticated-process-restart');
          });

          await stage('settings-section-back', async () => {
            await flow('native-shell-settings');
            const viewport = await openMaestroViewport(device, { pid: current().pid, width: 390, height: 844, signal });
            matrixResources.cleanup('Native settings viewport', () => viewport.close());
            let viewportFailure: unknown;
            try {
              await viewport.apply();
              const directory = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.appearanceLinkVisible && value.layoutViewport.width === 390 && value.layoutViewport.height === 844, '390 by 844 Settings directory', signal);
              await record('settings-section-directory-state', directory);
              assert(directory.appearanceLinkHeight >= 44, 'Appearance directory target is at least 44px');
              await flow('native-shell-appearance');
              const appearanceUi = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.appearanceHeadingFocused, 'named Appearance heading focused', signal);
              await record('settings-section-appearance-state', appearanceUi);
              assert(appearanceUi.appearanceHeadingFocused);
              const surface = await waitForNativeShellState(
                () => readNativeShellSurface(current().webview),
                (value) => new URL(value.url).pathname === '/settings/appearance' && value.activeElement === 'appearance-heading',
                'focused Appearance heading',
                signal,
              );
              await record('settings-section-viewport', surface);
              assert.deepEqual(appearanceUi.layoutViewport, { width: 390, height: 844 });
              await capture('settings-section');
              await viewport.apply();
              await flow('native-shell-back');
              await waitForNativeShellState(
                () => readNativeShellSurface(current().webview),
                (value) => new URL(value.url).pathname === '/settings' && value.activeElement === 'settings-nav-appearance',
                'focused Appearance directory link after Back',
                signal,
              );
              const restoredUi = await readNativeShellUiState(current().webview);
              await record('settings-section-restored-state', restoredUi);
              assert(restoredUi.settingsSectionsVisible && restoredUi.appearanceLinkFocused);
              const restoredGeometry = await evaluateNative(current().webview, `(() => ({ overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth }))()`);
              await record('settings-section-restored-geometry', restoredGeometry);
              assert(restoredGeometry && typeof restoredGeometry === 'object' && 'overflow' in restoredGeometry);
              assert((restoredGeometry.overflow as number) <= 1);
              await flow('native-shell-back');
              await roomsReady();
            } catch (error) {
              viewportFailure = error;
              throw error;
            } finally {
              try {
                await viewport.close();
              } catch (cleanupError) {
                if (viewportFailure !== undefined) throw new AggregateError([viewportFailure, cleanupError], 'Settings viewport assertion and cleanup failed');
                throw cleanupError;
              }
            }
          });

          await stage('composer-keyboard-insert-back', async () => {
            await openRoom();
            const before = (await readNativeShellSurface(current().webview)).visualViewport.height;
            await flow('native-shell-composer', { MESSAGE: 'trinity42' });
            const keyboard = await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => (surface.composer ?? '').includes('trinity42') && surface.visualViewport.height < before - 100,
              'native IME composer input',
              signal,
            );
            assert.match(keyboard.composer ?? '', /trinity42/i);
            await record('composer-native-keyboard-state', { fullViewportHeight: before, keyboard });
            await flow('native-shell-insert');
            const insertOpen = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.sheetVisible && value.insertExpanded === 'true', 'visible expanded insert sheet', signal);
            await record('composer-insert-open-state', insertOpen);
            const tray = await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => surface.visualViewport.height > before - 20,
              'restored viewport with insert tray',
              signal,
            );
            const boundedInsert = await readNativeShellUiState(current().webview);
            await record('composer-insert-restored-viewport', { tray, boundedInsert });
            assert(boundedInsert.sheetVisible && boundedInsert.sheetRect);
            assert(boundedInsert.sheetRect.y >= tray.visualViewport.offsetTop - 1, 'Insert sheet top is within the restored visual viewport');
            assert(boundedInsert.sheetRect.bottom <= tray.visualViewport.offsetTop + tray.visualViewport.height + 1, 'Insert sheet bottom is within the restored visual viewport');
            await flow('native-shell-back');
            const restored = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.sheetVisible && value.insertTriggerFocused && value.insertExpanded === 'false' && value.composerVisible, 'collapsed insert sheet after Back', signal);
            await record('composer-insert-restored-state', restored);
            assert(restored.composerVisible);
            await capture('composer-keyboard-insert-back');
          });

          await stage('members-back-order', async () => {
            await openRoom();
            assert(!(await readNativeShellUiState(current().webview)).membersVisible);
            const fullViewportHeight = (await readNativeShellSurface(current().webview)).visualViewport.height;
            await flow('native-shell-members');
            const memberKeyboard = await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => surface.activeElement === 'member-filter' && surface.visualViewport.height < fullViewportHeight - 100,
              'focused member filter with native IME',
              signal,
            );
            const memberOpen = await readNativeShellUiState(current().webview);
            await record('members-open-state', { fullViewportHeight, memberKeyboard, memberOpen });
            assert(memberOpen.membersVisible);
            await flow('native-shell-back');
            await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => surface.visualViewport.height > fullViewportHeight - 20 && new URL(surface.url).pathname === roomPath,
              'Members surface after IME Back',
              signal,
            );
            const memberImeDismissed = await readNativeShellUiState(current().webview);
            await record('members-ime-dismissed-state', memberImeDismissed);
            assert(memberImeDismissed.membersVisible);
            await flow('native-shell-back');
            const membersClosed = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.membersVisible && value.composerVisible, 'Members hidden with Conversation still visible', signal);
            await record('members-closed-state', membersClosed);
            assert(!membersClosed.membersVisible && membersClosed.composerVisible);
            await flow('native-shell-back');
            const directory = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.composerVisible && value.visibleRoomNames.some((name) => name.includes(room.name)), 'room row visible after Conversation Back', signal);
            await record('members-room-directory-state', directory);
            const rooms = await readNativeShellSurface(current().webview);
            await record('members-conversation-closed-surface', rooms);
            assert(new URL(rooms.url).pathname.startsWith('/rooms'));
            assert(!directory.composerVisible);
            assert((await readNativeShellUiState(current().webview)).roomsVisible);
            await capture('members-back-order');
          });

          await stage('composer-formatting', async () => {
            await openRoom();
            await flow('native-shell-composer', { MESSAGE: 'say hello' });
            // The predecessor fills an exact lowercase fixture. Android's IME
            // can capitalize its first word when Space commits it. Select that
            // initial character as fixture setup and replace it through native
            // input without another word commit; formatting itself stays native.
            const beforeNormalization = await readNativeShellSurface(current().webview);
            await evaluateNative(current().webview, `(() => { const input = document.querySelector('[data-testid="composer-input"]'); if (!(input instanceof HTMLTextAreaElement) || document.activeElement !== input) throw new Error('focused composer fixture missing'); input.setSelectionRange(0, 1); return { start: input.selectionStart, end: input.selectionEnd }; })()`);
            await flow('native-shell-lowercase-initial');
            const normalized = await waitForNativeShellState(() => readNativeShellSurface(current().webview), (value) => value.composer === 'say hello', 'exact lowercase formatting fixture', signal);
            await record('composer-format-input-fixture', { before: beforeNormalization, normalized });
            await evaluateNative(current().webview, `(() => { const input = document.querySelector('[data-testid="composer-input"]'); if (!(input instanceof HTMLTextAreaElement)) throw new Error('composer input missing'); input.focus(); input.setSelectionRange(4, 9); return { start: input.selectionStart, end: input.selectionEnd }; })()`);
            await writeFile(join(output, 'composer-selection-setup.json'), `${JSON.stringify({ start: 4, end: 9 }, null, 2)}\n`);
            await flow('native-shell-format-open');
            const menu = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.sheetVisible, 'visible composer format sheet', signal);
            await record('composer-format-menu-state', menu);
            assert(menu.sheetRect);
            const menuViewport = menu.layoutViewport;
            assert(menu.sheetRect.x >= 0 && menu.sheetRect.y >= 0);
            assert(menu.sheetRect.right <= menuViewport.width + 0.5 && menu.sheetRect.bottom <= menuViewport.height + 0.5);
            await flow('native-shell-format-italic');
            const formatted = await waitForNativeShellState(
              () => readNativeShellSurface(current().webview),
              (surface) => surface.composer === 'say *hello*' && surface.activeElement === 'composer-input',
              'native italic formatting and focus restoration',
              signal,
            );
            await record('composer-format-formatted-surface', formatted);
            assert.deepEqual(formatted.selection, { start: 5, end: 10 });
            await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.sheetVisible && value.composerVisible, 'format sheet hidden with composer visible', signal);
            const inputMethod = await waitForNativeShellState(() => device.adb('shell', 'dumpsys', 'input_method'), (value) => /mInputShown=true/.test(value), 'native IME restored after formatting', signal, 10_000);
            await record('composer-format-native-ime', { shown: /mInputShown=true/.test(inputMethod) });
            await capture('composer-formatting');
            await flow('native-shell-format-open');
            const secondMenu = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.sheetVisible && value.formatCancelVisible, 'second visible composer format sheet and Cancel', signal);
            await record('composer-format-cancel-open-state', secondMenu);
            const unchanged = (await readNativeShellSurface(current().webview)).composer;
            await flow('native-shell-back');
            const cancelled = await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.sheetVisible && value.formatCancelCount === 0, 'format sheet cancelled on Back', signal);
            await record('composer-format-cancelled-state', cancelled);
            assert(!cancelled.sheetVisible);
            assert.equal((await readNativeShellSurface(current().webview)).composer, unchanged);
          });

          await stage('native-appearance', async () => {
            if ((await readNativeShellUiState(current().webview)).composerVisible) {
              await flow('native-shell-back-to-rooms');
              await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => !value.composerVisible && value.visibleRoomNames.some((name) => name.includes(room.name)), 'room directory before Appearance', signal);
            }
            await flow('native-shell-settings');
            await flow('native-shell-appearance');
            await waitForNativeShellState(() => readNativeShellUiState(current().webview), (value) => value.appearanceHeadingFocused, 'Appearance heading focused before changing theme', signal);
            const platform = await evaluateNative(current().webview, `({ platform: window.Capacitor?.getPlatform?.(), coarsePointer: matchMedia('(pointer: coarse)').matches })`);
            assert.deepEqual(platform, { platform: 'android', coarsePointer: true });
            const selectIds = await evaluateNative(current().webview, `(() => {
              const id = testId => {
                const button = document.querySelector('[data-testid="' + testId + '"] button');
                if (!button?.id) throw new Error('Appearance select trigger has no native-accessible id: ' + testId);
                return button.id;
              };
              return { theme: id('theme-select'), density: id('density-select'), textScale: id('text-scale-select') };
            })()`);
            assert(selectIds && typeof selectIds === 'object' && 'theme' in selectIds && 'density' in selectIds && 'textScale' in selectIds);
            assert(typeof selectIds.theme === 'string' && typeof selectIds.density === 'string' && typeof selectIds.textScale === 'string');
            const selects = { THEME_TRIGGER_ID: selectIds.theme, DENSITY_TRIGGER_ID: selectIds.density, TEXT_SCALE_TRIGGER_ID: selectIds.textScale };
            await record('appearance-native-select-ids', selects);
            await flow('native-shell-appearance-light', selects);
            const lightState = await waitForNativeShellState(
              () => evaluateNative(current().webview, `({ lightChecked: document.querySelector('[data-testid="mode-light"] input')?.checked === true, dark: document.documentElement.classList.contains('dark'), theme: document.documentElement.getAttribute('data-theme'), preview: document.querySelector('[data-testid="appearance-preview-state"]')?.textContent?.trim() ?? '' })`),
              (value) => Boolean(value && typeof value === 'object' && 'lightChecked' in value && value.lightChecked === true && 'dark' in value && value.dark === false && 'theme' in value && value.theme === 'amethyst' && 'preview' in value && typeof value.preview === 'string' && value.preview.includes('light · Amethyst · Cosy')),
              'light Amethyst appearance projection', signal,
            );
            await record('appearance-light-state', lightState);
            assert.deepEqual(lightState, { lightChecked: true, dark: false, theme: 'amethyst', preview: 'light · Amethyst · Cosy' });
            const lightStatusBar = await waitForNativeShellState(
              () => readNativeStatusBar(current().webview),
              (value) => value.style === 'LIGHT',
              'light native StatusBar style',
              signal,
            );
            await record('appearance-light-status', lightStatusBar);
            assert.equal(lightStatusBar.style, 'LIGHT');
            assert(lightStatusBar.visible && lightStatusBar.height > 0);
            await capture('appearance-light');
            await flow('native-shell-appearance-dark', selects);
            const darkState = await waitForNativeShellState(
              () => evaluateNative(current().webview, `({ darkChecked: document.querySelector('[data-testid="mode-dark"] input')?.checked === true, dark: document.documentElement.classList.contains('dark'), theme: document.documentElement.getAttribute('data-theme'), density: document.documentElement.getAttribute('data-density'), fontSize: getComputedStyle(document.documentElement).fontSize, preview: document.querySelector('[data-testid="appearance-preview-state"]')?.textContent?.trim() ?? '' })`),
              (value) => Boolean(value && typeof value === 'object' && 'darkChecked' in value && value.darkChecked === true && 'dark' in value && value.dark === true && 'theme' in value && value.theme === 'onyx' && 'density' in value && value.density === 'compact' && 'fontSize' in value && value.fontSize === '20px' && 'preview' in value && typeof value.preview === 'string' && value.preview.includes('dark · Onyx · Compact')),
              'dark Onyx Compact Larger appearance projection', signal,
            );
            const darkStatusBar = await waitForNativeShellState(
              () => readNativeStatusBar(current().webview),
              (value) => value.style === 'DARK',
              'dark native StatusBar style',
              signal,
            );
            assert.equal(darkStatusBar.style, 'DARK');
            await record('appearance-dark-state', darkState);
            assert.deepEqual(darkState, { darkChecked: true, dark: true, theme: 'onyx', density: 'compact', fontSize: '20px', preview: 'dark · Onyx · Compact' });
            const geometry = await evaluateNative(current().webview, `(() => {
              const root = document.documentElement;
              const header = document.querySelector('header[data-trn-layout="page"]');
              const heading = header?.querySelector('h1');
              const selectors = ['[data-testid="mode-dark"]', '[data-testid="theme-select"] button', '[data-testid="density-select"] button', '[data-testid="text-scale-select"] button'];
              const controls = selectors.map(selector => document.querySelector(selector));
              if (!header || !heading || controls.some(control => !control)) throw new Error('Android Appearance geometry is incomplete');
              return { fontSize: getComputedStyle(root).fontSize, minimumTarget: Math.min(...controls.map(control => control.getBoundingClientRect().height)), overflow: root.scrollWidth - root.clientWidth, headerPaddingTop: parseFloat(getComputedStyle(header).paddingTop), headingTop: heading.getBoundingClientRect().top, hostInset: Math.max(0, screen.height - innerHeight) };
            })()`);
            await record('appearance-dark-geometry', geometry);
            assert(geometry && typeof geometry === 'object');
            assert.equal((geometry as Record<string, unknown>).fontSize, '20px');
            assert((geometry as Record<string, unknown>).minimumTarget as number >= 44);
            assert((geometry as Record<string, unknown>).overflow as number <= 1);
            const measured = geometry as Record<string, unknown>;
            assert((measured.hostInset as number) + (measured.headerPaddingTop as number) >= darkStatusBar.height - 1);
            assert((measured.headingTop as number) >= (measured.headerPaddingTop as number) - 1);
            await flow('native-shell-open-theme', selects);
            const onyx = await waitForNativeShellState(
              () => evaluateNative(current().webview, `(() => { const option = document.querySelector('[data-testid="theme-onyx"]'); return !!option && getComputedStyle(option).display !== 'none' && getComputedStyle(option).visibility !== 'hidden'; })()`),
              Boolean,
              'visible Onyx theme chooser option',
              signal,
            );
            assert.equal(onyx, true);
            await capture('appearance-dark-compact');
            await writeFile(join(output, 'appearance-runtime.json'), `${JSON.stringify({ lightStatusBar, darkStatusBar, geometry }, null, 2)}\n`);
          });
        } finally {
          await capture('final-surface').catch((error: unknown) => writeFile(join(output, 'surface-unavailable.txt'), String(error)));
          await writeFile(join(output, 'webview-version.txt'), await device.adb('shell', 'dumpsys', 'webviewupdate').catch(String));
          await redactMaestroArtifacts(output, { PASSWORD: account.password });
        }
      },
    );
  },
);
