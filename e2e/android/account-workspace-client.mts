import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaestroDevice } from './maestro-session.mts';
import { openMaestroViewport, type MaestroViewport, type MaestroViewportOptions } from './maestro-viewport.mts';
import { pressAndroidKeyboardKey, type AndroidKeyboardKey } from './maestro-keyboard.mts';
import {
  captureNativeShellProof,
  evaluateNative,
  navigateNativeShell,
  readNativeShellSurface,
  startNativeShellClient,
  waitForNativeShellState,
} from './native-shell-client.mts';
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
          value: e instanceof HTMLInputElement && e.type !== 'password' ? e.value : null,
          attributes: Object.fromEntries([...e.attributes].filter(a => ['id', 'role', 'data-testid', 'data-disabled', 'data-autofocus', 'aria-checked', 'aria-current', 'aria-disabled', 'aria-expanded'].includes(a.name)).map(a => [a.name,a.value])),
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

  async fill(selector: string, value: string): Promise<void> {
    await this.nativeAction('accounts-point-fill', selector, {}, { SECRET_TEXT: value });
    const matches = await evaluateNative(this.webview, `document.querySelector(${JSON.stringify(selector)})?.value === ${JSON.stringify(value)}`);
    assert.equal(matches, true, `Native input reached ${selector}`);
  }

  async scrollIntoViewIfNeeded(selector: string, container: string): Promise<void> {
    for (let gesture = 0; gesture < 8; gesture++) {
      await this.owner.apply();
      const row = await this.visible(selector);
      const list = await this.visible(container);
      const center = row.rect.y + row.rect.height / 2;
      if (row.unobstructedCenter && center >= list.rect.y && center <= list.rect.bottom) return;
      assert(list.scrollHeight > list.clientHeight, 'Clipped account row needs a scrollable list');
      const top = list.rect.y + list.rect.height * 0.2;
      const bottom = list.rect.bottom - list.rect.height * 0.2;
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

  private async nativeAction(flow: string, selector: string, filter: AccountElementFilter, variables: Readonly<Record<string, string>> = {}): Promise<void> {
    await this.owner.apply();
    const es = await this.waitElements(selector, es => es.length === 1 && es[0]!.visible && !es[0]!.disabled && es[0]!.unobstructedCenter, `one actionable ${selector}`, filter);
    const r = es[0]!.rect;
    const point = await this.owner.nativePoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    const actionId = ++this.action;
    // Observe capture before application listeners can remove the clicked element.
    await evaluateNative(this.webview, `(() => {
      const {selector,filter}=${JSON.stringify({ selector, filter })};
      const es=[...document.querySelectorAll(selector)].filter(e=>(filter.text===undefined||(e.textContent??'').includes(filter.text))&&(filter.exactText===undefined||e.textContent?.trim()===filter.exactText));
      if(es.length!==1)throw new Error('Native target changed before dispatch');
      const element=es[0];
      window.__trinityAccountTap={events:[],listener:e=>window.__trinityAccountTap.events.push({trusted:e.isTrusted,matched:element.contains(e.target)})};
      document.addEventListener('click',window.__trinityAccountTap.listener,true);
      return true;
    })()`);
    let actionError: unknown;
    try {
      console.info(`[accounts] native action ${actionId}: ${flow} ${selector}`);
      await this.device.runFlow(join(this.workspaceRoot, `e2e/android/flows/${flow}.yaml`), { APP_ID: 'eu.qwky.trinity', POINT: `${point.x},${point.y}`, ...variables });
      const events = await evaluateNative(this.webview, 'window.__trinityAccountTap?.events ?? []');
      assert(Array.isArray(events));
      assert(events.some(event => event && typeof event === 'object' && event.trusted === true && event.matched === true), `Native action ${actionId} activated ${selector}`);
      assert(events.every(event => event && typeof event === 'object' && event.matched === true), `Native action ${actionId} hit only ${selector}`);
    } catch (error) {
      actionError = error;
    } finally {
      const failures: unknown[] = [];
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
