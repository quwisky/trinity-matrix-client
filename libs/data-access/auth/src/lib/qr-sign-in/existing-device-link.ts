import type { Observable } from 'rxjs';
import type { ExistingDeviceState } from './qr-sign-in.model';

/** The existing device's side of a link, with the check-code answer as its input. */
export interface ExistingDeviceLink {
  readonly state$: Observable<ExistingDeviceState>;
  confirmCheckCode(match: boolean): void;
}
