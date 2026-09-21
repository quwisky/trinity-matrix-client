import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  type NativeShellApplicationId,
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
const WORD_SELECTION_MINIMUM_OBSERVED_MS = 450;

export interface AccountElement {
  readonly text: string;
  readonly renderedText: string;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly disabled: boolean;
  readonly value: string | null;
  readonly hasValue: boolean;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly attributes: Readonly<Record<string, string>>;
  readonly rect: { readonly x: number; readonly y: number; readonly width: number; readonly height: number; readonly right: number; readonly bottom: number };
  readonly style: {
    readonly backgroundColor: string;
    readonly display: string;
    readonly fontSize: string;
    readonly fontWeight: string;
    readonly opacity: string;
    readonly overflowY: string;
  };
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

interface WordSelectionMeasurement {
  readonly cssPoint: { readonly x: number; readonly y: number };
  readonly valueLength: number;
  readonly wordStart: number;
  readonly wordEnd: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly focused: boolean;
}

export interface NativeWordSelectionProof {
  readonly nativePoint: NativeTargetPoint;
  readonly valueLength: number;
  readonly wordStart: number;
  readonly wordEnd: number;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  readonly focused: boolean;
  readonly requestedDurationMs: number;
  readonly observedDurationMs: number;
}

export type NativeSwipeDirection =
  | 'decrease-scroll-top'
  | 'increase-scroll-top';

export interface NativeSwipeProof {
  readonly selector: string;
  readonly direction: NativeSwipeDirection;
  readonly durationMs: number;
  readonly cssStart: { readonly x: number; readonly y: number };
  readonly cssEnd: { readonly x: number; readonly y: number };
  readonly nativeStart: NativeTargetPoint;
  readonly nativeEnd: NativeTargetPoint;
  readonly beforeScrollTop: number;
  readonly afterScrollTop: number;
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
  readonly applicationId: NativeShellApplicationId;

  constructor(
    device: MaestroDevice,
    workspaceRoot: string,
    output: string,
    signal: AbortSignal,
    applicationId: NativeShellApplicationId = 'eu.qwky.trinity',
  ) {
    this.device = device;
    this.workspaceRoot = workspaceRoot;
    this.output = output;
    this.signal = signal;
    this.applicationId = applicationId;
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
    assert.equal(
      await this.device.adb('shell', 'pm', 'clear', this.applicationId),
      'Success',
    );
    await this.device.adb(
      'shell',
      'pm',
      'grant',
      this.applicationId,
      'android.permission.POST_NOTIFICATIONS',
    );
    this.active = await startNativeShellClient(
      this.device,
      this.applicationId,
      this.signal,
    );
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
      this.applicationId,
    );
    this.active = await startNativeShellClient(
      this.device,
      this.applicationId,
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
          text: e.textContent?.trim() ?? '', renderedText: e instanceof HTMLElement ? e.innerText.trim() : e.textContent?.trim() ?? '', visible: r.width > 0 && r.height > 0 && style.visibility === 'visible',
          focused: document.activeElement === e, disabled: e.matches(':disabled'),
          value:
            e instanceof HTMLTextAreaElement ||
            (e instanceof HTMLInputElement && e.type !== 'password')
              ? e.value
              : null,
          hasValue:
            (e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement) &&
            e.value.length > 0,
          selectionStart:
            e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement
              ? e.selectionStart
              : null,
          selectionEnd:
            e instanceof HTMLTextAreaElement || e instanceof HTMLInputElement
              ? e.selectionEnd
              : null,
          attributes: Object.fromEntries([...e.attributes].filter(a => ['id', 'class', 'href', 'role', 'max', 'data-mid', 'data-testid', 'data-disabled', 'data-autofocus', 'aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded', 'aria-live'].includes(a.name)).map(a => [a.name,a.value])),
          rect: {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom},
          style: {backgroundColor:style.backgroundColor,display:style.display,fontSize:style.fontSize,fontWeight:style.fontWeight,opacity:style.opacity,overflowY:style.overflowY},
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
    const [target] = await this.waitElements(
      selector,
      elements =>
        elements.length === 1 &&
        elements[0]!.visible &&
        elements[0]!.value !== null,
      `one visible input ${selector}`,
      filter,
    );
    assert(target);
    if (target.focused) {
      await this.key('tab');
      await this.waitElements(
        selector,
        elements => elements.length === 1 && !elements[0]!.focused,
        `native Tab moved focus away from ${selector}`,
        filter,
      );
    }
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
      `appId: ${this.applicationId}\n---\n- swipe:\n    start: "${point.x},${point.y}"\n    end: "${point.x + LONG_PRESS_DRIFT_PX},${point.y}"\n    duration: ${LONG_PRESS_DURATION_MS}\n`,
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

  /**
   * Select one exact word through Android's native long-press gesture.
   *
   * Renderer access only measures the glyph point and observes the resulting
   * selection. It never focuses the input or mutates its selection range.
   */
  async selectWordCurrent(
    selector: string,
    expectedValue: string,
    word: string,
  ): Promise<NativeWordSelectionProof> {
    assert(word.length > 0, 'Native word selection needs a non-empty word');
    this.signal.throwIfAborted();
    await this.owner.apply();
    const measured = await waitForNativeShellState(
      () =>
        evaluateNative(this.webview, `(() => {
          const {selector,expectedValue,word}=${JSON.stringify({ selector, expectedValue, word })};
          const input=document.querySelector(selector);
          if(!(input instanceof HTMLTextAreaElement)||input.value!==expectedValue||document.activeElement!==input)return null;
          const wordStart=input.value.indexOf(word);
          if(wordStart<0||input.value.lastIndexOf(word)!==wordStart)return null;
          const style=getComputedStyle(input),rect=input.getBoundingClientRect();
          if(rect.width<=0||rect.height<=0||style.visibility!=='visible')return null;
          const canvas=new OffscreenCanvas(1,1),context=canvas.getContext('2d');
          if(!context)return null;
          context.font=style.font;
          const spacing=Number.parseFloat(style.letterSpacing)||0;
          const prefix=input.value.slice(0,wordStart);
          const prefixWidth=context.measureText(prefix).width+spacing*prefix.length;
          const wordWidth=context.measureText(word).width+spacing*Math.max(0,word.length-1);
          const borderLeft=Number.parseFloat(style.borderLeftWidth)||0;
          const borderTop=Number.parseFloat(style.borderTopWidth)||0;
          const paddingLeft=Number.parseFloat(style.paddingLeft)||0;
          const paddingTop=Number.parseFloat(style.paddingTop)||0;
          const fontSize=Number.parseFloat(style.fontSize)||16;
          const parsedLineHeight=Number.parseFloat(style.lineHeight);
          const lineHeight=Number.isFinite(parsedLineHeight)?parsedLineHeight:fontSize*1.2;
          const cssPoint={
            x:rect.left+borderLeft+paddingLeft+prefixWidth+wordWidth/2-input.scrollLeft,
            y:rect.top+borderTop+paddingTop+lineHeight/2-input.scrollTop,
          };
          if(cssPoint.x<rect.left||cssPoint.x>rect.right||cssPoint.y<rect.top||cssPoint.y>rect.bottom)return null;
          return {cssPoint,valueLength:input.value.length,wordStart,wordEnd:wordStart+word.length,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,focused:true};
        })()`),
      (value) => value !== null,
      `measurable exact native word inside ${selector}`,
      this.signal,
      15_000,
    );
    assert(measured && typeof measured === 'object');
    const initial = measured as WordSelectionMeasurement;
    const point = await this.owner.nativePoint(initial.cssPoint);
    const actionId = ++this.action;
    const flow = join(this.output, `accounts-word-selection-${actionId}.yaml`);
    await writeFile(
      flow,
      `appId: ${this.applicationId}\n---\n- swipe:\n    start: "${point.x},${point.y}"\n    end: "${point.x + LONG_PRESS_DRIFT_PX},${point.y}"\n    duration: ${LONG_PRESS_DURATION_MS}\n`,
    );
    await evaluateNative(this.webview, `(() => {
      const selector=${JSON.stringify(selector)},element=document.querySelector(selector),types=['pointerdown','pointermove','pointerup','pointercancel'];
      if(!(element instanceof HTMLTextAreaElement))throw new Error('Native word-selection target changed before dispatch');
      const state={events:[],types,listener:event=>state.events.push({type:event.type,trusted:event.isTrusted,matched:element.contains(event.target),pointerId:event.pointerId,timeStamp:event.timeStamp,clientX:event.clientX,clientY:event.clientY})};
      window.__trinityAccountWordSelection=state;
      for(const type of types)document.addEventListener(type,state.listener,true);
      return true;
    })()`);

    let actionError: unknown;
    let trustedEvents: unknown[] = [];
    let observedDurationMs = 0;
    let proof: NativeWordSelectionProof | undefined;
    try {
      console.info(
        `[accounts] native action ${actionId}: exact word selection ${selector}`,
      );
      await this.device.runFlow(flow, {});
      const events = await evaluateNative(
        this.webview,
        'window.__trinityAccountWordSelection?.events ?? []',
      );
      assert(Array.isArray(events), 'Native word-selection events are an array');
      trustedEvents = events;
      const down = events.find(
        (event) =>
          event?.type === 'pointerdown' &&
          event.trusted === true &&
          event.matched === true,
      );
      assert(down, `Native word selection ${actionId} started on ${selector}`);
      const terminal = events.find(
        (event) =>
          (event?.type === 'pointerup' || event?.type === 'pointercancel') &&
          event.trusted === true &&
          event.pointerId === down.pointerId,
      );
      assert(terminal, `Native word selection ${actionId} completed`);
      const samePointerEvents = events.filter(
        (event) =>
          event?.trusted === true &&
          event.pointerId === down.pointerId &&
          Number.isFinite(event.timeStamp),
      );
      observedDurationMs =
        Math.max(...samePointerEvents.map((event) => event.timeStamp)) -
        down.timeStamp;
      assert(
        observedDurationMs >= WORD_SELECTION_MINIMUM_OBSERVED_MS,
        `Native word selection ${actionId} exposed at least ${WORD_SELECTION_MINIMUM_OBSERVED_MS} ms of its trusted 750 ms gesture before Android selection takeover`,
      );
      const selected = await waitForNativeShellState(
        () =>
          evaluateNative(this.webview, `(() => {
            const {selector,expectedValue}=${JSON.stringify({ selector, expectedValue })},input=document.querySelector(selector);
            return input instanceof HTMLTextAreaElement?{valueMatches:input.value===expectedValue,valueLength:input.value.length,selectionStart:input.selectionStart,selectionEnd:input.selectionEnd,focused:document.activeElement===input}:null;
          })()`),
        (value) => {
          const observed = value as
            | {
                valueMatches: boolean;
                valueLength: number;
                selectionStart: number;
                selectionEnd: number;
                focused: boolean;
              }
            | null;
          return (
            observed?.valueMatches === true &&
            observed.valueLength === initial.valueLength &&
            observed.selectionStart === initial.wordStart &&
            observed.selectionEnd === initial.wordEnd &&
            observed.focused === true
          );
        },
        `exact native selection ${initial.wordStart}..${initial.wordEnd}`,
        this.signal,
        15_000,
      );
      assert(selected && typeof selected === 'object');
      const observed = selected as {
        readonly valueLength: number;
        readonly selectionStart: number;
        readonly selectionEnd: number;
        readonly focused: boolean;
      };
      proof = {
        nativePoint: point,
        valueLength: observed.valueLength,
        wordStart: initial.wordStart,
        wordEnd: initial.wordEnd,
        selectionStart: observed.selectionStart,
        selectionEnd: observed.selectionEnd,
        focused: observed.focused,
        requestedDurationMs: LONG_PRESS_DURATION_MS,
        observedDurationMs,
      };
    } catch (error) {
      actionError = error;
    } finally {
      const failures: unknown[] = [];
      try {
        await this.record(`word-selection-${actionId}`, {
          selector,
          nativePoint: point,
          valueLength: initial.valueLength,
          wordLength: word.length,
          expectedSelection: {
            start: initial.wordStart,
            end: initial.wordEnd,
          },
          initialSelection: {
            start: initial.selectionStart,
            end: initial.selectionEnd,
          },
          proof: proof ?? null,
          requestedDurationMs: LONG_PRESS_DURATION_MS,
          observedDurationMs,
          trustedEvents,
        });
      } catch (error) {
        failures.push(error);
      }
      try {
        await evaluateNative(
          this.webview,
          "(() => {const state=window.__trinityAccountWordSelection;if(state)for(const type of state.types)document.removeEventListener(type,state.listener,true);delete window.__trinityAccountWordSelection;return true})()",
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
          'Native word selection and cleanup failed',
        );
      }
    }
    assert(proof, 'Native word selection produced exact observed proof');
    return proof;
  }

  async tapDocumentTrigger(selector: string, fileInputSelector: string): Promise<void> {
    await this.nativeAction('accounts-current-point-tap', selector, {}, {}, {
      currentPoint: true,
      fileInputSelector,
    });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.nativeAction(
      'accounts-current-point-fill',
      selector,
      {},
      { SECRET_TEXT: value },
      { allowFocusedInput: true, currentPoint: true },
    );
    const matches = await evaluateNative(this.webview, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
    assert.equal(matches, true, `Native input reached ${selector}`);
  }

  /** Fill a product-autofocused input without allowing IME auto-capitalisation. */
  async fillFocused(selector: string, value: string): Promise<void> {
    const valueDescription = `Native focused input reached ${selector}`;
    const waitForValue = async (): Promise<void> => {
      await waitForNativeShellState(
        () =>
          evaluateNative(
            this.webview,
            `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`,
          ),
        (matches) => matches === true,
        valueDescription,
        this.signal,
        15_000,
      );
    };
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.focused(selector);
      const actionId = ++this.action;
      console.info(
        `[accounts] native action ${actionId}: focused fill ${selector}`,
      );
      let failure: unknown;
      try {
        await this.device.runFlow(
          join(
            this.workspaceRoot,
            'e2e/android/flows/accounts-focused-fill.yaml',
          ),
          { APP_ID: this.applicationId, SECRET_TEXT: `x${value}` },
        );
        await this.key('home');
        await this.key('forwardDelete');
        // Removing the anti-capitalisation sentinel leaves Android's caret at
        // offset zero. Restore it to the end and emit a final native input event
        // there so caret-sensitive autocompletes observe the completed value.
        await this.key('end');
        await this.key('space');
        await this.key('backspace');
        await this.hideKeyboard();
      } catch (error) {
        failure = error;
      }
      try {
        await this.waitForFullViewportNativeBounds();
      } catch (error) {
        if (failure !== undefined)
          throw new AggregateError(
            [failure, error],
            'Native focused fill and viewport restoration failed',
          );
        throw error;
      }
      if (failure !== undefined) throw failure;
      try {
        await waitForValue();
        return;
      } catch (error) {
        let unsettledError = error;
        const observed = await evaluateNative(
          this.webview,
          `(() => {
            const selector=${JSON.stringify(selector)},expected=${JSON.stringify(value)},input=document.querySelector(selector);
            const current=input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement?input.value:null;
            const caseCorrections=[];
            let caseOnlyCorrectable=selector==='trn-alert-dialog input'&&input instanceof HTMLInputElement&&input.type!=='password'&&current!==null&&current.length===expected.length;
            if(caseOnlyCorrectable){
              for(let index=0;index<expected.length;index+=1){
                if(current[index]===expected[index])continue;
                const expectedCode=expected.codePointAt(index);
                if(expectedCode>=97&&expectedCode<=122&&current[index]?.toLocaleLowerCase()===expected[index])caseCorrections.push({index,keyCode:29+expectedCode-97});
                else caseOnlyCorrectable=false;
              }
              caseOnlyCorrectable=caseOnlyCorrectable&&caseCorrections.length>0;
            }
            return {
              present:current!==null,
              focused:document.activeElement===input,
              length:current?.length??null,
              expectedLength:expected.length,
              sentinelPresent:current===\`x\${expected}\`,
              trailingSpacePresent:current===\`\${expected} \`,
              sameIgnoringCase:current?.toLocaleLowerCase()===expected.toLocaleLowerCase(),
              caseOnlyCorrectable,
              caseCorrections,
              selectionStart:input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement?input.selectionStart:null,
              selectionEnd:input instanceof HTMLInputElement||input instanceof HTMLTextAreaElement?input.selectionEnd:null
            };
          })()`,
        );
        assert(observed && typeof observed === 'object');
        const state = observed as {
          readonly present: boolean;
          readonly focused: boolean;
          readonly length: number | null;
          readonly expectedLength: number;
          readonly sentinelPresent: boolean;
          readonly trailingSpacePresent: boolean;
          readonly sameIgnoringCase: boolean;
          readonly caseOnlyCorrectable: boolean;
          readonly caseCorrections: readonly {
            readonly index: number;
            readonly keyCode: number;
          }[];
          readonly selectionStart: number | null;
          readonly selectionEnd: number | null;
        };
        assert(
          Array.isArray(state.caseCorrections) &&
            state.caseCorrections.every(
              (correction) =>
                Number.isSafeInteger(correction.index) &&
                correction.index >= 0 &&
                Number.isSafeInteger(correction.keyCode) &&
                correction.keyCode >= 29 &&
                correction.keyCode <= 54,
          ),
          'Native focused fill case corrections are valid Android key events',
        );
        console.warn(
          `[accounts] native focused fill for ${selector} remained unsettled: ${JSON.stringify({
            present: state.present,
            focused: state.focused,
            lengthMatches: state.length === state.expectedLength,
            sentinelPresent: state.sentinelPresent,
            trailingSpacePresent: state.trailingSpacePresent,
            sameIgnoringCase: state.sameIgnoringCase,
            caseOnlyCorrectable: state.caseOnlyCorrectable,
            selectionAtEnd:
              state.selectionStart === state.length &&
              state.selectionEnd === state.length,
            caseCorrectionCount: state.caseCorrections.length,
          })}`,
        );
        if (
          state.caseOnlyCorrectable &&
          state.caseCorrections.length > 0
        ) {
          console.warn(
            `[accounts] correcting native letter case for ${selector}`,
          );
          for (const correction of state.caseCorrections) {
            await this.key('home');
            for (let offset = 0; offset < correction.index; offset += 1)
              await this.key('arrowRight');
            await this.key('forwardDelete');
            await this.device.adb(
              'shell',
              'input',
              'keyevent',
              String(correction.keyCode),
            );
          }
          await this.key('end');
          await this.hideKeyboard();
          try {
            await waitForValue();
            return;
          } catch (correctionError) {
            unsettledError = correctionError;
          }
        }
        if (
          attempt === 2 ||
          !(unsettledError instanceof Error) ||
          !unsettledError.message.startsWith(
            `Timed out waiting for ${valueDescription}`,
          )
        )
          throw unsettledError;
        console.warn(
          `[accounts] retrying native focused fill for ${selector} after unsettled input`,
        );
      }
    }
  }

  /** Replace a prefilled value after moving the native caret to its exact end. */
  async replace(selector: string, value: string): Promise<void> {
    await this.tapCurrent(selector);
    await this.key('end');
    await this.device.runFlow(
      join(this.workspaceRoot, 'e2e/android/flows/accounts-focused-fill.yaml'),
      { APP_ID: this.applicationId, SECRET_TEXT: value },
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
        { APP_ID: this.applicationId, POINT_URL: pointEndpoint.url },
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
      await writeFile(flow, `appId: ${this.applicationId}\n---\n- swipe:\n    start: "${start.x},${start.y}"\n    end: "${end.x},${end.y}"\n    duration: 600\n`);
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

  /**
   * Swipe inside one measured scroll container with native Maestro input.
   *
   * Renderer access only measures the target and observes its offset. Both
   * points are transformed by the active viewport owner before the ignored
   * concrete Maestro flow is written.
   */
  async swipeCurrent(
    selector: string,
    options: {
      readonly direction: NativeSwipeDirection;
      readonly durationMs?: number;
    },
  ): Promise<NativeSwipeProof> {
    this.signal.throwIfAborted();
    await this.owner.apply();
    const before = await this.visible(selector);
    const viewport = await this.visible('html');
    assert(
      before.scrollHeight > before.clientHeight,
      'Native swipe target must be scrollable',
    );
    const visibleTop = Math.max(before.rect.y, 0);
    const visibleBottom = Math.min(before.rect.bottom, viewport.clientHeight);
    const visibleLeft = Math.max(before.rect.x, 0);
    const visibleRight = Math.min(before.rect.right, viewport.rect.width);
    const visibleHeight = visibleBottom - visibleTop;
    const visibleWidth = visibleRight - visibleLeft;
    assert(visibleHeight >= 80, 'Native swipe target needs 80 CSS px of height');
    assert(visibleWidth >= 16, 'Native swipe target needs 16 CSS px of width');
    const durationMs = options.durationMs ?? 600;
    assert(
      durationMs >= 300 && durationMs <= 1_500,
      'Native swipe duration must stay between 300 and 1500 ms',
    );
    const x = Math.round(visibleLeft + visibleWidth / 2);
    const upper = Math.round(visibleTop + visibleHeight * 0.2);
    const lower = Math.round(visibleBottom - visibleHeight * 0.2);
    assert(lower - upper >= 40, 'Native swipe needs 40 CSS px of travel');
    const decreases = options.direction === 'decrease-scroll-top';
    const cssStart = { x, y: decreases ? upper : lower };
    const cssEnd = { x, y: decreases ? lower : upper };
    const start = await this.owner.nativePoint(cssStart);
    const end = await this.owner.nativePoint(cssEnd);
    for (const point of [start, end]) {
      assert(
        Number.isInteger(point.x) && Number.isInteger(point.y),
        'Native swipe coordinates must be exact integers',
      );
    }
    const actionId = ++this.action;
    const flow = join(this.output, `accounts-point-swipe-${actionId}.yaml`);
    await writeFile(
      flow,
      `appId: ${this.applicationId}\n---\n- swipe:\n    start: "${start.x},${start.y}"\n    end: "${end.x},${end.y}"\n    duration: ${durationMs}\n`,
    );
    let failure: unknown;
    try {
      await this.device.runFlow(flow, {});
    } catch (error) {
      failure = error;
    }
    try {
      await this.owner.apply();
    } catch (error) {
      if (failure !== undefined) {
        throw new AggregateError(
          [failure, error],
          'Native swipe and viewport restoration failed',
        );
      }
      throw error;
    }
    if (failure !== undefined) throw failure;
    const [after] = await this.waitElements(
      selector,
      (rows) =>
        rows.length === 1 &&
        (options.direction === 'decrease-scroll-top'
          ? rows[0]!.scrollTop < before.scrollTop
          : rows[0]!.scrollTop > before.scrollTop),
      'native swipe changed its offset in the expected direction',
    );
    assert(after);
    const scrollTop = after.scrollTop;
    assert(
      options.direction === 'decrease-scroll-top'
        ? scrollTop < before.scrollTop
        : scrollTop > before.scrollTop,
      'Native swipe changed its offset in the expected direction',
    );
    const proof: NativeSwipeProof = {
      selector,
      direction: options.direction,
      durationMs,
      cssStart,
      cssEnd,
      nativeStart: start,
      nativeEnd: end,
      beforeScrollTop: before.scrollTop,
      afterScrollTop: scrollTop,
    };
    await this.record(`native-swipe-${actionId}`, proof);
    return proof;
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
    const readInputValueMatches = async (): Promise<boolean | undefined> => {
      if (!allowFocusedInput) return undefined;
      const expected = variables['SECRET_TEXT'];
      assert.notEqual(
        expected,
        undefined,
        `Native fill has an expected value for ${selector}`,
      );
      const matches = await evaluateNative(
        this.webview,
        `(() => {
          const {selector,filter,expected}=${JSON.stringify({ selector, filter, expected })};
          const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
          return es.length===1&&(es[0] instanceof HTMLInputElement||es[0] instanceof HTMLTextAreaElement)&&es[0].value===expected;
        })()`,
      );
      assert.equal(typeof matches, 'boolean');
      return matches as boolean;
    };
    const initialPoint = await resolvePoint();
    const initialInputValueMatches = await readInputValueMatches();
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
      const flowVariables: Record<string, string> = { APP_ID: this.applicationId, POINT: `${initialPoint.x},${initialPoint.y}`, ...variables };
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
        const inputValueMatches = await readInputValueMatches();
        const inputValueChanged =
          initialInputValueMatches === false && inputValueMatches === true;
        assert(
          target.length === 1 &&
            (target[0]!.focused || inputValueChanged),
          `Native input ${actionId} focused or changed ${selector}`,
        );
        if (!target[0]!.focused && inputValueChanged) {
          await this.device.adb(
            'shell',
            'am',
            'start',
            '-n',
            `${this.applicationId}/eu.qwky.trinity.MainActivity`,
          );
          await waitForNativeShellState(
            () => this.surface(),
            (surface) => surface.visibility === 'visible',
            `foreground ${this.applicationId} after native fill`,
            this.signal,
            30_000,
          );
        }
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

  private async waitForFullViewportNativeBounds(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      this.signal.throwIfAborted();
      await this.owner.apply();
      const dimensions = await evaluateNative(
        this.webview,
        '({ width: innerWidth, height: innerHeight })',
      );
      assert(
        dimensions &&
          typeof dimensions === 'object' &&
          'width' in dimensions &&
          typeof dimensions.width === 'number' &&
          dimensions.width > 0 &&
          'height' in dimensions &&
          typeof dimensions.height === 'number' &&
          dimensions.height > 0,
        'Current Account viewport dimensions are available',
      );
      try {
        await this.owner.nativePoint({
          x: dimensions.width / 2,
          y: dimensions.height - 1,
        });
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !==
            'Native point is outside the attached WebView bounds'
        )
          throw error;
      }
      await delay(100, undefined, { signal: this.signal });
    }
    throw new Error(
      'Timed out waiting for full native WebView bounds after keyboard dismissal',
    );
  }

  async hideKeyboard(): Promise<void> {
    const actionId = ++this.action;
    const inputMethod = await this.device.adb(
      'shell',
      'dumpsys',
      'input_method',
    );
    const shown = /mInputShown=true/u.test(inputMethod);
    await this.record(`keyboard-dismiss-${actionId}`, {
      shownBefore: shown,
      action: shown ? 'maestro-hideKeyboard' : 'already-hidden',
    });
    if (!shown) {
      console.info(
        `[accounts] native action ${actionId}: keyboard already hidden`,
      );
      await this.waitForFullViewportNativeBounds();
      return;
    }
    const flow = join(this.output, `accounts-hide-keyboard-${actionId}.yaml`);
    await writeFile(
      flow,
      `appId: ${this.applicationId}\n---\n- hideKeyboard\n`,
    );
    console.info(`[accounts] native action ${actionId}: hide keyboard`);
    let failure: unknown;
    try {
      await this.device.runFlow(flow, {});
    } catch (error) {
      failure = error;
    }
    try {
      await this.waitForFullViewportNativeBounds();
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
