import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
} from '@angular/core';
import { DIALOG_DATA, DialogRef } from '@angular/cdk/dialog';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnIconComponent,
  type TrnIconName,
  type TrnVariant,
} from '@trinity/components/foundations';
import { TrnOverlaySurfaceDirective } from '../surface/trn-overlay-surface.directive';

export type TrnActionSheetButtonVariant = Extract<
  TrnVariant,
  'neutral' | 'danger'
>;

export interface ActionSheetButton {
  text: string;
  /** A disabled row stays visible for context but cannot receive focus or run its handler. */
  disabled?: boolean;
  /** Semantic treatment, independent of cancellation behavior. */
  variant?: TrnActionSheetButtonVariant;
  /** Temporary behavior/appearance compatibility. Prefer `variant="danger"`. */
  role?: 'cancel' | 'destructive';
  handler?: () => void;
  /** Leading icon, for a sheet standing in for a menu that had one. */
  icon?: TrnIconName;
  /** Draw a rule above this row — separating a destructive action from the rest. */
  separatorBefore?: boolean;
  /** Harness hook. The Playwright specs drive these rows by id. */
  testId?: string;
}

/** A one-tap reaction offered above the buttons. */
export interface ActionSheetReaction {
  key: string;
  handler: () => void;
}

export interface ActionSheetData {
  header?: string;
  buttons: ActionSheetButton[];
  /**
   * A row of one-tap reactions above the buttons.
   *
   * A strip rather than more rows because reacting is the highest-frequency message
   * action, and six of them as full-width text rows would push everything else off a
   * phone screen — which is the failure this component was carrying anyway (see the
   * scroll note below).
   */
  reactions?: ActionSheetReaction[];
}

/**
 * Bottom-sheet menu shown by {@link TrnActionSheetService}. Renders the buttons
 * as a stacked list; picking one closes the sheet, then runs its handler (a
 * non-cancel handler often opens another dialog). Replaces `<ion-action-sheet>`.
 *
 * ## It has to scroll
 *
 * The outer box clips the corner radius; the INNER list is the scroller. Before that
 * split this component was a single `overflow-hidden` box with no height bound, and
 * CDK's `.cdk-overlay-pane { max-height: 100% }` clamped it to the viewport — so a list
 * taller than the screen was silently cut off with no scrollbar and no affordance.
 * Measured at 360×640: thirteen rows need 639px and had 628px, leaving the last one
 * clipped and `elementFromPoint` returning null on it. It never showed because the only
 * call site passed four.
 *
 * `80svh` and not `80vh`: on mobile Safari `vh` is the LARGEST viewport, so a sheet sized
 * against it is partly behind the address bar until the page is scrolled — which a modal
 * cannot do.
 */
@Component({
  selector: 'trn-action-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent, TrnOverlaySurfaceDirective],
  styles: [
    `
      /*
       * Clear of the home indicator, composed with the design padding in ONE
       * declaration. This component default owns the bottom longhand; the template uses
       * only inline and top spacing utilities, so no cascade order can discard either
       * half — the defect #219 fixed across five panel headers.
       */
      @layer components {
        .sheet {
          padding-bottom: calc(0.375rem + env(safe-area-inset-bottom));
        }
      }
    `,
  ],
  template: `
    <div
      trnOverlaySurface
      variant="neutral"
      size="md"
      layout="sheet"
      class="sheet flex flex-col px-1.5 pt-1.5"
      data-testid="action-sheet-surface"
    >
      @if (data.header) {
        <p
          class="shrink-0 px-3 py-2 text-center text-xs font-medium text-muted-foreground"
        >
          {{ data.header }}
        </p>
      }

      @if (data.reactions?.length) {
        <div
          class="flex shrink-0 items-center justify-around gap-1 px-1 pb-1.5"
          role="group"
          aria-label="Quick reactions"
        >
          @for (reaction of data.reactions; track reaction.key) {
            <button
              trnBtn
              type="button"
              variant="secondary"
              presentation="ghost"
              size="lg"
              class="min-h-11 min-w-11 px-0 text-xl"
              [attr.aria-label]="'React with ' + reaction.key"
              [attr.data-testid]="'sheet-react-' + reaction.key"
              (click)="onReact(reaction)"
            >
              {{ reaction.key }}
            </button>
          }
        </div>
      }

      <!-- The scroller. min-h-0 because a flex child will not shrink below its content
           height without it, which would push the max-height back off the screen. -->
      <div class="min-h-0 flex-1 overflow-y-auto">
        @for (button of data.buttons; track $index) {
          @if (button.separatorBefore) {
            <div class="my-1 h-px bg-border" role="separator"></div>
          }
          <button
            trnBtn
            [variant]="
              buttonVariant(button) === 'danger' ? 'danger' : 'secondary'
            "
            presentation="ghost"
            class="min-h-11 w-full justify-start gap-3"
            [disabled]="button.disabled"
            [attr.data-testid]="button.testId"
            (click)="onClick(button)"
          >
            @if (button.icon) {
              <trn-icon [name]="button.icon" />
            }
            {{ button.text }}
          </button>
        }
      </div>
    </div>
  `,
})
export class TrnActionSheetComponent {
  private readonly host = inject(ElementRef<HTMLElement>);
  protected readonly data = inject<ActionSheetData>(DIALOG_DATA);
  private readonly ref =
    inject<DialogRef<void, TrnActionSheetComponent>>(DialogRef);

  /** The concrete sheet box for invocation-scoped positioning work. */
  get surface(): HTMLElement | null {
    return (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '.sheet',
    );
  }

  protected onClick(button: ActionSheetButton): void {
    // Native `disabled` blocks user clicks. Keep the guard as the actual contract too:
    // tests, assistive tooling and future adapters can invoke this method directly.
    if (button.disabled) return;
    this.ref.close();
    if (button.role !== 'cancel') {
      button.handler?.();
    }
  }

  protected buttonVariant(
    button: ActionSheetButton,
  ): TrnActionSheetButtonVariant {
    return (
      button.variant ?? (button.role === 'destructive' ? 'danger' : 'neutral')
    );
  }

  /** Same close-then-run order as a button: the handler often opens another overlay. */
  protected onReact(reaction: ActionSheetReaction): void {
    this.ref.close();
    reaction.handler();
  }
}
