import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  TrnCard,
  TrnCardContent,
  TrnCardHeader,
  TrnCardTitle,
} from '@trinity/components/navigation-layout';

/**
 * The signed-out surface: the Trinity wordmark, a caller-supplied line under it, and
 * whatever the leg needs below.
 *
 * Extracted from `login.page.html` so the redirect leg can wear it. `sso-callback` was a
 * bare spinner on a centred `<main>` — no card, no wordmark, on the app's own background —
 * so returning from a homeserver's SSO page looked like landing somewhere else entirely,
 * at the one moment a reader is already unsure whether the redirect worked.
 *
 * The subtitle is PROJECTED rather than an input string: login's is four conditional
 * branches plus a homeserver line, which no string could carry. Projection also keeps the
 * styling guard satisfied, and it is right to be — whoever writes the markup styles it,
 * and emulated encapsulation scopes those rules to the declaring component either way.
 */
@Component({
  selector: 'trn-auth-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnCard, TrnCardHeader, TrnCardTitle, TrnCardContent],
  templateUrl: './auth-card.component.html',
  styleUrl: './auth-card.component.scss',
  host: { class: 'login-page block flex-1 overflow-y-auto' },
})
export class AuthCardComponent {}
