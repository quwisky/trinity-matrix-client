import * as cdkDialog from '@angular/cdk/dialog';
import { describe, expect, it } from 'vitest';
import * as overlay from '../index';

/**
 * Guards how much Angular CDK this barrel hands out.
 *
 * `@trinity/helm/overlay` is the only door feature code has to dialogs — since #151 no
 * file outside `libs/spartan/` imports `@angular/cdk` at all, and #148 turns that into a
 * lint ban. The ban is only worth as much as this barrel: re-export `Dialog` and any
 * feature can call `.open()` with unmediated CDK config while lint stays green, which
 * would make the abstraction a pass-through and the rule cosmetic.
 *
 * Checked by runtime identity rather than by reading the source, because the failure
 * that matters is `export * from '@angular/cdk/dialog'` — one line that re-exports the
 * whole entry point, reads as innocuous, and no text match for "Dialog" would flag more
 * clearly than the dozen legitimate mentions around it. Type-only re-exports are erased
 * and therefore invisible here, which is correct: a type cannot open a dialog.
 */
describe('@trinity/helm/overlay vendor surface', () => {
  it('re-exports exactly one CDK symbol, DialogRef', () => {
    const cdkValues = new Set<unknown>(Object.values(cdkDialog));
    const leaked = Object.entries(overlay)
      .filter(([, value]) => cdkValues.has(value))
      .map(([name]) => name)
      .sort();

    // DialogRef is deliberate: a modal'd component closes itself with
    // `inject(DialogRef).close(value)`, and that is the whole reason the barrel exists.
    expect(leaked).toEqual(['DialogRef']);
  });

  it('does not hand out Dialog or DIALOG_DATA', () => {
    // Named explicitly as well as covered by the check above, because these two are the
    // specific escape hatches: `Dialog` bypasses TrnDialogService entirely, and
    // `DIALOG_DATA` would undo the move to `input.required()` that let
    // `DialogOptions.data` be deleted.
    const exported = Object.keys(overlay);
    expect(exported).not.toContain('Dialog');
    expect(exported).not.toContain('DIALOG_DATA');
  });
});
