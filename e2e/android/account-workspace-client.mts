import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaestroDevice } from './maestro-session.mts';
import { openMaestroViewport, type MaestroViewport, type MaestroViewportOptions } from './maestro-viewport.mts';
import { pressAndroidKeyboardKey, type AndroidKeyboardKey } from './maestro-keyboard.mts';
import { assertNativeDocumentActivation } from './maestro-document-picker.mts';
import {
  captureNativeShellProof,
  evaluateNative,
  navigateNativeShell,
  readNativeShellSurface,
  startNativeShellClient,
  waitForNativeShellState,
} from './native-shell-client.mts';
import { openMaestroTargetPoint, type NativeTargetPoint } from './maestro-target-point.mts';
import type { createNodeAccount } from '../support/node-account.mts';
import type { createAccountFixtures } from './account-workspace-fixtures.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';

type Account = Awaited<ReturnType<typeof createNodeAccount>>;
export type AccountViewportProfile = Pick<MaestroViewportOptions, 'width' | 'height' | 'isMobile' | 'hasTouch' | 'deviceScaleFactor' | 'userAgent'>;

export const DESKTOP_ACCOUNT_PROFILE: AccountViewportProfile = {
  width: 1280, height: 720, isMobile: false, hasTouch: false, deviceScaleFactor: 1,
};

// Canonical Pixel 5 options copied by the predecessor's test.use at Playwright 1.62.1.
// Its descriptor.screen is not passed by that test; screen dimensions follow apply(size).
export const PIXEL_5_ACCOUNT_PROFILE: AccountViewportProfile = {
  width: 393, height: 727, isMobile: true, hasTouch: true, deviceScaleFactor: 2.75,
  userAgent: 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.7922.34 Mobile Safari/537.36',
};

const LONG_PRESS_DURATION_MS = 750;
const LONG_PRESS_DRIFT_PX = 2;
const LONG_PRESS_THRESHOLD_MS = 500;

export interface AccountElement {
  readonly text: string;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly value: string | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly right: number; readonly bottom: number };
  readonly style: { readonly display: string; readonly opacity: string; readonly overflowY: string };
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly unobstructedCenter: boolean;
}

export interface AccountElementFilter {
  readonly text?: string;
  readonly exactText?: string;
}

interface LongPressTarget {
  readonly point: NativeTargetPoint;
  readonly cssPoint: { readonly x: number; readonly y: number };
  readonly hit: {
    readonly tagName: string;
    readonly className: string;
    readonly testId: string | null;
    readonly userSelect: string;
  };
  readonly selectionSafe: boolean;
  readonly textRectCount: number;
  readonly blockingRectCount: number;
}

export interface AccountWorkspaceCaseContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
}

export interface AccountWorkspaceCase {
  readonly id: string;
  readonly source: string;
  readonly profile?: AccountViewportProfile;
  run(context: AccountWorkspaceCaseContext): Promise<void>;
}

/** Account-batch DOM observations and measured Maestro native input. */
export class AccountWorkspaceClient {
  private active: Awaited<ReturnType<typeof startNativeShellClient>> | undefined;
  private viewport: MaestroViewport | undefined;
  private action = 0;

  readonly device: MaestroDevice;
  readonly workspaceRoot: string;
  readonly output: string;
  readonly signal: AbortSignal;

  constructor(device: MaestroDevice, workspaceRoot: string, output: string, signal: AbortSignal) {
    this.device = device;
    this.workspaceRoot = workspaceRoot;
    this.output = output;
    this.signal = signal;
  }

  get webview(): NonNullable<typeof this.active>['webview'] {
    assert(this.active, 'Account WebView is active');
    return this.active.webview;
  }

  private get owner(): MaestroViewport {
    assert(this.viewport, 'Account viewport is active');
    return this.viewport;
  }

  async close(): Promise<void> {
    const viewport = this.viewport;
    const active = this.active;
    this.viewport = undefined;
    this.active = undefined;
    const failures: unknown[] = [];
    try { await viewport?.close(); } catch (error) { failures.push(error); }
    try { await active?.webview.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Account WebView cleanup failed');
  }

  async reset(profile = DESKTOP_ACCOUNT_PROFILE): Promise<void> {
    await this.close();
    assert.equal(await this.device.adb('shell', 'pm', 'clear', 'eu.qwky.trinity'), 'Success');
    await this.device.adb('shell', 'pm', 'grant', 'eu.qwky.trinity', 'android.permission.POST_NOTIFICATIONS');
    this.active = await startNativeShellClient(this.device, 'eu.qwky.trinity', this.signal);
    await this.visible('#homeserver', {}, 60_000);
    this.viewport = await openMaestroViewport(this.device, { pid: this.active.pid, ...profile, signal: this.signal });
    await this.viewport.apply();
  }

  /** Relaunch the installed host without clearing its persisted application state. */
  async relaunch(profile = DESKTOP_ACCOUNT_PROFILE): Promise<void> {
    await this.close();
    await this.device.adb(
      'shell',
      'am',
      'force-stop',
      'eu.qwky.trinity',
    );
    this.active = await startNativeShellClient(
      this.device,
      'eu.qwky.trinity',
      this.signal,
    );
    await this.waitElements(
      '#homeserver, [data-testid="rail-rooms"]',
      (elements) => elements.some((element) => element.visible),
      'visible Login or persisted Rooms surface after host relaunch',
      {},
      60_000,
    );
    this.viewport = await openMaestroViewport(this.device, {
      pid: this.active.pid,
      ...profile,
      signal: this.signal,
    });
    await this.viewport.apply();
  }

  async elements(selector: string, filter: AccountElementFilter = {}): Promise<readonly AccountElement[]> {
    const value = await evaluateNative(this.webview, `(() => {
      const { selector, filter } = ${JSON.stringify({ selector, filter })};
      return [...document.querySelectorAll(selector)].filter(e =>
        (filter.text === undefined || (e.textContent ?? '').includes(filter.text)) &&
        (filter.exactText === undefined || e.textContent?.trim() === filter.exactText)
      ).map(e => {
        const r = e.getBoundingClientRect(), style = getComputedStyle(e);
        const x = r.x + r.width / 2, y = r.y + r.height / 2;
        return {
          text: e.textContent?.trim() ?? '', visible: r.width > 0 && r.height > 0 && style.visibility === 'visible',
          focused: document.activeElement === e, disabled: e.matches(':disabled'),
          value:
            e instanceof HTMLTextAreaElement ||
            (e instanceof HTMLInputElement && e.type !== 'password')
              ? e.value
              : null,
          attributes: Object.fromEntries([...e.attributes].filter(a => ['id', 'role', 'data-testid', 'data-disabled', 'data-autofocus', 'aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-live'].includes(a.name)).map(a => [a.name,a.value])),
          rect: {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},
          style: {display:style.display,opacity:style.opacity,overflowY:style.overflowY},
          scrollHeight:e.scrollHeight,scrollTop:e.scrollTop,clientHeight:e.clientHeight,
          unobstructedCenter:x>=0&&y>=0&&x<innerWidth&&y<innerHeight&&e.contains(document.elementFromPoint(x,y))
        };
      });
    })()`);
    assert(Array.isArray(value), 'Account DOM observation is an array');
    return value as AccountElement[];
  }

  async waitElements(
    selector: string,
    accepts: (elements: readonly AccountElement[]) => boolean,
    description: string,
    filter: AccountElementFilter = {},
    timeoutMs = 15_000,
  ): Promise<readonly AccountElement[]> {
    return waitForNativeShellState(() => this.elements(selector, filter), accepts, description, this.signal, timeoutMs);
  }

  async visible(selector: string, filter: AccountElementFilter = {}, timeoutMs = 15_000): Promise<AccountElement> {
    const elements = await this.waitElements(selector, es => es.length === 1 && es[0]!.visible, `one visible ${selector}`, filter, timeoutMs);
    return elements[0]!;
  }

  async focused(selector: string, filter: AccountElementFilter = {}): Promise<void> {
    await this.waitElements(selector, elements => elements.length === 1 && elements[0]!.focused, `focused ${selector}`, filter);
  }

  async expectCount(selector: string, expected: number, filter: AccountElementFilter = {}): Promise<void> {
    await this.waitElements(selector, elements => elements.length === expected, `${expected} matching ${selector}`, filter);
  }

  async tap(selector: string, filter: AccountElementFilter = {}): Promise<void> {
    await this.nativeAction('accounts-point-tap', selector, filter);
  }

  async tapCurrent(selector: string, filter: AccountElementFilter = {}): Promise<void> {
    await this.nativeAction('accounts-current-point-tap', selector, filter, {}, {
      currentPoint: true,
    });
  }

  /** Focus one input through Maestro and require an observed focus transition. */
  async focusCurrent(
    selector: string,
    filter: AccountElementFilter = {},
  ): Promise<void> {
    await this.nativeAction('accounts-current-point-tap', selector, filter, {}, {
      currentPoint: true,
      allowFocusTransition: true,
    });
  }

  async tapCurrentReplacingDocument(
    selector: string,
    previousTimeOrigin: number,
    filter: AccountElementFilter = {},
  ): Promise<void> {
    await this.nativeAction('accounts-current-point-tap', selector, filter, {}, {
      currentPoint: true,
      allowDocumentReplacementFrom: previousTimeOrigin,
    });
  }

  /** Tap a measured visible point when an overlay partially covers the target. */
  async tapCurrentExposed(
    selector: string,
    filter: AccountElementFilter = {},
  ): Promise<void> {
    await this.nativeAction(
      'accounts-current-point-tap',
      selector,
      filter,
      {},
      { currentPoint: true, exposedPoint: true },
    );
  }

  async longPressCurrent(
    selector: string,
    filter: AccountElementFilter = {},
  ): Promise<void> {
    const target = await this.longPressTarget(selector, filter);
    const point = target.point;
    const actionId = ++this.action;
    // Maestro's longPressOn has no configurable duration and races Trinity's exact
    // 500 ms threshold. A two-native-pixel horizontal drift keeps Maestro on its
    // duration-controlled swipe path while remaining far below Trinity's 10 CSS px
    // cancellation slop.
    const flow = join(this.output, `accounts-point-long-press-${actionId}.yaml`);
    await writeFile(
      flow,
      `appId: eu.qwky.trinity\n---\n- swipe:\n    start: "${point.x},${point.y}"\n    end: "${point.x + LONG_PRESS_DRIFT_PX},${point.y}"\n    duration: ${LONG_PRESS_DURATION_MS}\n`,
    );
    await evaluateNative(this.webview, `(() => {
      const {selector,filter}=${JSON.stringify({ selector, filter })};
      const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
      if(es.length!==1)throw new Error('Native long-press target changed before dispatch');
      const element=es[0],types=['pointerdown','pointermove','pointerup','pointercancel'];
      const state={events:[],types,listener:e=>state.events.push({type:e.type,trusted:e.isTrusted,matched:element.contains(e.target),targetTag:e.target instanceof Element?e.target.tagName:null,targetClass:e.target instanceof Element?e.target.className:null,pointerId:e.pointerId,timeStamp:e.timeStamp,clientX:e.clientX,clientY:e.clientY})};
      window.__trinityAccountLongPress=state;
      for(const type of types)document.addEventListener(type,state.listener,true);
      return true;
    })()`);
    let actionError: unknown;
    let trustedEvents: unknown = null;
    let durationMs: number | null = null;
    try {
      console.info(`[accounts] native action ${actionId}: 750 ms long press ${selector}`);
      await this.device.runFlow(flow, {});
      const events = await evaluateNative(
        this.webview,
        'window.__trinityAccountLongPress?.events ?? []',
      );
      assert(Array.isArray(events), 'Native long-press events are an array');
      trustedEvents = events;
      const down = events.find(
        (event) =>
          event?.type === 'pointerdown' &&
          event.trusted === true &&
          event.matched === true,
      );
      assert(down, `Native long press ${actionId} started on ${selector}`);
      const terminal = events.find(
        (event) =>
          (event?.type === 'pointerup' ||
            event?.type === 'pointercancel') &&
          event.trusted === true &&
          event.pointerId === down.pointerId,
      );
      assert(
        terminal,
        `Native long press ${actionId} completed with pointerup or pointercancel`,
      );
      const samePointerEvents = events.filter(
        (event) =>
          event?.trusted === true &&
          event.pointerId === down.pointerId &&
          Number.isFinite(event.timeStamp),
      );
      durationMs =
        Math.max(...samePointerEvents.map((event) => event.timeStamp)) -
        down.timeStamp;
      assert(
        durationMs >= LONG_PRESS_THRESHOLD_MS,
        `Native long press ${actionId} held for at least ${LONG_PRESS_THRESHOLD_MS} ms (observed ${durationMs} ms)`,
      );
    } catch (error) {
      actionError = error;
    } finally {
      const failures: unknown[] = [];
      try {
        await this.record(`long-press-${actionId}`, {
          selector,
          point,
          target,
          requestedDurationMs: LONG_PRESS_DURATION_MS,
          requestedDriftPx: LONG_PRESS_DRIFT_PX,
          observedDurationMs: durationMs,
          trustedEvents,
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await evaluateNative(
          this.webview,
          "(() => {const state=window.__trinityAccountLongPress;if(state)for(const type of state.types)document.removeEventListener(type,state.listener,true);delete window.__trinityAccountLongPress;return true})()",
        );
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.owner.apply();
      } catch (error) {
        failures.push(error);
      }
      if (actionError !== undefined) failures.unshift(actionError);
      if (failures.length === 1) throw failures[0];
      if (failures.length) {
        throw new AggregateError(
          failures,
          'Native account long press and cleanup failed',
        );
      }
    }
  }

  private async longPressTarget(
    selector: string,
    filter: AccountElementFilter,
  ): Promise<LongPressTarget> {
    this.signal.throwIfAborted();
    await this.owner.apply();
    this.signal.throwIfAborted();
    const measured = await waitForNativeShellState(
      () =>
        evaluateNative(this.webview, `(() => {
          const {selector,filter}=${JSON.stringify({ selector, filter })};
          const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
          if(es.length!==1)return null;
          const element=es[0],rect=element.getBoundingClientRect();
          if(rect.width<=0||rect.height<=0||getComputedStyle(element).visibility!=='visible')return null;
          const textRects=[],walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT);
          for(let node=walker.nextNode();node;node=walker.nextNode()){
            if(!(node.textContent??'').trim())continue;
            const range=document.createRange();
            range.selectNodeContents(node);
            for(const r of range.getClientRects())textRects.push({left:r.left,top:r.top,right:r.right,bottom:r.bottom});
          }
          const blockerSelector='a,button,img,video,audio,input,textarea,select';
          const blockingRects=[...element.querySelectorAll(blockerSelector)].flatMap(node=>[...node.getClientRects()].map(r=>({left:r.left,top:r.top,right:r.right,bottom:r.bottom})));
          const candidates=[...element.querySelectorAll('*')].filter(node=>getComputedStyle(node).userSelect==='none'&&!node.closest(blockerSelector)).flatMap(node=>[...node.getClientRects()].map(r=>({x:r.left+r.width/2,y:r.top+r.height/2})));
          for(const {x,y} of candidates){
            if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
            const hit=document.elementFromPoint(x,y);
            if(!(hit instanceof Element)||!element.contains(hit))continue;
            if(hit.closest(blockerSelector))continue;
            const userSelect=getComputedStyle(hit).userSelect;
            if(userSelect!=='none')continue;
            return {cssPoint:{x,y},hit:{tagName:hit.tagName,className:typeof hit.className==='string'?hit.className:'',testId:hit.getAttribute('data-testid'),userSelect},selectionSafe:true,textRectCount:textRects.length,blockingRectCount:blockingRects.length};
          }
          return null;
        })()`),
      (value) => value !== null,
      `non-selectable native long-press point inside ${selector}`,
      this.signal,
      15_000,
    );
    assert(measured && typeof measured === 'object');
    const value = measured as Omit<LongPressTarget, 'point'>;
    const point = await this.owner.nativePoint(value.cssPoint);
    this.signal.throwIfAborted();
    return { ...value, point };
  }

  async tapDocumentTrigger(selector: string, fileInputSelector: string): Promise<void> {
    await this.nativeAction('accounts-current-point-tap', selector, {}, {}, {
      currentPoint: true,
      fileInputSelector,
    });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.nativeAction(
      'accounts-point-fill',
      selector,
      {},
      { SECRET_TEXT: value },
      { allowFocusedInput: true },
    );
    const matches = await evaluateNative(this.webview, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
    assert.equal(matches, true, `Native input reached ${selector}`);
  }

  /** Fill a product-autofocused input without allowing IME auto-capitalisation. */
  async fillFocused(selector: string, value: string): Promise<void> {
    await this.focused(selector);
    const actionId = ++this.action;
    console.info(`[accounts] native action ${actionId}: focused fill ${selector}`);
    let failure: unknown;
    try {
      await this.device.runFlow(
        join(this.workspaceRoot, 'e2e/android/flows/accounts-focused-fill.yaml'),
        { APP_ID: 'eu.qwky.trinity', SECRET_TEXT: `x${value}` },
      );
      await this.key('home');
      await this.key('forwardDelete');
    } catch (error) {
      failure = error;
    }
    try {
      await this.owner.apply();
    } catch (error) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, error],
          'Native focused fill and viewport restoration failed',
        );
      throw error;
    }
    if (failure !== undefined) throw failure;
    const matches = await evaluateNative(
      this.webview,
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
    );
    assert.equal(matches, true, `Native focused input reached ${selector}`);
  }

  /** Replace a prefilled value after moving the native caret to its exact end. */
  async replace(selector: string, value: string): Promise<void> {
    await this.tapCurrent(selector);
    await this.key('end');
    await this.device.runFlow(
      join(this.workspaceRoot, 'e2e/android/flows/accounts-focused-fill.yaml'),
      { APP_ID: 'eu.qwky.trinity', SECRET_TEXT: value },
    );
    const matches = await evaluateNative(
      this.webview,
      `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
    );
    assert.equal(matches, true, `Native replacement reached ${selector}`);
  }

  /** Paste Android's system clipboard through the focused input's native context menu. */
  async pasteSystemClipboardFocused(
    selector: string,
    filter: AccountElementFilter = {},
  ): Promise<void> {
    this.signal.throwIfAborted();
    await this.focused(selector, filter);
    const actionId = ++this.action;
    const pointEndpoint = await openMaestroTargetPoint({
      signal: this.signal,
      readPoint: (operationSignal) =>
        this.actionablePoint(selector, filter, operationSignal),
    });
    const failures: unknown[] = [];
    try {
      console.info(
        `[accounts] native action ${actionId}: system clipboard paste ${selector}`,
      );
      await this.device.runFlow(
        join(
          this.workspaceRoot,
          'e2e/android/flows/accounts-focused-paste.yaml',
        ),
        { APP_ID: 'eu.qwky.trinity', POINT_URL: pointEndpoint.url },
      );
    } catch (error) {
      failures.push(error);
    } finally {
      if (pointEndpoint.lastError !== undefined) {
        failures.push(pointEndpoint.lastError);
      }
      try {
        await pointEndpoint.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.record(`system-paste-${actionId}`, {
          selector,
          point: pointEndpoint.lastPoint ?? null,
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.owner.apply();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Native system clipboard paste and cleanup failed',
      );
    }
  }

  async scrollIntoViewIfNeeded(selector: string, container: string): Promise<void> {
    for (let gesture = 0; gesture < 8; gesture++) {
      await this.owner.apply();
      const row = await this.visible(selector);
      const list = await this.visible(container);
      const center = row.rect.y + row.rect.height / 2;
      if (row.unobstructedCenter && center >= list.rect.y && center <= list.rect.bottom) return;
      assert(list.scrollHeight > list.clientHeight, 'Clipped account row needs a scrollable list');
      const viewport = await this.visible('html');
      const visibleTop = Math.max(list.rect.y, 0);
      const visibleBottom = Math.min(list.rect.bottom, viewport.clientHeight);
      const visibleHeight = visibleBottom - visibleTop;
      assert(visibleHeight >= 8, 'Account list has a visible native scroll region');
      const top = visibleTop + visibleHeight * 0.2;
      const bottom = visibleBottom - visibleHeight * 0.2;
      assert(bottom - top >= 8, 'Account list has enough room for a native scroll gesture');
      const x = list.rect.x + list.rect.width / 2;
      const down = center > list.rect.y + list.rect.height / 2;
      const start = await this.owner.nativePoint({ x, y: down ? bottom : top });
      const end = await this.owner.nativePoint({ x, y: down ? top : bottom });
      // Maestro parses absolute swipe coordinates before expanding variables.
      // Materialize the measured integer points in the ignored proof directory.
      const flow = join(this.output, `accounts-point-swipe-${++this.action}.yaml`);
      await writeFile(flow, `appId: eu.qwky.trinity\n---\n- swipe:\n    start: "${start.x},${start.y}"\n    end: "${end.x},${end.y}"\n    duration: 600\n`);
      let failure: unknown;
      try {
        await this.device.runFlow(flow, {});
      } catch (error) { failure = error; }
      try { await this.owner.apply(); } catch (error) {
        if (failure !== undefined) throw new AggregateError([failure, error], 'Account scroll and viewport restoration failed');
        throw error;
      }
      if (failure !== undefined) throw failure;
      await this.waitElements(container, rows => rows.length === 1 && rows[0]!.scrollTop !== list.scrollTop, 'native account list scroll changed its offset');
    }
    const row = await this.visible(selector);
    assert(row.unobstructedCenter, 'Native scrolling made the account row reachable');
  }

  private async actionablePoint(
    selector: string,
    filter: AccountElementFilter,
    operationSignal = this.signal,
  ): Promise<NativeTargetPoint> {
    operationSignal.throwIfAborted();
    await this.owner.apply();
    operationSignal.throwIfAborted();
    const es = await waitForNativeShellState(
      () => this.elements(selector, filter),
      es => es.length === 1 && es[0]!.visible && !es[0]!.disabled && es[0]!.unobstructedCenter,
      `one actionable ${selector}`,
      operationSignal,
      15_000,
    );
    operationSignal.throwIfAborted();
    const r = es[0]!.rect;
    const point = await this.owner.nativePoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    operationSignal.throwIfAborted();
    return point;
  }

  private async exposedActionablePoint(
    selector: string,
    filter: AccountElementFilter,
    operationSignal = this.signal,
  ): Promise<NativeTargetPoint> {
    operationSignal.throwIfAborted();
    await this.owner.apply();
    operationSignal.throwIfAborted();
    const cssPoint = await waitForNativeShellState(
      () =>
        evaluateNative(this.webview, `(() => {
          const {selector,filter}=${JSON.stringify({ selector, filter })};
          const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
          if(es.length!==1)return null;
          const element=es[0],rect=element.getBoundingClientRect(),style=getComputedStyle(element);
          if(rect.width<=0||rect.height<=0||style.visibility!=='visible'||element.matches(':disabled'))return null;
          const xs=[rect.left+Math.min(24,rect.width/4),rect.left+rect.width/2,rect.right-Math.min(24,rect.width/4)];
          const ys=[rect.top+Math.min(24,rect.height/4),rect.top+rect.height/2,rect.bottom-Math.min(24,rect.height/4)];
          for(const y of ys)for(const x of xs){
            if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
            const hit=document.elementFromPoint(x,y);
            if(hit instanceof Element&&element.contains(hit))return {x,y};
          }
          return null;
        })()`),
      (value) => value !== null,
      `one exposed actionable point inside ${selector}`,
      operationSignal,
      15_000,
    );
    assert(
      cssPoint &&
        typeof cssPoint === 'object' &&
        typeof (cssPoint as { x?: unknown }).x === 'number' &&
        typeof (cssPoint as { y?: unknown }).y === 'number',
      `Measured an exposed point inside ${selector}`,
    );
    operationSignal.throwIfAborted();
    return this.owner.nativePoint(cssPoint as { x: number; y: number });
  }

  private async nativeAction(
    flow: string,
    selector: string,
    filter: AccountElementFilter,
    variables: Readonly<Record<string, string>> = {},
    options: {
      readonly currentPoint?: boolean;
      readonly allowFocusedInput?: boolean;
      readonly allowFocusTransition?: boolean;
      readonly allowDocumentReplacementFrom?: number;
      readonly fileInputSelector?: string;
      readonly exposedPoint?: boolean;
    } = {},
  ): Promise<void> {
    const currentPoint = options.currentPoint ?? false;
    const allowFocusedInput = options.allowFocusedInput ?? false;
    const allowFocusTransition = options.allowFocusTransition ?? false;
    const allowDocumentReplacementFrom =
      options.allowDocumentReplacementFrom;
    const fileInputSelector = options.fileInputSelector;
    const resolvePoint = options.exposedPoint
      ? (operationSignal?: AbortSignal) =>
          this.exposedActionablePoint(selector, filter, operationSignal)
      : (operationSignal?: AbortSignal) =>
          this.actionablePoint(selector, filter, operationSignal);
    const initialPoint = await resolvePoint();
    let initiallyFocused: boolean | undefined;
    if (allowFocusTransition) {
      const initialTargets = await this.elements(selector, filter);
      assert.equal(
        initialTargets.length,
        1,
        `Native focus target is exactly one ${selector}`,
      );
      assert.notEqual(
        initialTargets[0]!.value,
        null,
        `Native focus target is an input ${selector}`,
      );
      initiallyFocused = initialTargets[0]!.focused;
    }
    const actionId = ++this.action;
    // Observe capture before application listeners can remove the clicked element.
    await evaluateNative(this.webview, `(() => {
      const {selector,filter,fileInputSelector}=${JSON.stringify({ selector, filter, fileInputSelector })};
      const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
      if(es.length!==1)throw new Error('Native target changed before dispatch');
      const element=es[0];
      const inputs=fileInputSelector===undefined?[]:[...document.querySelectorAll(fileInputSelector)];
      if(fileInputSelector!==undefined&&(inputs.length!==1||!(inputs[0] instanceof HTMLInputElement)||inputs[0].type!=='file'||!inputs[0].hidden))throw new Error('Native document target requires one exact hidden file input');
      const fileInput=inputs[0];
      window.__trinityAccountTap={events:[],listener:e=>window.__trinityAccountTap.events.push({trusted:e.isTrusted,matched:element.contains(e.target),...(fileInputSelector===undefined?{}:{fileInputMatched:e.target===fileInput})})};
      document.addEventListener('click',window.__trinityAccountTap.listener,true);
      return true;
    })()`);
    let actionError: unknown;
    let pointEndpoint: Awaited<ReturnType<typeof openMaestroTargetPoint>> | undefined;
    let trustedEvents: unknown = null;
    let documentReplaced = false;
    try {
      console.info(`[accounts] native action ${actionId}: ${flow} ${selector}`);
      const flowVariables: Record<string, string> = { APP_ID: 'eu.qwky.trinity', POINT: `${initialPoint.x},${initialPoint.y}`, ...variables };
      if (currentPoint) {
        pointEndpoint = await openMaestroTargetPoint({
          signal: this.signal,
          readPoint: resolvePoint,
        });
        flowVariables.POINT_URL = pointEndpoint.url;
      }
      await this.device.runFlow(join(this.workspaceRoot, `e2e/android/flows/${flow}.yaml`), flowVariables);
      const outcome = await evaluateNative(
        this.webview,
        `({events:window.__trinityAccountTap?.events ?? [],documentTimeOrigin:performance.timeOrigin})`,
      );
      assert(outcome && typeof outcome === 'object');
      assert('events' in outcome && Array.isArray(outcome.events));
      assert(
        'documentTimeOrigin' in outcome &&
          typeof outcome.documentTimeOrigin === 'number',
      );
      const events = outcome.events;
      trustedEvents = events;
      documentReplaced =
        allowDocumentReplacementFrom !== undefined &&
        outcome.documentTimeOrigin !== allowDocumentReplacementFrom;
      const activated = events.some(
        event =>
          event &&
          typeof event === 'object' &&
          event.trusted === true &&
          event.matched === true,
      );
      if (!activated && !documentReplaced && allowFocusTransition) {
        assert.equal(
          initiallyFocused,
          false,
          `Native input ${actionId} began unfocused ${selector}`,
        );
        const target = await this.elements(selector, filter);
        assert(
          target.length === 1 && target[0]!.focused,
          `Native input ${actionId} focused ${selector}`,
        );
      } else if (!activated && allowFocusedInput) {
        const target = await this.elements(selector, filter);
        assert(
          target.length === 1 && target[0]!.focused,
          `Native input ${actionId} focused ${selector}`,
        );
      } else {
        assert(
          activated || documentReplaced,
          `Native action ${actionId} activated ${selector}`,
        );
      }
      if (fileInputSelector !== undefined) assertNativeDocumentActivation(events);
      else assert(documentReplaced || events.every(event => event && typeof event === 'object' && event.matched === true), `Native action ${actionId} hit only ${selector}`);
    } catch (error) {
      actionError = error;
    } finally {
      const failures: unknown[] = [];
      if (pointEndpoint?.lastError !== undefined) failures.push(pointEndpoint.lastError);
      try { await pointEndpoint?.close(); } catch (error) { failures.push(error); }
      if (currentPoint) {
        try {
          await this.record(`current-point-${actionId}`, {
            selector,
            ...(fileInputSelector === undefined ? {} : { fileInputSelector }),
            initialPoint,
            freshPoint: pointEndpoint?.lastPoint ?? null,
            trustedEvents,
            documentReplaced,
          });
        } catch (error) { failures.push(error); }
      }
      try { await evaluateNative(this.webview, "(() => {const state=window.__trinityAccountTap;if(state)document.removeEventListener('click',state.listener,true);delete window.__trinityAccountTap;return true})()"); } catch (error) { failures.push(error); }
      try { await this.owner.apply(); } catch (error) { failures.push(error); }
      if (actionError !== undefined) failures.unshift(actionError);
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, 'Native account action and cleanup failed');
    }
  }

  async key(key: AndroidKeyboardKey): Promise<void> {
    await pressAndroidKeyboardKey(this.device, key);
  }

  async hideKeyboard(): Promise<void> {
    const actionId = ++this.action;
    const flow = join(this.output, `accounts-hide-keyboard-${actionId}.yaml`);
    await writeFile(flow, 'appId: eu.qwky.trinity\n---\n- hideKeyboard\n');
    console.info(`[accounts] native action ${actionId}: hide keyboard`);
    let failure: unknown;
    try {
      await this.device.runFlow(flow, {});
    } catch (error) {
      failure = error;
    }
    try {
      await this.owner.apply();
    } catch (error) {
      if (failure !== undefined)
        throw new AggregateError(
          [failure, error],
          'Native keyboard dismissal and viewport restoration failed',
        );
      throw error;
    }
    if (failure !== undefined) throw failure;
  }

  installDocumentScript(source: string): Promise<() => Promise<void>> {
    return this.owner.installDocumentScript(source);
  }

  /** Only for the explicit focus preconditions in the canonical keyboard test. */
  async focusFixture(selector: string): Promise<void> {
    await this.visible(selector);
    await evaluateNative(this.webview, `(() => {document.querySelector(${JSON.stringify(selector)}).focus();return true})()`);
  }

  async openMenu(): Promise<void> {
    await this.tap('[data-testid="user-menu-trigger"]');
    await this.visible('.account-menu[role="menu"]');
  }

  async login(account: Account): Promise<void> {
    await this.fill('#homeserver', account.homeserver);
    await this.tap('button', { exactText: 'Continue' });
    await this.visible('#username', {}, 30_000);
    await this.fill('#username', account.username);
    await this.fill('#password', account.password);
    await this.tap('button', { exactText: 'Sign in' });
    await this.rooms(account);
  }

  async addAccount(account: Account): Promise<void> {
    await this.openMenu();
    await this.tap('[data-testid="add-account"]');
    await this.visible('[data-testid="cancel-add"]');
    await this.login(account);
  }

  async rooms(account: Account): Promise<void> {
    await waitForNativeShellState(() => this.surface(), surface => {
      const url = new URL(surface.url);
      return url.pathname.startsWith('/rooms') && url.searchParams.get('account') === `@${account.username}:localhost`;
    }, 'account-qualified Rooms surface', this.signal, 60_000);
    await this.activeAccountRooms(account);
  }

  /** Removal and reconnect cases assert the Rooms route and identity without a query requirement. */
  async activeAccountRooms(account: Account): Promise<void> {
    await waitForNativeShellState(() => this.surface(), surface => new URL(surface.url).pathname.startsWith('/rooms'), 'Rooms surface', this.signal, 60_000);
    await this.visible('trn-rooms', {}, 60_000);
    await this.waitElements('.userbar__handle', es => es.length === 1 && es[0]!.visible && es[0]!.text.includes(`@${account.username}:`), 'active account handle', {}, 20_000);
  }

  async resize(width: number, height: number): Promise<void> {
    await this.owner.apply({ width, height });
  }

  surface(): ReturnType<typeof readNativeShellSurface> { return readNativeShellSurface(this.webview); }

  async navigate(path: string): Promise<void> {
    await navigateNativeShell(this.webview, new URL(path, 'https://localhost').href, this.signal);
    await waitForNativeShellState(
      () => evaluateNative(this.webview, `document.title === 'Trinity' && [...document.querySelectorAll('#homeserver, #username, trn-rooms')].some(element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility === 'visible'; })`),
      visible => visible === true,
      'visible Account surface in the new document',
      this.signal,
    );
    await this.owner.apply();
  }

  async reload(): Promise<void> { await this.navigate((await this.surface()).url); }

  async capture(name: string): Promise<void> {
    await captureNativeShellProof(this.device, this.webview, this.output, name);
    await this.record(`${name}-surface`, await this.surface());
    await this.viewport?.apply();
  }

  async record(name: string, value: unknown): Promise<void> {
    await writeFile(join(this.output, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
  }
}
