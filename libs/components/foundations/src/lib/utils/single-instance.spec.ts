import { classes as kitClasses, hlm as kitTrn } from '@trinity/helm/utils';
import { describe, expect, it } from 'vitest';
import { classes, trn } from '../../index';

describe('@trinity/components/foundations', () => {
  it('is the kit implementation under our name, not a copy of it', () => {
    // Identity, deliberately — `toBe`, not `toEqual`. `classes()` keeps module-scoped state:
    // a per-element manager map, an ordering counter, and one document-wide
    // MutationObserver. A second copy would install a second observer and a second manager
    // for the same elements, so any host where a wrapper and the kit directive it composes
    // both apply classes would have two independent writers racing over `className` — last
    // write wins and the loser's classes vanish, with no error anywhere.
    //
    // This is what stops someone "tidying" the re-export into a copy. When the kit is
    // finally deleted, this assertion is the one that has to be rewritten on purpose.
    expect(classes).toBe(kitClasses);
    expect(trn).toBe(kitTrn);
  });
});
