import { InjectionToken, type Signal } from '@angular/core';
import type {
  TrnToggleArrangement,
  TrnTogglePresentation,
  TrnToggleSize,
  TrnToggleVariant,
} from '../toggle/trn-toggle-recipe';

/** Private styling context shared with projected group items. */
export interface TrnToggleGroupStyleContext {
  readonly arrangement: Signal<TrnToggleArrangement>;
  readonly presentation: Signal<TrnTogglePresentation>;
  readonly size: Signal<TrnToggleSize>;
  readonly variant: Signal<TrnToggleVariant>;
}

export const TRN_TOGGLE_GROUP_STYLE =
  new InjectionToken<TrnToggleGroupStyleContext>('TRN_TOGGLE_GROUP_STYLE');
