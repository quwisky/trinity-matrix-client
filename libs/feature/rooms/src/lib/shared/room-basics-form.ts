import type { Signal } from '@angular/core';
import { disabled } from '@angular/forms/signals';
import type { SchemaPath } from '@angular/forms/signals';
import type { JoinRule } from '@trinity/data-access/room-administration';

/** The power-level answers that decide which of name, topic and join rule the viewer may change. */
export interface RoomBasicsGates {
  canEditName: Signal<boolean>;
  canEditTopic: Signal<boolean>;
  canEditJoinRule: Signal<boolean>;
}

/**
 * Disable whichever of name / topic / join rule this viewer's power level does not reach.
 *
 * Expressed as schema logic so it tracks the gates, which are signals: an imperative `disable()` in
 * `ngOnInit` would snapshot them and miss a power-level change arriving mid-dialog. Takes the field
 * paths rather than the parent path because the two dialogs' models are not the same type.
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
