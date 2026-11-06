import { InjectionToken, type Signal } from '@angular/core';

/**
 * While true, every `trnBtn` below the provider renders as a full-width row of an inset card,
 * such as the actions of a phone sheet. Controls owns it because overlay may not be imported here.
 */
export const TRN_BUTTON_ROW_CONTEXT = new InjectionToken<Signal<boolean>>(
  'TRN_BUTTON_ROW_CONTEXT',
);
