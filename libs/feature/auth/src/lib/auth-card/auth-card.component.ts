import { ChangeDetectionStrategy, Component } from '@angular/core';
import {
  TrnCard,
  TrnCardContent,
  TrnCardHeader,
} from '@trinity/components/navigation-layout';

/**
 * The signed-out surface: the Trinity wordmark, a caller-supplied line under it, and
 * whatever the leg needs below.
 *
 * The subtitle is PROJECTED rather than an input string: login's is conditional markup no
 * string could carry, and whoever writes the markup styles it (emulated encapsulation
 * scopes the rules to the declaring component).
 */
@Component({
  selector: 'trn-auth-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnCard, TrnCardHeader, TrnCardContent],
  templateUrl: './auth-card.component.html',
  styleUrl: './auth-card.component.scss',
  host: { class: 'login-page block flex-1 overflow-y-auto' },
})
export class AuthCardComponent {}
