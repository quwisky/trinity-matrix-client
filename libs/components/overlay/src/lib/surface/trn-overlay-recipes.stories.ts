import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  applicationConfig,
  type Meta,
  moduleMetadata,
  type StoryObj,
} from '@storybook/angular-vite';
import { TrnButton } from '@trinity/components/controls';
import { TrnActionSheetService } from '../action-sheet/trn-action-sheet.service';
import { TrnAlertService } from '../alert/trn-alert.service';
import { TrnAnchoredOverlayDirective } from '../anchored/trn-anchored-overlay.directive';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  TrnDialogService,
  type TrnDialogPlacement,
} from '../dialog/trn-dialog.service';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
} from '../dropdown/trn-dropdown-menu';
import { provideTrnOverlayDefaults } from '../provide-overlay-defaults';
import { TrnToasterComponent } from '../toast/trn-toaster.component';
import { TrnToastService } from '../toast/trn-toast.service';
import type { TrnOverlaySurfaceLayout } from './trn-overlay-surface-recipe';
import { TrnOverlaySurfaceDirective } from './trn-overlay-surface.directive';

@Component({
  selector: 'trn-layered-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnAnchoredOverlayDirective, TrnButton, TrnOverlaySurfaceDirective],
  template: `
    <div class="grid max-w-2xl gap-6 p-6">
      <section
        trnOverlaySurface
        variant="neutral"
        size="sm"
        layout="popover"
        class="p-4"
        data-testid="document-overlay-surface"
      >
        Document surface
      </section>

      <button
        #anchor
        trnBtn
        variant="secondary"
        presentation="outline"
        type="button"
        data-testid="anchored-overlay-trigger"
        (click)="open.update((value) => !value)"
      >
        Toggle portal surface
      </button>
      <ng-template
        [trnAnchoredOverlay]="anchor"
        [(open)]="open"
        side="bottom"
        align="start"
      >
        <section
          trnOverlaySurface
          variant="neutral"
          size="sm"
          layout="popover"
          class="p-4"
          data-testid="portal-overlay-surface"
        >
          Portal surface
        </section>
      </ng-template>
    </div>
  `,
})
class LayeredOverlayStoryComponent {
  protected readonly open = signal(true);
}

@Component({
  selector: 'trn-dropdown-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
  ],
  template: `
    <div class="grid max-w-sm gap-4 p-6">
      <button
        trnBtn
        variant="secondary"
        presentation="outline"
        type="button"
        [trnDropdownMenuTrigger]="menu"
        side="bottom"
        align="end"
        data-testid="dropdown-trigger"
      >
        Open actions
      </button>
      <p role="status" data-testid="dropdown-result">{{ result() }}</p>
    </div>

    <ng-template #menu>
      <div trnDropdownMenu aria-label="Overlay actions">
        <button
          trnDropdownMenuItem
          data-testid="dropdown-neutral"
          (triggered)="result.set('Neutral chosen')"
        >
          Neutral action
        </button>
        <button
          trnDropdownMenuItem
          variant="danger"
          data-testid="dropdown-danger"
          (triggered)="result.set('Danger chosen')"
        >
          Canonical danger
        </button>
        <button
          trnDropdownMenuItem
          variant="destructive"
          data-testid="dropdown-legacy-danger"
          (triggered)="result.set('Legacy danger chosen')"
        >
          Legacy destructive
        </button>
        <button trnDropdownMenuItem disabled data-testid="dropdown-disabled">
          Disabled action
        </button>
      </div>
    </ng-template>
  `,
})
class DropdownOverlayStoryComponent {
  protected readonly result = signal('Nothing chosen');
}

@Component({
  selector: 'trn-overlay-story-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnOverlaySurfaceDirective],
  template: `
    <section
      trnOverlaySurface
      variant="neutral"
      size="md"
      [layout]="layout()"
      class="grid gap-5 p-6"
      data-testid="story-dialog-surface"
    >
      <h2 class="text-lg font-semibold">{{ title() }}</h2>
      <p class="text-sm text-muted-foreground">
        Placement and surface treatment are independent.
      </p>
      <button
        trnBtn
        variant="primary"
        type="button"
        data-testid="story-dialog-close"
        (click)="close()"
      >
        Close dialog
      </button>
    </section>
  `,
})
class OverlayStoryDialogComponent {
  readonly title = input('Overlay dialog');
  readonly layout = input<TrnOverlaySurfaceLayout>('dialog');
  private readonly ref = inject<TrnDialogRef<string>>(TrnDialogRef);

  protected close(): void {
    this.ref.close(this.title());
  }
}

@Component({
  selector: 'trn-dialog-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  template: `
    <div class="grid max-w-sm gap-3 p-6">
      <button
        trnBtn
        variant="secondary"
        presentation="outline"
        type="button"
        data-testid="dialog-canonical-center"
        (click)="openCanonical('center', 'dialog')"
      >
        Canonical center
      </button>
      <button
        trnBtn
        variant="secondary"
        presentation="outline"
        type="button"
        data-testid="dialog-canonical-end"
        (click)="openCanonical('inline-end', 'panel')"
      >
        Canonical inline end
      </button>
      <button
        trnBtn
        variant="secondary"
        presentation="outline"
        type="button"
        data-testid="dialog-legacy-end"
        (click)="openLegacyEnd()"
      >
        Legacy end
      </button>
      <p role="status" data-testid="dialog-result">{{ result() }}</p>
    </div>
  `,
})
class DialogOverlayStoryComponent {
  private readonly dialog = inject(TrnDialogService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly result = signal('No dialog result');

  protected openCanonical(
    placement: TrnDialogPlacement,
    layout: TrnOverlaySurfaceLayout,
  ): void {
    this.dialog
      .openAndWait$<string, OverlayStoryDialogComponent>(
        OverlayStoryDialogComponent,
        {
          placement,
          ariaLabel: `Canonical ${placement} dialog`,
          inputs: { title: `Canonical ${placement}`, layout },
        },
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((value) => this.result.set(value ?? 'Dismissed'));
  }

  protected openLegacyEnd(): void {
    void this.dialog
      .openAndWait<string, OverlayStoryDialogComponent>(
        OverlayStoryDialogComponent,
        {
          side: 'end',
          ariaLabel: 'Legacy end dialog',
          inputs: { title: 'Legacy end', layout: 'panel' },
        },
      )
      .then((value) => this.result.set(value ?? 'Dismissed'));
  }
}

@Component({
  selector: 'trn-feedback-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnToasterComponent],
  template: `
    <div class="grid max-w-md gap-3 p-6">
      <button
        trnBtn
        type="button"
        data-testid="alert-canonical"
        (click)="canonicalAlert()"
      >
        Canonical danger alert
      </button>
      <button
        trnBtn
        type="button"
        data-testid="alert-legacy"
        (click)="legacyAlert()"
      >
        Legacy destructive alert
      </button>
      <button
        trnBtn
        type="button"
        data-testid="sheet-canonical"
        (click)="canonicalSheet()"
      >
        Canonical action sheet
      </button>
      <button
        trnBtn
        type="button"
        data-testid="sheet-legacy"
        (click)="legacySheet()"
      >
        Legacy action sheet
      </button>
      <button
        trnBtn
        type="button"
        data-testid="toast-warning"
        (click)="warningToast()"
      >
        Warning toast
      </button>
      <button
        trnBtn
        type="button"
        data-testid="toast-danger"
        (click)="dangerToast()"
      >
        Danger toast
      </button>
      <button
        trnBtn
        type="button"
        data-testid="toast-legacy"
        (click)="legacyToast()"
      >
        Legacy destructive toast
      </button>
    </div>
    <trn-toaster />
  `,
})
class FeedbackOverlayStoryComponent {
  private readonly alerts = inject(TrnAlertService);
  private readonly sheets = inject(TrnActionSheetService);
  private readonly toasts = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  protected canonicalAlert(): void {
    this.alerts
      .confirm$({
        header: 'Delete this room?',
        confirmText: 'Delete',
        variant: 'danger',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected legacyAlert(): void {
    void this.alerts.confirm({
      header: 'Legacy delete?',
      confirmText: 'Delete',
      destructive: true,
    });
  }

  protected canonicalSheet(): void {
    this.sheets.open(
      {
        header: 'Canonical actions',
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          { text: 'Archive', disabled: true, testId: 'sheet-disabled' },
          {
            text: 'Delete',
            variant: 'danger',
            testId: 'sheet-danger',
          },
        ],
      },
      'Canonical actions',
    );
  }

  protected legacySheet(): void {
    this.sheets.open(
      {
        header: 'Legacy actions',
        buttons: [
          { text: 'Cancel', role: 'cancel' },
          {
            text: 'Legacy delete',
            role: 'destructive',
            testId: 'sheet-legacy-danger',
          },
        ],
      },
      'Legacy actions',
    );
  }

  protected warningToast(): void {
    this.toasts.show('Canonical warning', { variant: 'warning', duration: 0 });
  }

  protected dangerToast(): void {
    this.toasts.show('Canonical danger', { variant: 'danger', duration: 0 });
  }

  protected legacyToast(): void {
    this.toasts.show('Legacy destructive', {
      variant: 'destructive',
      duration: 0,
    });
  }
}

const meta: Meta = {
  title: 'Components/Overlay recipes',
  decorators: [
    applicationConfig({ providers: [provideTrnOverlayDefaults()] }),
    moduleMetadata({
      imports: [
        DialogOverlayStoryComponent,
        DropdownOverlayStoryComponent,
        FeedbackOverlayStoryComponent,
        LayeredOverlayStoryComponent,
      ],
    }),
  ],
  parameters: {
    docs: {
      description: {
        component:
          'Trinity-owned overlay treatment, placement, lifecycle, and temporary compatibility forms across document and portal surfaces.',
      },
    },
  },
};

export default meta;
type Story = StoryObj;

export const LayeredSurfaces: Story = {
  render: () => ({ template: '<trn-layered-overlay-story />' }),
};

export const DropdownCompatibility: Story = {
  render: () => ({ template: '<trn-dropdown-overlay-story />' }),
};

export const DialogCompatibility: Story = {
  render: () => ({ template: '<trn-dialog-overlay-story />' }),
};

export const FeedbackCompatibility: Story = {
  render: () => ({ template: '<trn-feedback-overlay-story />' }),
};
