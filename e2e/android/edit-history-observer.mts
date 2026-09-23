import assert from 'node:assert/strict';
import type {
  AccountElement,
  AccountWorkspaceClient,
} from './account-workspace-client.mts';
import { evaluateNative } from './native-shell-client.mts';

export interface RevisionSnapshot {
  readonly label: string;
  readonly text: string;
  readonly inserted: readonly string[];
  readonly deleted: readonly string[];
  readonly strongInserted: readonly string[];
  readonly strongDeleted: readonly string[];
  readonly outsideStrongInserted: readonly string[];
  readonly outsideStrongDeleted: readonly string[];
  readonly strongText: readonly string[];
  readonly removeCount: number;
}

export interface EditHistorySnapshot {
  readonly visible: boolean;
  readonly rows: readonly RevisionSnapshot[];
  readonly togglePressed: string | null;
  readonly errorCount: number;
  readonly truncatedCount: number;
}

export interface FontProfile {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  readonly rootPx: number;
  readonly inlineRootSize: string;
}

export interface PixelGeometry extends FontProfile {
  readonly dialogWidth: number;
  readonly dialogHeight: number;
  readonly closeVisible: boolean;
  readonly closeWidth: number;
  readonly closeHeight: number;
  readonly dialogScrollWidth: number;
  readonly dialogClientWidth: number;
  readonly revisionsVisible: boolean;
  readonly revisionsScrollWidth: number;
  readonly revisionsClientWidth: number;
  readonly toggleVisible: boolean;
  readonly removeLeft: number;
  readonly removeTop: number;
  readonly removeRight: number;
  readonly removeBottom: number;
  readonly removeUnobstructed: boolean;
}

function object(value: unknown, description: string): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value),
    `${description} is an object`);
  return value as Record<string, unknown>;
}

function finiteFields(value: Record<string, unknown>, names: readonly string[]): void {
  for (const name of names)
    assert(typeof value[name] === 'number' && Number.isFinite(value[name]),
      `${name} is finite`);
}

function stringList(value: unknown, description: string): void {
  assert(Array.isArray(value) && value.every((item) => typeof item === 'string'),
    `${description} contains strings`);
}

function validateFontProfile(value: unknown): FontProfile {
  const result = object(value, 'Font profile');
  finiteFields(result, ['width', 'height', 'dpr', 'rootPx']);
  assert(typeof result['inlineRootSize'] === 'string', 'Inline root size is a string');
  assert((result['width'] as number) > 0 && (result['height'] as number) > 0 &&
    (result['dpr'] as number) > 0 && (result['rootPx'] as number) > 0,
    'Font profile dimensions and scale are positive');
  return result as unknown as FontProfile;
}

/** Query the actual WebView root without modifying its style or viewport. */
export async function readFontProfile(
  client: AccountWorkspaceClient,
): Promise<FontProfile> {
  const value = await evaluateNative(client.webview, `(() => {
    const root = document.documentElement;
    return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      rootPx: Number.parseFloat(getComputedStyle(root).fontSize),
      inlineRootSize: root.style.fontSize };
  })()`);
  return validateFontProfile(value);
}

/** Read exact revision text and markup placement; never drive the dialog. */
export async function readEditHistory(
  client: AccountWorkspaceClient,
): Promise<EditHistorySnapshot> {
  const value = await evaluateNative(client.webview, `(() => {
    const root = document.querySelector('[data-testid="edit-history"]');
    const rows = [...(root?.querySelectorAll('.revision') ?? [])];
    const text = (element) => element?.textContent?.trim() ?? '';
    const texts = (elements) => [...elements].map((element) => element.textContent ?? '');
    return {
      visible: !!root && root.getBoundingClientRect().width > 0,
      rows: rows.map((row) => ({
        label: text(row.querySelector('.revision__label')),
        text: text(row.querySelector('.revision__text')),
        inserted: texts(row.querySelectorAll('ins.diff-ins')),
        deleted: texts(row.querySelectorAll('del.diff-del')),
        strongInserted: texts(row.querySelectorAll('strong ins.diff-ins')),
        strongDeleted: texts(row.querySelectorAll('strong del.diff-del')),
        outsideStrongInserted: texts([...row.querySelectorAll('ins.diff-ins')]
          .filter((element) => !element.closest('strong'))),
        outsideStrongDeleted: texts([...row.querySelectorAll('del.diff-del')]
          .filter((element) => !element.closest('strong'))),
        strongText: texts(row.querySelectorAll('strong')),
        removeCount: row.querySelectorAll('[data-testid="revision-remove"]').length,
      })),
      togglePressed: root?.querySelector('[data-testid="edit-history-toggle"]')?.getAttribute('aria-pressed') ?? null,
      errorCount: root?.querySelectorAll('[data-testid="edit-history-error"]').length ?? 0,
      truncatedCount: root?.querySelectorAll('[data-testid="edit-history-truncated"]').length ?? 0,
    };
  })()`);
  const result = object(value, 'Edit-history snapshot');
  assert.equal(typeof result['visible'], 'boolean', 'Dialog visibility is boolean');
  assert(Array.isArray(result['rows']), 'Revision rows are an array');
  assert(result['togglePressed'] === null || typeof result['togglePressed'] === 'string',
    'Toggle state is a string or absent');
  finiteFields(result, ['errorCount', 'truncatedCount']);
  for (const value of result['rows']) {
    const row = object(value, 'Revision row');
    assert(typeof row['label'] === 'string' && typeof row['text'] === 'string',
      'Revision label and text are strings');
    for (const field of ['inserted', 'deleted', 'strongInserted', 'strongDeleted',
      'outsideStrongInserted', 'outsideStrongDeleted', 'strongText'])
      stringList(row[field], `Revision ${field}`);
    finiteFields(row, ['removeCount']);
  }
  return result as unknown as EditHistorySnapshot;
}

/** Read fullscreen and trailing-action geometry after a native-opened dialog. */
export async function readPixelGeometry(
  client: AccountWorkspaceClient,
): Promise<PixelGeometry> {
  const value = await evaluateNative(client.webview, `(() => {
    const root = document.documentElement;
    const dialog = document.querySelector('[data-testid="edit-history"]');
    const close = dialog?.querySelector('header [data-testid="edit-history-close"]');
    const revisions = dialog?.querySelector('.revisions');
    const toggle = dialog?.querySelector('[data-testid="edit-history-toggle"]');
    const removes = dialog?.querySelectorAll('[data-testid="revision-remove"]') ?? [];
    const remove = removes[removes.length - 1];
    if (!dialog || !close || !revisions || !toggle || !remove) return null;
    const visible = (element) => { const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'; };
    const dialogBox = dialog.getBoundingClientRect();
    const closeBox = close.getBoundingClientRect();
    const removeBox = remove.getBoundingClientRect();
    const centerX = (removeBox.left + removeBox.right) / 2;
    const centerY = (removeBox.top + removeBox.bottom) / 2;
    const hit = centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight
      ? document.elementFromPoint(centerX, centerY) : null;
    return {
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio,
      rootPx: Number.parseFloat(getComputedStyle(root).fontSize),
      inlineRootSize: root.style.fontSize,
      dialogWidth: dialogBox.width, dialogHeight: dialogBox.height,
      closeVisible: visible(close), closeWidth: closeBox.width, closeHeight: closeBox.height,
      dialogScrollWidth: dialog.scrollWidth, dialogClientWidth: dialog.clientWidth,
      revisionsVisible: visible(revisions), revisionsScrollWidth: revisions.scrollWidth,
      revisionsClientWidth: revisions.clientWidth, toggleVisible: visible(toggle),
      removeLeft: removeBox.left, removeTop: removeBox.top,
      removeRight: removeBox.right, removeBottom: removeBox.bottom,
      removeUnobstructed: !!hit && (hit === remove || remove.contains(hit)),
    };
  })()`);
  validateFontProfile(value);
  const result = object(value, 'Pixel geometry');
  finiteFields(result, ['dialogWidth', 'dialogHeight', 'closeWidth', 'closeHeight',
    'dialogScrollWidth', 'dialogClientWidth', 'revisionsScrollWidth',
    'revisionsClientWidth', 'removeLeft', 'removeTop', 'removeRight',
    'removeBottom']);
  for (const field of ['closeVisible', 'revisionsVisible', 'toggleVisible',
    'removeUnobstructed'])
    assert.equal(typeof result[field], 'boolean', `${field} is boolean`);
  return result as unknown as PixelGeometry;
}

export function assertHistoryOrder(
  labels: readonly string[],
  expected: readonly string[] = ['Original', 'Edited', 'Current version'],
): void {
  assert.deepEqual(labels, expected, 'Exact oldest-first revision labels');
}

export function assertPlainDiff(snapshot: EditHistorySnapshot): void {
  assert(snapshot.visible, 'Edit-history dialog is visible');
  assert.equal(snapshot.rows.length, 3, 'Plain history has three revisions');
  assertHistoryOrder(snapshot.rows.map((row) => row.label));
  assert.equal(snapshot.togglePressed, 'true', 'Highlights start enabled');
  assert.equal(snapshot.errorCount, 0, 'History has no error');
  assert.equal(snapshot.truncatedCount, 0, 'History is complete');
  assert.equal(snapshot.rows[0]!.inserted.length, 0, 'Original has no insertion');
  assert.equal(snapshot.rows[0]!.deleted.length, 0, 'Original has no deletion');
  assert(snapshot.rows[2]!.inserted.join(' ').includes('final'),
    'Final wording is inserted');
  assert(snapshot.rows[2]!.deleted.join(' ').includes('second'),
    'Second wording is deleted');
}

export function assertFormattedDiff(
  row: RevisionSnapshot,
  mode: 'on' | 'off' = 'on',
): void {
  if (mode === 'on') {
    assert.deepEqual(row.strongInserted, ['Mon'], 'Mon is inserted inside strong');
    assert.deepEqual(row.strongDeleted, ['Fri'], 'Fri is deleted inside strong');
    assert.deepEqual(row.outsideStrongInserted, [], 'No insertion escapes strong');
    assert.deepEqual(row.outsideStrongDeleted, [], 'No deletion escapes strong');
    assert(row.strongText.some((text) => text.includes('day')),
      'The bold run retains day');
    return;
  }
  assert.deepEqual(row.strongText, ['Monday'], 'Bold text is exactly Monday');
  assert.deepEqual(row.inserted, [], 'Highlight-off has no insertion markup');
  assert.deepEqual(row.deleted, [], 'Highlight-off has no deletion markup');
  assert(!row.text.includes('Fri '), 'Old Friday wording is absent');
}

export function assertPixelBaselineGeometry(value: PixelGeometry): void {
  for (const field of ['width', 'height', 'dpr', 'rootPx', 'dialogWidth',
    'dialogHeight', 'closeWidth', 'closeHeight', 'dialogScrollWidth',
    'dialogClientWidth', 'revisionsScrollWidth', 'revisionsClientWidth',
    'removeLeft', 'removeRight'] as const)
    assert(Number.isFinite(value[field]), `${field} is finite`);
  assert.equal(value.width, 393, 'Pixel 5 CSS width');
  assert.equal(value.height, 727, 'Pixel 5 CSS height');
  assert(Math.abs(value.dpr - 2.75) <= 0.000001,
    'Pixel 5 DPR is 2.75 within device floating-point precision');
  assert.equal(value.inlineRootSize, '', 'Root font has no inline override');
  assert(Math.abs(value.dialogWidth - 393) <= 1 &&
    Math.abs(value.dialogHeight - 727) <= 1, 'History fills the Pixel 5 viewport');
  assert(value.closeVisible && value.closeWidth >= 44 && value.closeHeight >= 44,
    'Close is visible and touch sized');
  assert(value.dialogScrollWidth <= value.dialogClientWidth,
    'Dialog has no horizontal overflow');
  assert(value.toggleVisible && value.revisionsVisible,
    'Toggle and reading region are visible');
}

export function assertPixelGeometry(value: PixelGeometry): void {
  assertPixelBaselineGeometry(value);
  assert(value.revisionsScrollWidth <= value.revisionsClientWidth,
    'Reading region has no horizontal overflow');
  assert(value.removeUnobstructed && value.removeLeft >= 0 &&
    value.removeRight <= value.width && value.removeTop >= 0 &&
    value.removeBottom <= value.height,
    'Trailing Remove is exposed within the viewport');
}

export function assertScaledReading(
  baseline: FontProfile,
  scaled: PixelGeometry,
): void {
  assert.equal(scaled.width, baseline.width, 'Font scale preserves CSS width');
  assert.equal(scaled.height, baseline.height, 'Font scale preserves CSS height');
  assert.equal(scaled.dpr, baseline.dpr, 'Font scale preserves DPR');
  assert.equal(scaled.inlineRootSize, '', 'Root font has no inline override');
  assert(Number.isFinite(scaled.rootPx) && scaled.rootPx > baseline.rootPx &&
    scaled.rootPx >= 24, 'Android font_scale enlarges the real WebView root');
  assert(scaled.revisionsScrollWidth <= scaled.revisionsClientWidth,
    'Large-text reading region has no horizontal overflow');
}

export function assertNativeTarget(
  elements: readonly AccountElement[],
): AccountElement {
  assert.equal(elements.length, 1, 'One exact native target');
  const target = elements[0]!;
  assert(target.visible && target.unobstructedCenter && !target.disabled,
    'Native target is visible, enabled, and uncovered');
  assert(target.rect.width > 0 && target.rect.height > 0,
    'Native target has a real box');
  return target;
}
