import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
} from '@angular/core';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';

let nextId = 0;

/**
 * Stands where Verify would be on a device that cannot sign other users: says why, and
 * opens Security settings, where this device's encryption setup is finished.
 */
@Component({
  selector: 'trn-verify-needs-setup',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  host: {
    class: 'flex flex-col items-start gap-2',
    'data-testid': 'verify-needs-setup',
  },
  template: `
    <p class="text-sm text-muted-foreground" [id]="reasonId">
      Finish this device’s encryption setup to verify people.
    </p>
    <button
      trnBtn
      size="sm"
      presentation="outline"
      type="button"
      [attr.aria-describedby]="reasonId"
      (click)="open()"
    >
      Security settings
    </button>
  `,
})
export class VerifyNeedsSetupComponent {
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);

  protected readonly reasonId = `verify-needs-setup-${nextId++}`;

  /** Security settings is opening; a host that would cover it can close. */
  readonly opened = output<void>();

  protected open(): void {
    // Finite, and deliberately not tied to this component: its host closes on `opened`.
    this.surfaces
      .open({ surface: { kind: 'settings', section: 'security' } })
      .subscribe();
    this.opened.emit();
  }
}
