import assert from 'node:assert/strict';
import type {
  AccountElementFilter,
  AccountWorkspaceClient,
} from './account-workspace-client.mts';

/**
 * A control whose `data-testid` embeds a Room id. Selectors reach the job log,
 * so the control is found by its test-id prefix inside the row that names the
 * Room, and a read-only observation binds it to the exact Room.
 */
export interface RoomControl {
  readonly selector: string;
  readonly filter: AccountElementFilter;
  /** The exact test id; it is only ever an in-page comparison value. */
  readonly testId: string;
}

/**
 * The control `[data-testid="<prefix><roomId>"]` inside the row matching
 * `row` whose text contains `name`. The prefix, optionally narrowed to an
 * `element` type, must name one control per row.
 */
export function roomControl(
  row: string,
  prefix: string,
  name: string,
  roomId: string,
  element = '',
): RoomControl {
  return {
    selector: `${row} ${element}[data-testid^=${JSON.stringify(prefix)}]`,
    filter: { within: { selector: row, text: name } },
    testId: `${prefix}${roomId}`,
  };
}

/** The row element itself, whose own test id is `<prefix><roomId>`. */
export function roomRow(
  row: string,
  prefix: string,
  name: string,
  roomId: string,
): RoomControl {
  return {
    selector: `${row}[data-testid^=${JSON.stringify(prefix)}]`,
    filter: { text: name },
    testId: `${prefix}${roomId}`,
  };
}

/** Fail unless exactly one control matches and it belongs to the exact Room. */
export async function bindRoomControl(
  client: Pick<AccountWorkspaceClient, 'testIdIdentity'>,
  control: RoomControl,
  description: string,
): Promise<void> {
  const identity = await client.testIdIdentity(
    control.selector,
    control.filter,
    control.testId,
  );
  assert(identity.matches === 1 && identity.exactRoom, description);
}
