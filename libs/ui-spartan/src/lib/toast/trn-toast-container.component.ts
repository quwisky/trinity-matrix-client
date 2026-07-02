import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { hlm } from '@trinity/helm/utils';
import { TrnToastService, type ToastVariant } from './trn-toast.service';

/**
 * Host for the stacked toast pills, attached once into a CDK overlay by
 * {@link TrnToastService}. Renders reactively from the service's `toasts`
 * signal; the wrapper is click-through (`pointer-events-none`) so toasts never
 * block the UI, while each pill re-enables pointer events for tap-to-dismiss.
 */
@Component({
  selector: 'trn-toast-container',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'pointer-events-none flex flex-col items-center gap-2',
  },
  template: `
    @for (t of svc.toasts(); track t.id) {
      <div
        [class]="pillClass(t.variant)"
        role="status"
        aria-live="polite"
        (click)="svc.dismiss(t.id)"
      >
        {{ t.message }}
      </div>
    }
  `,
})
export class TrnToastContainerComponent {
  protected readonly svc = inject(TrnToastService);

  protected pillClass(variant: ToastVariant): string {
    const byVariant: Record<ToastVariant, string> = {
      default: 'bg-foreground text-background',
      destructive: 'bg-destructive text-destructive-foreground',
      success: 'bg-success text-success-foreground',
    };
    return hlm(
      'pointer-events-auto max-w-[min(90vw,28rem)] rounded-md px-4 py-2 text-sm font-medium shadow-lg',
      byVariant[variant],
    );
  }
}
