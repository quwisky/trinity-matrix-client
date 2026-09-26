import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  installFirstMatrixHttpFailure,
  type MatrixHttpFault,
} from './matrix-http-fault.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import {
  ROOM_WIDGET_SOURCES,
  roomWidgetAssertions as assertions,
  type RoomWidgetAssertion,
} from './room-widget-contract.mts';
import {
  installRoomWidgetFixture,
  type RoomWidgetFixture,
} from './room-widget-fixture.mts';
import { withSpaceSettingsVisualFixture } from './space-settings-visual-fixture.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;

async function observedValue<T>(
  client: AccountWorkspaceClient,
  identity: RoomWidgetAssertion,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  let observation: T | null = null;
  let value: T;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await read();
        observation = latest;
        return latest;
      },
      accepts,
      identity,
      client.signal,
      timeoutMs,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(identity, {
        assertion: identity,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(failures, `${identity}: ${describeFailure(error)}`);
  }
  await client.record(identity, { assertion: identity, observation: value });
  return value;
}

function observedElements(
  client: AccountWorkspaceClient,
  identity: RoomWidgetAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  return observedValue(
    client,
    identity,
    () => client.elements(selector, filter),
    accepts,
    timeoutMs,
  );
}

async function observedNative<T>(
  client: AccountWorkspaceClient,
  identity: RoomWidgetAssertion,
  expression: string,
  accepts: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  return observedValue(
    client,
    identity,
    () => evaluateNative(client.webview, expression) as Promise<T>,
    accepts,
    timeoutMs,
  );
}

async function recordAssertion<T>(
  client: AccountWorkspaceClient,
  identity: RoomWidgetAssertion,
  observation: T,
  accepts: (value: T) => boolean,
): Promise<void> {
  assert(accepts(observation), `${identity}: pinned assertion is satisfied`);
  await client.record(identity, { assertion: identity, observation });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  identity: RoomWidgetAssertion,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observedElements(
    client,
    identity,
    '[data-testid="composer-input"]',
    visibleOne,
  );
}

async function openWidgetSettings(
  client: AccountWorkspaceClient,
  identity: RoomWidgetAssertion,
  mobile = false,
): Promise<void> {
  if (mobile) {
    await client.tapCurrent('[data-testid="room-actions-overflow"]');
    await client.tapCurrent('[data-testid="overflow-open-room-settings"]');
  } else {
    await client.tapCurrent('[data-testid="open-room-settings"]');
  }
  await client.visible('[data-testid="room-settings"]', {}, 30_000);
  const tabSelector = '[data-testid="room-settings-tab-widgets"]';
  const tab = await client.elements(tabSelector);
  if (!visibleOne(tab)) {
    await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
  }
  await client.tapCurrent(tabSelector);
  await observedElements(
    client,
    identity,
    '[data-testid="room-settings-panel-widgets"]',
    visibleOne,
  );
}

interface RequestProbe {
  readonly count: number;
  close(): Promise<void>;
}

async function installNoEagerWidgetProbe(
  connection: DevtoolsEventConnection,
): Promise<RequestProbe> {
  let count = 0;
  let closed = false;
  const unsubscribe = connection.on('Network.requestWillBeSent', (value) => {
    const request = value['request'];
    const url =
      request && typeof request === 'object'
        ? (request as { readonly url?: unknown }).url
        : undefined;
    if (
      typeof url === 'string' &&
      url.startsWith('https://widgets.example/')
    ) {
      count += 1;
    }
  });
  await connection.send('Network.enable');
  await connection.send('Network.setBlockedURLs', {
    urls: ['https://widgets.example/*'],
  });
  return {
    get count() {
      return count;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribe();
      const failures: unknown[] = [];
      try {
        await connection.send('Network.setBlockedURLs', { urls: [] });
      } catch (error) {
        failures.push(error);
      }
      try {
        await connection.send('Network.disable');
      } catch (error) {
        failures.push(error);
      }
      if (failures.length) {
        throw new AggregateError(failures, 'Widget request probe cleanup failed');
      }
    },
  };
}

interface FrameTreeNode {
  readonly frame?: { readonly id?: unknown; readonly url?: unknown };
  readonly childFrames?: readonly FrameTreeNode[];
}

function frameEntries(value: unknown): readonly { id: string; url: string }[] {
  if (!value || typeof value !== 'object') return [];
  const tree = (value as { readonly frameTree?: unknown }).frameTree;
  const entries: { id: string; url: string }[] = [];
  const visit = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== 'object') return;
    const node = candidate as FrameTreeNode;
    if (
      node.frame &&
      typeof node.frame.id === 'string' &&
      typeof node.frame.url === 'string'
    ) {
      entries.push({ id: node.frame.id, url: node.frame.url });
    }
    for (const child of node.childFrames ?? []) visit(child);
  };
  visit(tree);
  return entries;
}

async function frameIdForUrl(
  connection: DevtoolsEventConnection,
  url: string,
  signal: AbortSignal,
): Promise<string> {
  const entry = await waitForNativeShellState(
    async () =>
      frameEntries(await connection.send('Page.getFrameTree')).find(
        (candidate) => candidate.url === url,
      ),
    (candidate) => candidate !== undefined,
    // Widget URLs carry the Room id, which never reaches the job log.
    'CDP frame for the exact widget URL',
    signal,
    15_000,
  );
  assert(entry, 'CDP frame exists for the exact widget URL');
  return entry.id;
}

async function evaluateFrame<T>(
  connection: DevtoolsEventConnection,
  url: string,
  expression: string,
  signal: AbortSignal,
): Promise<T> {
  const frameId = await frameIdForUrl(connection, url, signal);
  const world = (await connection.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'trinity-room-widget-probe',
  })) as { readonly executionContextId?: unknown };
  assert(
    typeof world.executionContextId === 'number',
    'CDP isolated world exists for the exact widget URL',
  );
  const response = (await connection.send('Runtime.evaluate', {
    expression,
    contextId: world.executionContextId,
    returnByValue: true,
    awaitPromise: true,
  })) as {
    readonly exceptionDetails?: unknown;
    readonly result?: { readonly value?: unknown };
  };
  assert.equal(
    response.exceptionDetails,
    undefined,
    'CDP frame expression succeeds for the exact widget URL',
  );
  return response.result?.value as T;
}

async function readWidgetRequest(
  connection: DevtoolsEventConnection,
  widgetUrl: string,
  signal: AbortSignal,
): Promise<Readonly<Record<string, unknown>>> {
  const text = await waitForNativeShellState(
    () =>
      evaluateFrame<string>(
        connection,
        widgetUrl,
        "document.querySelector('#request')?.textContent ?? ''",
        signal,
      ),
    (value) => value.length > 0,
    'Widget API capability request',
    signal,
    15_000,
  );
  const value: unknown = JSON.parse(text);
  assert(value && typeof value === 'object', 'Widget capability request is an object');
  return value as Readonly<Record<string, unknown>>;
}

async function runBridgeAdversary(
  client: AccountWorkspaceClient,
  connection: DevtoolsEventConnection,
  mode: 'sibling' | 'changed-origin',
  request: Readonly<Record<string, unknown>>,
): Promise<void> {
  const targetOrigin = new URL((await client.surface()).url).origin;
  if (mode === 'sibling') {
    await evaluateNative(
      client.webview,
      `(() => { const attacker=document.createElement('iframe'); attacker.dataset.widgetAttacker='source'; attacker.src='https://widgets.example/attacker'; document.body.append(attacker); return true; })()`,
    );
    await evaluateFrame(
      connection,
      'https://widgets.example/attacker',
      `parent.postMessage({...${JSON.stringify(request)},response:{capabilities:[]}},${JSON.stringify(targetOrigin)})`,
      client.signal,
    );
    await delay(100, undefined, { signal: client.signal });
    await evaluateNative(
      client.webview,
      `(() => { document.querySelector('iframe[data-widget-attacker="source"]')?.remove(); return true; })()`,
    );
    return;
  }
  await evaluateNative(
    client.webview,
    `(() => { const widgetFrame=document.querySelector('iframe.widget-frame__iframe'); if(!(widgetFrame instanceof HTMLIFrameElement))throw new Error('Widget frame missing'); widgetFrame.src='https://attacker.example/origin-change'; return true; })()`,
  );
  await evaluateFrame(
    connection,
    'https://attacker.example/origin-change',
    `parent.postMessage({...${JSON.stringify(request)},response:{capabilities:[]}},${JSON.stringify(targetOrigin)})`,
    client.signal,
  );
  await delay(100, undefined, { signal: client.signal });
}

async function invokeAccountContinuityHandlers(
  client: AccountWorkspaceClient,
  target: NodeWorkspaceAccount,
): Promise<void> {
  await evaluateNative(
    client.webview,
    `(() => { const trigger=document.querySelector('[data-testid="user-menu-trigger"]'); if(!(trigger instanceof HTMLElement))throw new Error('Account menu trigger missing'); trigger.click(); return true; })()`,
  );
  await client.visible('[data-testid="account-row"]', { text: target.userId });
  await evaluateNative(
    client.webview,
    `(() => { const target=${JSON.stringify(target.userId)}; const rows=[...document.querySelectorAll('[data-testid="account-row"]')]; const row=rows.find(candidate=>(candidate.textContent??'').includes(target)); if(!(row instanceof HTMLElement))throw new Error('Target Account row missing'); row.click(); return true; })()`,
  );
}

async function observeMixedContentBlock(
  client: AccountWorkspaceClient,
  connection: DevtoolsEventConnection,
): Promise<{ readonly violation: string; readonly blockedRequests: number }> {
  const blockedUrl = 'http://blocked-widget.test/frame';
  let violation = '';
  let blockedRequests = 0;
  const readText = (value: Readonly<Record<string, unknown>>): string => {
    const entry = value['entry'];
    if (entry && typeof entry === 'object') {
      const text = (entry as { readonly text?: unknown }).text;
      if (typeof text === 'string') return text;
    }
    const args = value['args'];
    return Array.isArray(args)
      ? args
          .map((argument) =>
            argument && typeof argument === 'object'
              ? String(
                  (argument as { readonly value?: unknown }).value ?? '',
                )
              : '',
          )
          .join(' ')
      : '';
  };
  const observeViolation = (value: Readonly<Record<string, unknown>>): void => {
    const text = readText(value);
    if (text.includes('frame-src') && text.includes('blocked-widget.test')) {
      violation = text;
    }
  };
  const logUnsubscribe = connection.on('Log.entryAdded', observeViolation);
  const consoleUnsubscribe = connection.on(
    'Runtime.consoleAPICalled',
    observeViolation,
  );
  const networkUnsubscribe = connection.on(
    'Network.requestWillBeSent',
    (value) => {
      const request = value['request'];
      const url =
        request && typeof request === 'object'
          ? (request as { readonly url?: unknown }).url
          : undefined;
      if (url === blockedUrl) blockedRequests += 1;
    },
  );
  await connection.send('Log.enable');
  await connection.send('Runtime.enable');
  await connection.send('Network.enable');
  try {
    await evaluateNative(
      client.webview,
      `(() => { const blocked=document.createElement('iframe'); blocked.dataset.widgetBlocked='mixed-content'; blocked.src=${JSON.stringify(blockedUrl)}; document.body.append(blocked); return true; })()`,
    );
    await waitForNativeShellState(
      async () => ({ violation, blockedRequests }),
      (value) => value.violation.length > 0,
      'widget mixed-content frame CSP violation',
      client.signal,
      15_000,
    );
    return { violation, blockedRequests };
  } finally {
    logUnsubscribe();
    consoleUnsubscribe();
    networkUnsubscribe();
    await evaluateNative(
      client.webview,
      `(() => { document.querySelector('iframe[data-widget-blocked="mixed-content"]')?.remove(); return true; })()`,
    );
    await connection.send('Log.disable');
    await connection.send('Network.disable');
  }
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'mobile-layout',
    source: ROOM_WIDGET_SOURCES.mobile,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('widget-mobile-owner');
      const widgetCount = 8;
      const longWidgetName = `Planning-${'continuity-'.repeat(18)}board`;
      const longWidgetUrl =
        `https://widgets.example/${'long-segment-'.repeat(18)}` +
        '?room=$matrix_room_id';
      const room = await fixtures.createRoom(owner, {
        name: `Many widgets ${resources.roomName('widget-mobile')}`,
        preset: 'private_chat',
        initial_state: Array.from({ length: widgetCount }, (_, index) => ({
          type: 'im.vector.modular.widgets' as const,
          state_key: `board-${index}`,
          content: {
            name:
              index === widgetCount - 1
                ? longWidgetName
                : `Planning board ${index + 1}`,
            type: 'm.custom',
            url:
              index === widgetCount - 1
                ? longWidgetUrl
                : `https://widgets.example/board/${index}`,
          },
        })),
      });

      await client.login(owner);
      await openRoom(
        client,
        room.name,
        assertions.mobileRoomTimelineVisible,
      );
      await openWidgetSettings(
        client,
        assertions.mobileWidgetsTabVisible,
        true,
      );

      const connection = await client.webview.openSession();
      let widgetFixture: RoomWidgetFixture | undefined;
      const cleanup = async (): Promise<void> => {
        const failures: unknown[] = [];
        try {
          await widgetFixture?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(failures, 'Mobile widget fixture cleanup failed');
        }
      };
      resources.cleanup('Mobile widget fixture', cleanup);
      try {
        widgetFixture = await installRoomWidgetFixture(connection);
        const draftName = 'Mobile board';
        const draftUrl =
          'https://widgets.example/mobile?room=$matrix_room_id';
        await client.fill('[data-testid="room-widget-create-name"]', draftName);
        await client.fill('[data-testid="room-widget-create-url"]', draftUrl);
        await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
        const discard = await observedElements(
          client,
          assertions.mobileDiscardCopy,
          'trn-alert-dialog',
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.text.includes('unsaved Room details'),
        );
        assert(discard[0]!.text.includes('unsaved Room details'));
        await client.tapCurrent('[data-testid="alert-cancel"]');
        await client.expectCount('trn-alert-dialog', 0);
        await observedElements(
          client,
          assertions.mobileDraftNameRetained,
          '[data-testid="room-widget-create-name"]',
          (elements) => visibleOne(elements) && elements[0]!.value === draftName,
        );
        await observedElements(
          client,
          assertions.mobileDraftUrlRetained,
          '[data-testid="room-widget-create-url"]',
          (elements) => visibleOne(elements) && elements[0]!.value === draftUrl,
        );
        await client.tapCurrent('[data-testid="room-widget-create-url"]');
        await client.focused('[data-testid="room-widget-create-url"]');
        await client.key('enter');
        await observedElements(
          client,
          assertions.mobileCreatedWidgetVisible,
          'article.room-widgets__widget',
          (elements) => elements.length === 1 && elements[0]!.visible,
          { text: draftName },
        );
        await client.hideKeyboard();
        await recordAssertion(
          client,
          assertions.mobileNoEagerRequestAfterCreate,
          widgetFixture.requestCount,
          (count) => count === 0,
        );
        await observedElements(
          client,
          assertions.mobileScrollRegionOverflows,
          '.room-settings__section-scroll',
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.scrollHeight > elements[0]!.clientHeight,
        );
        await observedElements(
          client,
          assertions.mobileSeededCardCount,
          '[data-testid^="room-widget-board-"]',
          (elements) => elements.length === widgetCount,
        );
        const seededLabels = await Promise.all(
          Array.from({ length: widgetCount }, async (_, index) => {
            const card = await client.visible(
              `[data-testid="room-widget-board-${index}"]`,
            );
            return card.text;
          }),
        );
        await recordAssertion(
          client,
          assertions.mobileSeededCardLabels,
          seededLabels,
          (labels) =>
            labels.length === widgetCount &&
            labels.every((label, index) =>
              label.includes(
                index === widgetCount - 1
                  ? longWidgetName
                  : `Planning board ${index + 1}`,
              ),
            ),
        );

        const lastCard = `[data-testid="room-widget-board-${widgetCount - 1}"]`;
        await client.scrollIntoViewIfNeeded(
          lastCard,
          '.room-settings__section-scroll',
        );
        await observedElements(
          client,
          assertions.mobileLastCardVisible,
          lastCard,
          visibleOne,
        );
        await observedElements(
          client,
          assertions.mobileLongUrlVisible,
          lastCard,
          (elements) => visibleOne(elements) && elements[0]!.text.includes(longWidgetUrl),
        );
        await observedNative<boolean>(
          client,
          assertions.mobileHorizontalContainment,
          `(() => { const element=document.querySelector('[data-testid="room-settings"]'); return element instanceof HTMLElement && element.scrollWidth <= element.clientWidth + 1; })()`,
          (value) => value,
        );
        const trialOpen =
          `[data-testid="room-widget-open-board-${widgetCount - 1}"]`;
        await client.scrollIntoViewIfNeeded(
          trialOpen,
          '.room-settings__section-scroll',
        );
        await observedElements(
          client,
          assertions.mobileNoEagerRequestBeforeEmbed,
          trialOpen,
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.unobstructedCenter &&
            widgetFixture!.requestCount === 0,
        );
        await client.tapCurrent(
          `[data-testid="room-widget-embed-board-${widgetCount - 1}"]`,
        );
        await observedElements(
          client,
          assertions.mobileWidgetApiReady,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Widget API ready'),
        );
        const frameGeometry = `(() => { const frame=document.querySelector('iframe.widget-frame__iframe'), viewport=window.visualViewport; if(!(frame instanceof HTMLIFrameElement))return null; const rect=frame.getBoundingClientRect(); return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,bottom:rect.bottom,viewportWidth:innerWidth,viewportTop:viewport?.offsetTop??0,viewportHeight:viewport?.height??innerHeight}; })()`;
        await observedNative<Record<string, number> | null>(
          client,
          assertions.mobileFrameBoxPresent,
          frameGeometry,
          (value) => value !== null,
        );
        await observedNative<Record<string, number> | null>(
          client,
          assertions.mobileFrameWidth,
          frameGeometry,
          (value) =>
            value !== null && value.width >= value.viewportWidth - 1,
        );
        await observedNative<Record<string, number> | null>(
          client,
          assertions.mobileFrameTopContained,
          frameGeometry,
          (value) => value !== null && value.y >= value.viewportTop - 1,
        );
        await observedNative<Record<string, number> | null>(
          client,
          assertions.mobileFrameBottomContained,
          frameGeometry,
          (value) =>
            value !== null &&
            value.bottom <= value.viewportTop + value.viewportHeight + 1,
        );
        await client.tapCurrent('[data-testid="room-widget-frame-close"]');
        await observedElements(
          client,
          assertions.mobileFrameClosed,
          'iframe.widget-frame__iframe',
          (elements) => elements.length === 0,
        );
        const cancel = await observedElements(
          client,
          assertions.mobileCancelBoxPresent,
          '[data-testid="room-settings-cancel"]',
          visibleOne,
        );
        await recordAssertion(
          client,
          assertions.mobileCancelBottomContained,
          { bottom: cancel[0]!.rect.bottom, viewport: PIXEL_5_ACCOUNT_PROFILE.height },
          (value) => value.bottom <= value.viewport,
        );

        const themeObservations: Array<{
          readonly theme: string | null;
          readonly dark: boolean;
          readonly cancelVisible: boolean;
          readonly openVisible: boolean;
        }> = [];
        for (const theme of [null, 'amethyst', 'onyx'] as const) {
          for (const dark of [false, true]) {
            await withSpaceSettingsVisualFixture(
              client,
              { theme, dark },
              async () => {
                const currentCancel = await client.elements(
                  '[data-testid="room-settings-cancel"]',
                );
                const open = await client.elements(
                  `[data-testid="room-widget-open-board-${widgetCount - 1}"]`,
                );
                themeObservations.push({
                  theme,
                  dark,
                  cancelVisible: visibleOne(currentCancel),
                  openVisible: visibleOne(open),
                });
                await client.capture(
                  `theme-${theme ?? 'default'}-${dark ? 'dark' : 'light'}`,
                );
              },
            );
          }
        }
        await recordAssertion(
          client,
          assertions.mobileThemeCancelVisible,
          themeObservations,
          (values) => values.length === 6 && values.every((value) => value.cancelVisible),
        );
        await recordAssertion(
          client,
          assertions.mobileThemeOpenVisible,
          themeObservations,
          (values) => values.length === 6 && values.every((value) => value.openVisible),
        );
        await withSpaceSettingsVisualFixture(
          client,
          { fontSize: '125%' },
          async () => {
            await client.scrollIntoViewIfNeeded(
              lastCard,
              '.room-settings__section-scroll',
            );
            await observedElements(
              client,
              assertions.mobileScaledLastCardVisible,
              lastCard,
              visibleOne,
            );
            await client.capture('room-widgets-mobile-125-percent');
          },
        );
      } finally {
        await cleanup();
      }
    },
  },
  {
    id: 'restricted-bridge',
    source: ROOM_WIDGET_SOURCES.bridge,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('widget-bridge-owner');
      const rawUrl =
        'https://widgets.example/board?room=$matrix_room_id' +
        '&user=$matrix_user_id&board=$board_id';
      const room = await fixtures.createRoom(owner, {
        name: `Widgets ${resources.roomName('widget-bridge')}`,
        preset: 'private_chat',
        initial_state: [
          {
            type: 'im.vector.modular.widgets',
            state_key: 'planning-board',
            content: {
              name: 'Planning board',
              type: 'm.custom',
              url: rawUrl,
              data: { board_id: 'road map' },
            },
          },
        ],
      });
      const expectedUrl =
        `https://widgets.example/board?room=${encodeURIComponent(room.id)}` +
        `&user=${encodeURIComponent(owner.userId)}&board=road%20map`;

      await client.login(owner);
      await openRoom(
        client,
        room.name,
        assertions.bridgeRoomTimelineVisible,
      );
      await openWidgetSettings(client, assertions.bridgeWidgetsTabVisible);

      const connection = await client.webview.openSession();
      let widgetFixture: RoomWidgetFixture | undefined;
      const cleanup = async (): Promise<void> => {
        const failures: unknown[] = [];
        try {
          await widgetFixture?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(failures, 'Bridge fixture cleanup failed');
        }
      };
      resources.cleanup('Restricted widget bridge fixture', cleanup);
      try {
        await connection.send('Page.enable');
        await connection.send('Runtime.enable');
        widgetFixture = await installRoomWidgetFixture(connection, {
          holdCapabilities: true,
        });
        const cardSelector = '[data-testid="room-widget-planning-board"]';
        await observedElements(
          client,
          assertions.bridgeCardName,
          cardSelector,
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Planning board'),
        );
        await observedElements(
          client,
          assertions.bridgeCardType,
          cardSelector,
          (elements) => visibleOne(elements) && elements[0]!.text.includes('m.custom'),
        );
        await observedElements(
          client,
          assertions.bridgeCardRawUrl,
          cardSelector,
          (elements) => visibleOne(elements) && elements[0]!.text.includes(rawUrl),
        );
        await observedElements(
          client,
          assertions.bridgeCardOrigin,
          cardSelector,
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.text.includes('https://widgets.example'),
        );
        await observedElements(
          client,
          assertions.bridgeCardRoomSubstitution,
          cardSelector,
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('this room’s ID'),
        );
        await observedElements(
          client,
          assertions.bridgeCardUserSubstitution,
          cardSelector,
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.text.includes('your Matrix user ID'),
        );
        const openAttributes = `(() => { const link=document.querySelector('[data-testid="room-widget-open-planning-board"]'); return link instanceof HTMLAnchorElement ? {href:link.href,target:link.target,rel:link.rel} : null; })()`;
        await observedNative<{ href: string; target: string; rel: string } | null>(
          client,
          assertions.bridgeOpenHref,
          openAttributes,
          (value) => value?.href === expectedUrl,
        );
        await observedNative<{ href: string; target: string; rel: string } | null>(
          client,
          assertions.bridgeOpenTarget,
          openAttributes,
          (value) => value?.target === '_blank',
        );
        await observedNative<{ href: string; target: string; rel: string } | null>(
          client,
          assertions.bridgeOpenRel,
          openAttributes,
          (value) => value?.rel === 'noopener noreferrer',
        );
        await recordAssertion(
          client,
          assertions.bridgeNoEagerRequest,
          widgetFixture.requestCount,
          (count) => count === 0,
        );

        const embedSelector =
          '[data-testid="room-widget-embed-planning-board"]';
        await client.tapCurrent(embedSelector);
        await observedElements(
          client,
          assertions.bridgeFirstNegotiating,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Negotiating'),
        );
        await observedElements(
          client,
          assertions.bridgeFirstCloseFocused,
          '[data-testid="room-widget-frame-close"]',
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );
        await observedValue(
          client,
          assertions.bridgeFirstRequestCount,
          async () => widgetFixture!.requestCount,
          (count) => count === 1,
        );
        const firstRequest = await readWidgetRequest(
          connection,
          expectedUrl,
          client.signal,
        );
        await recordAssertion(
          client,
          assertions.bridgeFirstRequestPresent,
          firstRequest,
          (request) => Object.keys(request).length > 0,
        );
        await runBridgeAdversary(
          client,
          connection,
          'sibling',
          firstRequest,
        );
        await observedElements(
          client,
          assertions.bridgeSiblingForgeryRejected,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Negotiating'),
        );
        await client.tapCurrent('[data-testid="room-widget-frame-close"]');
        await observedElements(
          client,
          assertions.bridgeFirstFrameClosed,
          'iframe.widget-frame__iframe',
          (elements) => elements.length === 0,
        );
        await observedElements(
          client,
          assertions.bridgeEmbedRefocusedAfterFirstClose,
          embedSelector,
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );

        await client.tapCurrent(embedSelector);
        await observedElements(
          client,
          assertions.bridgeSecondNegotiating,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Negotiating'),
        );
        const secondRequest = await readWidgetRequest(
          connection,
          expectedUrl,
          client.signal,
        );
        await recordAssertion(
          client,
          assertions.bridgeSecondRequestPresent,
          secondRequest,
          (request) => Object.keys(request).length > 0,
        );
        await runBridgeAdversary(
          client,
          connection,
          'changed-origin',
          secondRequest,
        );
        await observedElements(
          client,
          assertions.bridgeChangedOriginRejected,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Negotiating'),
        );
        await client.tapCurrent('[data-testid="room-widget-frame-close"]');
        await observedElements(
          client,
          assertions.bridgeEmbedRefocusedAfterSecondClose,
          embedSelector,
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );

        await client.tapCurrent(embedSelector);
        const thirdRequest = await readWidgetRequest(
          connection,
          expectedUrl,
          client.signal,
        );
        assert(
          Object.keys(thirdRequest).length > 0,
          'Third Widget API capability request is present',
        );
        await evaluateFrame(
          connection,
          expectedUrl,
          `(() => { const control=document.querySelector('#trinity-widget-capability-release'); if(!(control instanceof HTMLElement))throw new Error('Widget capability release control missing'); control.dataset.release='next'; return true; })()`,
          client.signal,
        );
        await observedElements(
          client,
          assertions.bridgeReady,
          '[data-testid="widget-frame-status"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Widget API ready'),
          {},
          30_000,
        );
        await observedValue(
          client,
          assertions.bridgeRequestCount,
          async () => widgetFixture!.requestCount,
          (count) => count === 3,
        );
        await recordAssertion(
          client,
          assertions.bridgeReferrers,
          widgetFixture.referrers,
          (referrers) =>
            referrers.length === 3 &&
            referrers.every((referrer) => referrer === undefined),
        );

        const security = `(() => { const frame=document.querySelector('iframe.widget-frame__iframe'); return frame instanceof HTMLIFrameElement ? {sandbox:frame.getAttribute('sandbox'),referrerPolicy:frame.getAttribute('referrerpolicy'),allowFullscreen:frame.hasAttribute('allowfullscreen')} : null; })()`;
        await observedNative<{
          sandbox: string | null;
          referrerPolicy: string | null;
          allowFullscreen: boolean;
        } | null>(
          client,
          assertions.bridgeSandbox,
          security,
          (value) => value?.sandbox === 'allow-scripts allow-forms allow-same-origin',
        );
        await observedNative<{
          sandbox: string | null;
          referrerPolicy: string | null;
          allowFullscreen: boolean;
        } | null>(
          client,
          assertions.bridgeReferrerPolicy,
          security,
          (value) => value?.referrerPolicy === 'no-referrer',
        );
        await observedNative<{
          sandbox: string | null;
          referrerPolicy: string | null;
          allowFullscreen: boolean;
        } | null>(
          client,
          assertions.bridgeFullscreenDenied,
          security,
          (value) => value?.allowFullscreen === false,
        );
        const frameEvidence = await evaluateFrame<{
          heading: string;
          requested: string;
          approved: string;
          policy: string;
          denied: string;
        }>(
          connection,
          expectedUrl,
          `(() => ({heading:document.querySelector('h1')?.textContent??'',requested:document.querySelector('#requested')?.textContent??'',approved:document.querySelector('#approved')?.textContent??'',policy:document.querySelector('#policy-api')?.textContent??'',denied:document.querySelector('#denied')?.textContent??''}))()`,
          client.signal,
        );
        await recordAssertion(
          client,
          assertions.bridgeFixtureHeading,
          frameEvidence.heading,
          (value) => value === 'Widget fixture loaded',
        );
        await recordAssertion(
          client,
          assertions.bridgeRequestedCapabilities,
          frameEvidence.requested,
          (value) => value.includes('m.always_on_screen'),
        );
        await recordAssertion(
          client,
          assertions.bridgeApprovedCapabilities,
          frameEvidence.approved,
          (value) => value === '[]',
        );
        await recordAssertion(
          client,
          assertions.bridgePolicyApi,
          frameEvidence.policy,
          (value) => value === 'available',
        );
        const expectedDenied = JSON.stringify([
          ['camera', false],
          ['microphone', false],
          ['geolocation', false],
          ['display-capture', false],
          ['clipboard-read', false],
          ['fullscreen', false],
        ]);
        await recordAssertion(
          client,
          assertions.bridgeDeniedFeatures,
          frameEvidence.denied,
          (value) => value === expectedDenied,
        );
        const mixedContent = await observeMixedContentBlock(client, connection);
        await recordAssertion(
          client,
          assertions.bridgeMixedContentBlocked,
          mixedContent,
          (value) =>
            value.blockedRequests === 0 &&
            value.violation.includes('blocked-widget.test'),
        );
        await client.tapCurrent('[data-testid="room-widget-frame-close"]');
        await observedElements(
          client,
          assertions.bridgeEmbedRefocusedAfterFinalClose,
          embedSelector,
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );
      } finally {
        await cleanup();
      }
    },
  },
  {
    id: 'opening-admin-management',
    source: ROOM_WIDGET_SOURCES.management,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('widget-management-owner');
      const member = await fixtures.account('widget-management-member');
      const room = await fixtures.createRoom(owner, {
        name: `Manage widgets ${resources.roomName('widget-management')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);
      const widgetName = `Roadmap ${resources.roomName('widget')}`;
      const rawUrl =
        'https://widgets.example/board?room=$matrix_room_id&view=roadmap' +
        '&user=$matrix_user_id';

      await client.login(owner);
      await client.addAccount(member);
      await client.openMenu();
      await client.tapCurrent('[data-testid="account-row"]', {
        text: owner.userId,
      });
      await client.rooms(owner);
      await openRoom(
        client,
        room.name,
        assertions.managementRoomTimelineVisible,
      );
      await openWidgetSettings(client, assertions.managementWidgetsTabVisible);
      await observedElements(
        client,
        assertions.managementOpeningAccount,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );
      await invokeAccountContinuityHandlers(client, member);
      await observedElements(
        client,
        assertions.managementMemberAccountActive,
        '.userbar__handle',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(member.userId),
      );
      await observedElements(
        client,
        assertions.managementOpeningAccountRetained,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );

      const connection = await client.webview.openSession();
      let probe: RequestProbe | undefined;
      let fault: MatrixHttpFault | undefined;
      let releaseFailure: (() => void) | undefined;
      const firstResponseGate = new Promise<void>((resolvePromise) => {
        releaseFailure = resolvePromise;
      });
      const cleanup = async (): Promise<void> => {
        releaseFailure?.();
        const failures: unknown[] = [];
        try {
          await fault?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          await probe?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(failures, 'Widget management instrumentation cleanup failed');
        }
      };
      resources.cleanup('Widget management instrumentation', cleanup);
      try {
        probe = await installNoEagerWidgetProbe(connection);
        fault = await installFirstMatrixHttpFailure(
          connection,
          {
            kind: 'room-state',
            roomId: room.id,
            eventType: 'im.vector.modular.widgets',
            stateKey: '*',
            status: 500,
            responseError: 'retry me',
          },
          { firstResponseGate },
        );
        await client.fill('[data-testid="room-widget-create-name"]', widgetName);
        await client.fill('[data-testid="room-widget-create-url"]', rawUrl);
        await client.key('enter');
        await waitForNativeShellState(
          async () => fault!.attempts,
          (attempts) => attempts === 1,
          'first exact widget state write is held',
          client.signal,
        );
        await observedElements(
          client,
          assertions.managementAddingPending,
          '[data-testid="room-widget-create-submit"]',
          (elements) => visibleOne(elements) && elements[0]!.text.includes('Adding'),
        );
        const release = releaseFailure;
        assert(release, 'First widget failure gate has a release function');
        release();
        releaseFailure = undefined;
        await fault.waitForAttempts(1, client.signal);
        await observedElements(
          client,
          assertions.managementCreateError,
          '[data-testid="room-widget-create-error"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Could not add'),
        );
        await observedElements(
          client,
          assertions.managementDraftNameRetained,
          '[data-testid="room-widget-create-name"]',
          (elements) => visibleOne(elements) && elements[0]!.value === widgetName,
        );
        await observedElements(
          client,
          assertions.managementDraftUrlRetained,
          '[data-testid="room-widget-create-url"]',
          (elements) => visibleOne(elements) && elements[0]!.value === rawUrl,
        );
        await client.tapCurrent('[data-testid="room-widget-create-submit"]');
        const created = await observedElements(
          client,
          assertions.managementCardVisible,
          'article.room-widgets__widget',
          (elements) => elements.length === 1 && elements[0]!.visible,
          { text: widgetName },
        );
        const widgetTestId = created[0]!.attributes['data-testid'];
        assert(
          widgetTestId?.startsWith('room-widget-'),
          'Created widget exposes a stable state-key test id',
        );
        const widgetId = widgetTestId.slice('room-widget-'.length);
        const linkExpression = `(() => { const card=[...document.querySelectorAll('article.room-widgets__widget')].find(element=>(element.textContent??'').includes(${JSON.stringify(widgetName)})); const link=card?.querySelector('a'); return link instanceof HTMLAnchorElement ? link.href : null; })()`;
        await observedNative<string | null>(
          client,
          assertions.managementCreatorHref,
          linkExpression,
          (value) =>
            typeof value === 'string' &&
            value.includes(`user=${encodeURIComponent(owner.userId)}`),
        );
        await recordAssertion(
          client,
          assertions.managementNoEagerRequestAfterCreate,
          probe.count,
          (count) => count === 0,
        );
        const declaration = await observedValue(
          client,
          assertions.managementDeclarationPresent,
          () =>
            fixtures.roomState(
              owner,
              room.id,
              'im.vector.modular.widgets',
              widgetId,
            ),
          (value) => value !== undefined,
        );
        await recordAssertion(
          client,
          assertions.managementDeclarationExact,
          declaration,
          (value) =>
            isDeepStrictEqual(value, {
              id: widgetId,
              name: widgetName,
              type: 'm.custom',
              url: rawUrl,
              creatorUserId: owner.userId,
              data: {},
              waitForIframeLoad: true,
            }),
        );
        await observedElements(
          client,
          assertions.managementFeedbackVisible,
          '[data-testid="room-widget-create-name-feedback"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.managementNameFocused,
          '[data-testid="room-widget-create-name"]',
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );
        const removeSelector =
          `[data-testid="room-widget-remove-${widgetId}"]`;
        await client.scrollIntoViewIfNeeded(
          removeSelector,
          '.room-settings__section-scroll',
        );
        await client.tapCurrent(removeSelector);
        await observedElements(
          client,
          assertions.managementConfirmationName,
          'trn-alert-dialog',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes(widgetName),
        );
        await observedElements(
          client,
          assertions.managementConfirmationScope,
          'trn-alert-dialog',
          (elements) =>
            visibleOne(elements) &&
            elements[0]!.text.includes('every member and Matrix client'),
        );
        await client.tapCurrent('[data-testid="alert-confirm"]');
        await observedElements(
          client,
          assertions.managementCardRemoved,
          'article.room-widgets__widget',
          (elements) => elements.length === 0,
          { text: widgetName },
        );
        await observedElements(
          client,
          assertions.managementNameRefocused,
          '[data-testid="room-widget-create-name"]',
          (elements) => visibleOne(elements) && elements[0]!.focused,
        );
        await recordAssertion(
          client,
          assertions.managementNoEagerRequestAfterRemoval,
          probe.count,
          (count) => count === 0,
        );
        await observedValue(
          client,
          assertions.managementTombstoneEmpty,
          () =>
            fixtures.roomState(
              owner,
              room.id,
              'im.vector.modular.widgets',
              widgetId,
            ),
          (value) =>
            value !== undefined && Object.keys(value).length === 0,
        );
        await client.record('widget-write-fault', {
          target: {
            roomId: room.id,
            eventType: 'im.vector.modular.widgets',
            stateKey: '*',
          },
          matchingAttempts: fault.attempts,
          firstOutcome: fault.firstOutcome,
        });
      } finally {
        await cleanup();
      }
    },
  },
  {
    id: 'live-authority',
    source: ROOM_WIDGET_SOURCES.authority,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('widget-authority-owner');
      const member = await fixtures.account('widget-authority-member');
      const room = await fixtures.createRoom(owner, {
        name: `Widget powers ${resources.roomName('widget-authority')}`,
        preset: 'private_chat',
        invite: [member.userId],
        initial_state: [
          {
            type: 'im.vector.modular.widgets',
            state_key: 'shared-board',
            content: {
              name: 'Shared board',
              type: 'm.custom',
              url: 'https://widgets.example/shared',
            },
          },
        ],
      });
      await fixtures.join(member, room.id);

      await client.login(member);
      await openRoom(
        client,
        room.name,
        assertions.authorityRoomTimelineVisible,
      );
      await openWidgetSettings(client, assertions.authorityWidgetsTabVisible);
      const connection = await client.webview.openSession();
      let probe: RequestProbe | undefined;
      const cleanup = async (): Promise<void> => {
        const failures: unknown[] = [];
        try {
          await probe?.close();
        } catch (error) {
          failures.push(error);
        }
        try {
          connection.close();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length) {
          throw new AggregateError(failures, 'Widget authority probe cleanup failed');
        }
      };
      resources.cleanup('Widget authority request probe', cleanup);
      try {
        probe = await installNoEagerWidgetProbe(connection);
        await observedElements(
          client,
          assertions.authorityInitialCardVisible,
          '[data-testid="room-widget-shared-board"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.authorityInitialCreateAbsent,
          '[data-testid="room-widget-create"]',
          (elements) => elements.length === 0,
        );
        await observedElements(
          client,
          assertions.authorityInitialRemoveAbsent,
          '[data-testid="room-widget-remove-shared-board"]',
          (elements) => elements.length === 0,
        );
        await fixtures.setRoomPower(owner, room.id, member.userId, 50);
        await observedElements(
          client,
          assertions.authorityGrantedCreateVisible,
          '[data-testid="room-widget-create"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.authorityGrantedRemoveVisible,
          '[data-testid="room-widget-remove-shared-board"]',
          visibleOne,
        );
        await fixtures.setRoomPower(owner, room.id, member.userId, 0);
        await observedElements(
          client,
          assertions.authorityRevokedCreateAbsent,
          '[data-testid="room-widget-create"]',
          (elements) => elements.length === 0,
        );
        await observedElements(
          client,
          assertions.authorityRevokedRemoveAbsent,
          '[data-testid="room-widget-remove-shared-board"]',
          (elements) => elements.length === 0,
        );
        await recordAssertion(
          client,
          assertions.authorityNoEagerRequest,
          probe.count,
          (count) => count === 0,
        );
      } finally {
        await cleanup();
      }
    },
  },
];

assert.equal(cases.length, 4, 'Exactly four Room widget stages are required');
assert.equal(
  Object.keys(assertions).length,
  93,
  'Exactly 93 Room widget assertions are required',
);
const requestedStage = process.env['TRINITY_E2E_ROOM_WIDGET_STAGE'];
const selectedCases = requestedStage
  ? cases.filter((entry) => entry.id === requestedStage)
  : cases;
assert(
  !requestedStage || selectedCases.length === 1,
  `Unknown Room widget stage: ${requestedStage}`,
);

void test(
  'Android Room widget journeys',
  { timeout: 2_400_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-widget-settings',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[`PASSWORD_${account.username}`] = account.password;
            return account;
          },
        };
        matrixResources.cleanup('Redact Room widget diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const stages: Array<{
          readonly id: string;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: cases.length,
                expectedAssertions: Object.keys(assertions).length,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Room widget Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room widget Android WebView',
          async () => client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );

        for (const entry of selectedCases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/*`,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[room-widget-settings] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? DESKTOP_ACCOUNT_PROFILE);
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
              signal,
            });
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            try {
              await save();
            } catch (error) {
              failures.push(error);
            }
            console.info(
              `[room-widget-settings] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room widget journey ${entry.id} failed`,
            );
          }
        }
        assert.equal(
          stages.filter((stage) => stage.status === 'passed').length,
          selectedCases.length,
        );
      },
    );
  },
);
