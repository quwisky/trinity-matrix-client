import type { Signal } from '@angular/core';
import { disabled } from '@angular/forms/signals';
import type { SchemaPath } from '@angular/forms/signals';
import type { JoinRule } from '@trinity/data-access/room-administration';

/**
 * The three fields the room and space settings dialogs both have. Each dialog's own model
 * extends this — the room adds `historyVisibility`, the space deliberately does not.
 */
export interface RoomBasics {
  name: string;
  topic: string;
  joinRule: JoinRule;
}

/** The power-level answers that decide which of those fields the viewer may change. */
export interface RoomBasicsGates {
  canEditName: Signal<boolean>;
  canEditTopic: Signal<boolean>;
  canEditJoinRule: Signal<boolean>;
}

/**
 * Disable whichever of name / topic / join rule this viewer's power level does not reach.
 *
 * Both dialogs used to do this imperatively in `ngOnInit`, reading each `canEdit*` input
 * once and calling `control.disable()`. The gates are signals, so that was a snapshot of a
 * reactive value: a power-level change arriving mid-dialog left the field in whatever state
 * it had on open. Expressed as schema logic it simply tracks.
 *
 * Takes the field paths rather than the parent path because the two models are not the same
 * type — sharing the parent would mean making one dialog's model assignable to the other's,
 * which is a worse trade than passing three paths.
 */
export function applyRoomBasicsGates(
  paths: {
    name: SchemaPath<string>;
    topic: SchemaPath<string>;
    joinRule: SchemaPath<JoinRule>;
  },
  gates: RoomBasicsGates,
): void {
  // `{ when: … }`, not a bare function: the function overload is deprecated, and the
  // type-aware no-deprecated rule fails the build on it.
  disabled(paths.name, { when: () => !gates.canEditName() });
  disabled(paths.topic, { when: () => !gates.canEditTopic() });
  disabled(paths.joinRule, { when: () => !gates.canEditJoinRule() });
}
