import { existsSync, readFileSync } from 'node:fs';
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
