import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(root, path), 'utf8');
const client = read('e2e/android/account-workspace-client.mts');
const flow = (name) => read(`e2e/android/flows/${name}.yaml`);
const between = (text, start, end) => {
  const from = text.indexOf(start);
  expect(from, start).toBeGreaterThan(-1);
  const to = text.indexOf(end, from + start.length);
  expect(to, end).toBeGreaterThan(from);
  return text.slice(from, to);
};
const ordered = (text, needles) => {
  let position = -1;
  for (const needle of needles) {
    const next = text.indexOf(needle, position + 1);
    expect(next, needle).toBeGreaterThan(position);
    position = next;
  }
};
const steps = (text) =>
  text
    .split('\n')
    .filter((line) => /^- /u.test(line))
    .map((line) => line.slice(2));

// Maestro's secret-variable pattern in e2e/android/maestro-session.mts.
const secretKey = /password|secret|token|recovery.?key|credential|uia/iu;

describe('Android Account client native actions', () => {
  it('taps once without Maestro settle heuristics and proves the click itself', () => {
    // Every tap measures its target when the flow taps: no flow taps a point
    // measured before Maestro started.
    expect(
      existsSync(resolve(root, 'e2e/android/flows/accounts-point-tap.yaml')),
    ).toBe(false);
    expect(client).not.toContain("'accounts-point-tap'");
    expect(between(client, '  async tap(', '  async tapCurrent(')).toContain(
      'await this.tapCurrent(selector, filter);',
    );
    for (const name of ['accounts-current-point-tap']) {
      const text = flow(name);
      expect(text).toContain('    retryTapIfNoChange: false\n');
      expect(text).toContain('    waitToSettleTimeoutMs: 1\n');
      expect(text).not.toMatch(/eraseText|hideKeyboard|inputText/u);
    }
    const action = between(
      client,
      '  private async nativeAction(',
      '  /**\n   * Read-only: the trusted clicks captured',
    );
    ordered(action, [
      'await this.device.runFlow(',
      'const events = await this.nativeActionEvents(',
      '`Native action ${actionId} activated ${selector}`',
      '`Native action ${actionId} hit only ${selector}`',
    ]);
    const events = between(
      client,
      '  private async nativeActionEvents(',
      '  /** Read-only: the current value length',
    );
    expect(events).toContain('Date.now() + NATIVE_OUTCOME_TIMEOUT_MS');
    expect(events).not.toMatch(/\.focus\s*\(|\.click\s*\(|dispatchEvent/u);
    expect(client).toContain('const NATIVE_OUTCOME_TIMEOUT_MS = 5_000;');
  });

  it('types after observed focus and erases exactly the characters it read', () => {
    expect(steps(flow('accounts-current-point-fill'))).toEqual([
      'evalScript: ${output.pointResponse = http.get(POINT_URL)}',
      'assertTrue: ${output.pointResponse.status === 200}',
      'tapOn:',
      'evalScript: ${output.readyResponse = http.get(READY_URL)}',
      'assertTrue: ${output.readyResponse.status === 200}',
      'inputText: ${SECRET_TEXT}',
    ]);
    expect(steps(flow('accounts-focused-fill'))).toEqual([
      'inputText: ${SECRET_TEXT}',
    ]);
    for (const name of [
      'accounts-current-point-fill',
      'accounts-focused-fill',
    ]) {
      ordered(flow(name), ['\n# ERASE_TEXT:', '\n- inputText: ${SECRET_TEXT}']);
      expect(flow(name)).not.toMatch(/eraseText|hideKeyboard|repeat:/u);
    }
    const materialize = between(
      client,
      '  private async eraseFlow(',
      '  /**\n   * Read-only: the trusted clicks captured',
    );
    ordered(materialize, [
      "'Native erase length is a non-negative integer'",
      '`Flow ${flow} has one ${marker} marker`',
      "count === 0 ? '' : `- eraseText:\\n    charactersToErase: ${count}\\n`",
      'join(this.output,',
    ]);
    const fill = between(
      client,
      '  async fill(',
      '  /**\n   * Fill a product-autofocused',
    );
    ordered(fill, [
      'const eraseCount = await this.inputLength(selector);',
      "'accounts-current-point-fill'",
      'readyForInput: true',
      'eraseCount,',
      'Native input reached ${selector}',
    ]);
    const ready = between(
      client,
      '  private async waitForInputReady(',
      '  /**\n   * Dismiss the soft keyboard',
    );
    expect(ready).toContain('document.activeElement===es[0]');
    expect(ready).toContain('focused === true && (await this.keyboardShown())');
    const focused = between(
      client,
      '  async fillFocused(',
      '  /** Read-only: wait until one input',
    );
    ordered(focused, [
      "await this.eraseFlow('accounts-focused-fill', {",
      'ERASE_TEXT: await this.inputLength(selector),',
      'await this.dismissKeyboard();',
      "await this.keyCombination('documentStart');",
    ]);
  });

  it('signs in with one native flow and keeps the signed-in proof', () => {
    const text = flow('accounts-sign-in');
    const urls = steps(text)
      .filter((step) => step.startsWith('evalScript:'))
      .map((step) => /http\.get\((\w+)\)/u.exec(step)?.[1]);
    expect(urls).toEqual([
      'HOMESERVER_POINT_URL',
      'HOMESERVER_READY_URL',
      'HOMESERVER_HIDDEN_URL',
      'CONTINUE_POINT_URL',
      'USERNAME_POINT_URL',
      'USERNAME_READY_URL',
      'USERNAME_HIDDEN_URL',
      'PASSWORD_POINT_URL',
      'PASSWORD_READY_URL',
      'PASSWORD_HIDDEN_URL',
      'SIGN_IN_POINT_URL',
    ]);
    // A slow device may still be closing the keyboard: the flow re-reads the
    // dismissal endpoint, which sends at most one Back per typed field.
    for (const field of ['HOMESERVER', 'USERNAME', 'PASSWORD']) {
      expect(text).toContain(
        `    while:\n      true: \${output.hidden.status !== 200}\n    commands:\n      - evalScript: \${output.hidden = http.get(${field}_HIDDEN_URL)}\n- assertTrue: \${output.hidden.status === 200}\n`,
      );
    }
    expect(steps(text).filter((step) => step === 'tapOn:')).toHaveLength(5);
    expect(text.match(/retryTapIfNoChange: false/gu)).toHaveLength(5);
    ordered(text, [
      'http.get(HOMESERVER_READY_URL)',
      '\n# ERASE_HOMESERVER:',
      'inputText: ${SECRET_HOMESERVER}',
      'http.get(CONTINUE_POINT_URL)',
      'http.get(USERNAME_POINT_URL)',
      'true: ${output.point.status !== 200}',
      'http.get(USERNAME_READY_URL)',
      'inputText: ${SECRET_USERNAME}',
      'http.get(PASSWORD_READY_URL)',
      'inputText: ${SECRET_PASSWORD}',
      'http.get(SIGN_IN_POINT_URL)',
    ]);
    // No unconditional Maestro Back: the next target's read dismisses the keyboard.
    expect(text).not.toMatch(/eraseText|hideKeyboard/u);
    for (const variable of text.match(/inputText: \$\{(\w+)\}/gu) ?? []) {
      expect(variable).toMatch(secretKey);
    }

    const login = between(
      client,
      '  async login(account: Account)',
      '  /** Read-only capture of trusted clicks',
    );
    ordered(login, [
      "await this.visible('#homeserver', {}, 60_000);",
      "const homeserverLength = await this.inputLength('#homeserver');",
      'await this.installSignInClickCapture();',
      'dismissal ??= this.sendBackWhileKeyboardShown()',
      'await this.waitForKeyboardHidden(operationSignal);',
      "'unchanged homeserver before native input'",
      "{ value: account.homeserver }, 'native homeserver input'",
      "'empty username before native input'",
      "{ value: account.username }, 'native username input'",
      "'empty password before native input'",
      "{ length: account.password.length }, 'native password input length'",
      "await this.eraseFlow('accounts-sign-in', {",
      'ERASE_HOMESERVER: homeserverLength,',
      'clicks = await this.readSignInClicks(timeOrigin);',
      '`sign-in-${actionId}`',
      "clicks.targets.every((target) => target !== 'other')",
      "clicks.targets.indexOf('continue') < clicks.targets.lastIndexOf('sign-in')",
      'await this.rooms(account);',
    ]);
    expect(login.match(/this\.device\.runFlow\(/gu)).toHaveLength(1);
    // Continue, password and Sign in reads each dismiss the preceding keyboard.
    expect(login.match(/await hidden\(operationSignal\);/gu)).toHaveLength(3);
    expect(login.trimEnd().endsWith('await this.rooms(account);\n  }')).toBe(
      true,
    );
    expect(login).not.toMatch(/this\.(?:fill|tap)\(/u);
  });

  it('keeps one native action per field in the suites that test login', () => {
    const byFields = between(
      client,
      '  async loginByFields(',
      '  async addAccount(',
    );
    ordered(byFields, [
      "await this.fill('#homeserver', account.homeserver);",
      "await this.tap('button', { exactText: 'Continue' });",
      "await this.visible('#username', {}, 30_000);",
      "await this.fill('#username', account.username);",
      "await this.fill('#password', account.password);",
      "await this.tap('button', { exactText: 'Sign in' });",
      'await this.rooms(account);',
    ]);
    const journeys = readdirSync(resolve(root, 'e2e/android')).filter((name) =>
      name.endsWith('.mts'),
    );
    const byFieldSuites = journeys.filter((name) =>
      read(`e2e/android/${name}`).includes('.loginByFields('),
    );
    expect(byFieldSuites.sort()).toEqual([
      'account-password-change-journeys.mts',
      'clear-all-data-journeys.mts',
      'recovery-reset-journeys.mts',
    ]);
    for (const name of byFieldSuites) {
      expect(read(`e2e/android/${name}`)).not.toMatch(/\bclient\.login\(/u);
    }
  });

  it('reads IME visibility as one device-filtered line, never the full dump', async () => {
    // The unfiltered dump is about 800 KB of Gboard state per poll; polling it
    // coincided with hosted emulators dropping the adb transport and forwards.
    const { ANDROID_IME_VISIBILITY_COMMAND, parseAndroidImeShown } =
      await import('../e2e/android/android-ime.mts');
    expect(ANDROID_IME_VISIBILITY_COMMAND).toBe(
      "dumpsys input_method 2>/dev/null | grep -m 1 -o 'mInputShown=[a-z]*' || true",
    );
    // The legacy `shell:` service (Playwright's Android backend) merges stderr
    // into stdout. Stopping dumpsys early writes a Broken pipe line to stderr,
    // so an unsilenced read is rejected rather than accepted by the parser.
    expect(() =>
      parseAndroidImeShown(
        'mInputShown=false\nFailed to write while dumping service input_method: Broken pipe\n',
      ),
    ).toThrow('Android reports its IME visibility');
    expect(parseAndroidImeShown('mInputShown=true\n')).toBe(true);
    expect(parseAndroidImeShown('mInputShown=false')).toBe(false);
    for (const output of ['', 'mInputShown=maybe', 'x mInputShown=true'])
      expect(() => parseAndroidImeShown(output)).toThrow(
        'Android reports its IME visibility',
      );

    // One implementation: every module under e2e/android reads the IME only
    // through the shared helper, and no flow or module sends the full dump.
    const files = [];
    const walk = (directory) => {
      for (const entry of readdirSync(resolve(root, directory), {
        withFileTypes: true,
      })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) walk(path);
        else if (/\.(?:mts|ts|mjs|js|yaml)$/u.test(entry.name))
          files.push(path);
      }
    };
    walk('e2e/android');
    const readers = files.filter((path) =>
      /input_method|mInputShown/u.test(read(path)),
    );
    expect(readers.sort()).toEqual(['e2e/android/android-ime.mts']);
    for (const path of [
      'e2e/android/account-workspace-client.mts',
      'e2e/android/fixtures.mts',
      'e2e/android/native-shell-journeys.mts',
    ]) {
      expect(read(path), path).toMatch(
        /parseAndroidImeShown\(\s*await [^;]*ANDROID_IME_VISIBILITY_COMMAND\)/u,
      );
    }

    const { AccountWorkspaceClient } =
      await import('../e2e/android/account-workspace-client.mts');
    const calls = [];
    let reply = 'mInputShown=true\n';
    const device = {
      adb: async (...args) => {
        calls.push(args);
        return reply;
      },
    };
    const reader = new AccountWorkspaceClient(
      device,
      root,
      root,
      new AbortController().signal,
    );
    await expect(reader.keyboardShown()).resolves.toBe(true);
    reply = 'mInputShown=false';
    await expect(reader.keyboardShown()).resolves.toBe(false);
    reply = '';
    await expect(reader.keyboardShown()).rejects.toThrow(
      'Android reports its IME visibility',
    );
    expect(calls).toEqual(
      Array(3).fill(['shell', ANDROID_IME_VISIBILITY_COMMAND]),
    );
  });

  it('dismisses the keyboard only while Android reports it shown', () => {
    const dismissal = between(
      client,
      '  private async dismissKeyboard(',
      '  async key(key: AndroidKeyboardKey)',
    );
    ordered(dismissal, [
      'const shownBefore = await this.keyboardShown();',
      'if (shownBefore) {',
      "await this.device.adb('shell', 'input', 'keyevent', '4');",
      '(shown) => !shown',
      'await this.waitForFullViewportNativeBounds();',
    ]);
    const hide = between(
      client,
      '  async hideKeyboard(',
      '  installDocumentScript(',
    );
    ordered(hide, [
      'const actionId = ++this.action;',
      '`keyboard-dismiss-${actionId}`',
      'await this.dismissKeyboard();',
    ]);
    expect(hide).not.toContain('runFlow');
  });
});

describe('Android shared stage Account', () => {
  const sharedSuites = [
    'message-swipe-journeys.mts',
    'room-access-policy-journeys.mts',
    'room-profile-settings-journeys.mts',
    'space-curation-create-join-journeys.mts',
    'space-settings-mobile-journeys.mts',
  ];
  // message-swipe does not follow the case-based shape below: it drives three
  // explicit `suite.shared.enter(...)` sites gated by `options.freshApp`
  // (see `launch` in message-swipe-journeys.mts), not `entry.profile ?? X` /
  // `const cases`. It gets its own pin further down.
  const caseBasedSuites = sharedSuites.filter(
    (name) => name !== 'message-swipe-journeys.mts',
  );

  it('signs in once, then relaunches the host and proves the same Account', async () => {
    const { SharedStageAccount } =
      await import('../e2e/android/account-workspace-client.mts');
    const calls = [];
    const client = {
      reset: async (profile) => calls.push(['reset', profile.width]),
      relaunch: async (profile) => calls.push(['relaunch', profile.width]),
      login: async (account) => calls.push(['login', account.userId]),
      activeAccountRooms: async (account) =>
        calls.push(['rooms', account.userId]),
    };
    let registered = 0;
    const fixtures = {
      account: async (role) => ({
        userId: `@${role}-${++registered}:localhost`,
      }),
    };
    const profile = { width: 393 };
    const shared = new SharedStageAccount('suite-shared');
    for (const fresh of [undefined, undefined, true, undefined]) {
      await shared.enter(client, profile, { fresh });
      const account = await shared.get(fixtures);
      await shared.signIn(client, account);
    }
    const account = '@suite-shared-1:localhost';
    expect(registered).toBe(1);
    expect(calls).toEqual([
      ['reset', 393],
      ['login', account],
      ['relaunch', 393],
      ['rooms', account],
      ['reset', 393],
      ['login', account],
      ['relaunch', 393],
      ['rooms', account],
    ]);
    await expect(
      shared.signIn(client, { userId: '@other:localhost' }),
    ).rejects.toThrow('Shared stage Account is the suite Account');
  });

  it('is used only by suites whose stages keep fresh Rooms of their own', () => {
    const journeys = readdirSync(resolve(root, 'e2e/android')).filter(
      (name) =>
        name.endsWith('-journeys.mts') &&
        read(`e2e/android/${name}`).includes('new SharedStageAccount('),
    );
    expect(journeys.sort()).toEqual(sharedSuites);
    for (const name of caseBasedSuites) {
      const text = read(`e2e/android/${name}`);
      expect(text.match(/new SharedStageAccount\(/gu), name).toHaveLength(1);
      // The runner attaches every stage through the shared Account.
      expect(text, name).toMatch(
        /await sharedAccount\.enter\(\s*client,\s*entry\.profile \?\? \w+,\s*\{\s*fresh:\s*entry\.freshApp\s*\},?\s*\)/u,
      );
      expect(text, name).not.toMatch(/\bclient\.reset\(/u);
      const start = text.indexOf('const cases');
      const cases = text.slice(start, text.indexOf('\n];', start));
      const bodies = cases.split(/\n {2}\{\n {4}id: '/u).slice(1);
      expect(bodies.length, name).toBeGreaterThanOrEqual(3);
      for (const body of bodies) {
        const id = body.slice(0, body.indexOf("'"));
        expect(body, `${name} ${id}`).toMatch(/fixtures\.createRoom\(/u);
        if (body.includes('freshApp: true')) {
          expect(body, `${name} ${id}`).not.toContain('sharedAccount.');
          expect(body, `${name} ${id}`).toMatch(/client\.login\(/u);
        } else {
          expect(
            body.match(/sharedAccount\.get\(fixtures\)/gu),
            `${name} ${id}`,
          ).toHaveLength(1);
          expect(
            body.match(/sharedAccount\.signIn\(client,\s*\w+\)/gu),
            `${name} ${id}`,
          ).toHaveLength(1);
          expect(body, `${name} ${id}`).not.toMatch(/client\.login\(/u);
        }
      }
    }

    // message-swipe's own pin: exactly one shared Account, every
    // `suite.shared.enter(...)` call carries the Pixel 5 profile, and
    // `fresh: true` appears exactly once, only on the freshApp path.
    const swipeName = 'message-swipe-journeys.mts';
    const swipeText = read(`e2e/android/${swipeName}`);
    expect(
      swipeText.match(/new SharedStageAccount\(/gu),
      swipeName,
    ).toHaveLength(1);
    const enters = swipeText.match(/suite\.shared\.enter\([^)]*\)/gu) ?? [];
    expect(enters.length, swipeName).toBe(3);
    for (const call of enters) {
      expect(call, swipeName).toContain('PIXEL_5_ACCOUNT_PROFILE');
    }
    expect(swipeText.match(/fresh: true/gu), swipeName).toHaveLength(1);
    const freshEnter = enters.find((call) => call.includes('fresh: true'));
    expect(freshEnter, swipeName).toBeDefined();
    const freshAppStart = swipeText.indexOf('if (options.freshApp) {');
    const freshAppEnd = swipeText.indexOf('} else {', freshAppStart);
    expect(freshAppStart, swipeName).toBeGreaterThan(-1);
    expect(freshAppEnd, swipeName).toBeGreaterThan(freshAppStart);
    const freshEnterPosition = swipeText.indexOf(freshEnter, freshAppStart);
    expect(freshEnterPosition, swipeName).toBeGreaterThan(freshAppStart);
    expect(freshEnterPosition, swipeName).toBeLessThan(freshAppEnd);
  });
});
