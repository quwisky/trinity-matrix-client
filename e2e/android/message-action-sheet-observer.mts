import assert from 'node:assert/strict';
import type { AccountWorkspaceClient } from './account-workspace-client.mts';
import { evaluateNative } from './native-shell-client.mts';

export interface MessageActionSheetGeometry {
  readonly rowCount: number;
  readonly rowConnected: boolean;
  readonly scrollerPresent: boolean;
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly scrollerTop: number;
  readonly scrollerBottom: number;
  readonly sheetPresent: boolean;
  readonly sheetTop: number;
  readonly sheetBottom: number;
  readonly viewportHeight: number;
}

export interface MessageActionSheetReactionReceipt {
  readonly eventIdPresent: boolean;
  readonly senderMatches: boolean;
  readonly targetMatches: boolean;
  readonly annotation: boolean;
  readonly key: string;
  readonly ready: boolean;
}

/** Read-only geometry, scoped to one exact main-timeline or Thread event row. */
export async function readSheetGeometry(
  client: AccountWorkspaceClient,
  rowSelector: string,
): Promise<MessageActionSheetGeometry> {
  const value = await evaluateNative(client.webview, `(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(rowSelector)})];
    const row = rows.length === 1 ? rows[0] : null;
    const scroller = row?.closest('[data-message-scroller]');
    const sheets = [...document.querySelectorAll('[role="dialog"][aria-label="Message actions"] [data-testid="action-sheet-surface"]')];
    const sheet = sheets.length === 1 ? sheets[0] : null;
    const rowBox = row?.getBoundingClientRect();
    const scrollerBox = scroller?.getBoundingClientRect();
    const sheetBox = sheet?.getBoundingClientRect();
    return {
      rowCount: rows.length,
      rowConnected: row?.isConnected === true,
      scrollerPresent: scroller?.isConnected === true,
      rowTop: rowBox?.top ?? null, rowBottom: rowBox?.bottom ?? null,
      scrollerTop: scrollerBox?.top ?? null, scrollerBottom: scrollerBox?.bottom ?? null,
      sheetPresent: sheet?.isConnected === true && sheetBox.width > 0 && sheetBox.height > 0,
      sheetTop: sheetBox?.top ?? null, sheetBottom: sheetBox?.bottom ?? null,
      viewportHeight: window.innerHeight,
    };
  })()`);
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Sheet geometry is an object');
  const result = value as Record<string, unknown>;
  for (const key of ['rowCount', 'rowTop', 'rowBottom', 'scrollerTop', 'scrollerBottom', 'sheetTop', 'sheetBottom', 'viewportHeight']) {
    assert(typeof result[key] === 'number' && Number.isFinite(result[key]), `Sheet geometry ${key} is finite`);
  }
  for (const key of ['rowConnected', 'scrollerPresent', 'sheetPresent']) {
    assert.equal(typeof result[key], 'boolean', `Sheet geometry ${key} is boolean`);
  }
  return result as unknown as MessageActionSheetGeometry;
}

/** Preserve the predecessor's four clearance assertions and reject vacuous bounds. */
export function assertSheetClearance(geometry: MessageActionSheetGeometry): void {
  const { rowTop, rowBottom, scrollerTop, scrollerBottom, sheetTop } = geometry;
  for (const value of [rowTop, rowBottom, scrollerTop, scrollerBottom, sheetTop]) {
    assert(Number.isFinite(value), 'Clearance measurements must be finite');
  }
  assert.equal(geometry.rowCount, 1, 'Exactly one target row is connected');
  assert.equal(geometry.rowConnected, true, 'Target remains connected');
  assert.equal(geometry.scrollerPresent, true, 'Target belongs to a live scroller');
  assert.equal(geometry.sheetPresent, true, 'Named sheet has a nonempty box');
  assert(rowBottom > rowTop, 'Target has positive height');
  assert(scrollerBottom > scrollerTop, 'Scroller has positive height');
  assert(rowTop >= scrollerTop - 1, 'Target top is inside its scroller');
  assert(rowBottom <= scrollerBottom + 1, 'Target bottom is inside its scroller');
  assert(rowBottom + 8 <= sheetTop + 0.5, 'Target keeps the eight CSS pixel sheet gap');
}

export function assertSheetViewport(geometry: MessageActionSheetGeometry): void {
  const { sheetTop, sheetBottom, viewportHeight } = geometry;
  for (const value of [sheetTop, sheetBottom, viewportHeight]) {
    assert(Number.isFinite(value), 'Viewport measurements must be finite');
  }
  assert.equal(geometry.sheetPresent, true, 'Named sheet has a nonempty box');
  assert(viewportHeight > 0 && sheetBottom > sheetTop, 'Viewport and sheet have positive height');
  assert(sheetTop >= 0, 'Sheet top stays in the viewport');
  assert(sheetBottom <= viewportHeight + 1, 'Sheet bottom stays in the viewport');
}

export function assertSheetPositionRestored(before: number, after: number): void {
  assert(Number.isFinite(before) && Number.isFinite(after), 'Restoration uses finite positions');
  assert(Math.abs(after - before) <= 2, 'Target scroller-relative top restores within two CSS pixels');
}

export function assertSheetReaction(receipt: MessageActionSheetReactionReceipt): void {
  assert.equal(receipt.eventIdPresent, true, 'Reaction is a real server event');
  assert.equal(receipt.senderMatches, true, 'Reaction belongs to the exact Account');
  assert.equal(receipt.targetMatches, true, 'Reaction relates to the exact target');
  assert.equal(receipt.annotation, true, 'Reaction is an annotation');
  assert.equal(receipt.key, '👍', 'Reaction uses the exact quick-strip key');
  assert.equal(receipt.ready, true, 'Reaction is ready, not optimistic-only state');
}
