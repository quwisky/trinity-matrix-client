import type { FocusKeyManager } from '@angular/cdk/a11y';
import { CdkMenu, type CdkMenuItem } from '@angular/cdk/menu';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  viewChild,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnIconComponent,
  type TrnIconName,
  type TrnVariant,
} from '@trinity/components/foundations';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuLabel,
  TrnDropdownMenuSeparator,
} from '../dropdown/trn-dropdown-menu';
import { TrnSheetFrameComponent } from '../sheet-frame/trn-sheet-frame.component';

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
  /** A cancel row closes the sheet without running a handler; a menu omits it. */
  role?: 'cancel';
  handler?: () => void;
  /** Leading icon. */
  icon?: TrnIconName;
  /** Draw a rule above this row — separating a destructive action from the rest. */
  separatorBefore?: boolean;
  /** Harness hook. The Playwright specs drive these rows by id. */
  testId?: string;
}

/** A one-tap reaction offered above the rows. */
export interface ActionSheetReaction {
  key: string;
  handler: () => void;
}

export interface ActionSheetData {
  header?: string;
  buttons: ActionSheetButton[];
  /** A strip of one-tap reactions above the rows (the highest-frequency message action). */
  reactions?: ActionSheetReaction[];
}

/**
 * An action list: a bottom sheet in `trn-sheet-frame`, or, opened beside its button on a
 * large screen, an anchored menu with the dropdown's rows and keyboard behaviour.
 *
 * Picking a row closes the list, then runs its handler (a handler often opens another
 * surface). The sheet's rows scroll inside the frame's height cap, so a long list is never
 * clipped (geometry measured in `message-action-sheet.spec.mts`).
 */
@Component({
  selector: 'trn-action-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnIconComponent,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuLabel,
    TrnDropdownMenuSeparator,
    TrnSheetFrameComponent,
  ],
  templateUrl: './trn-action-list.component.html',
})
export class TrnActionListComponent {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly ref = inject<TrnDialogRef<void>>(TrnDialogRef);
  private readonly menu = viewChild(CdkMenu);

  /** Fixed at open, like the dialog that presents it. */
  protected readonly popover = this.ref.presentation === 'popover';
  /** A menu closes on Escape and click-away, so it drops the sheet's Cancel row. */
  protected readonly rows = computed(() =>
    this.popover
      ? this.data().buttons.filter((button) => button.role !== 'cancel')
      : this.data().buttons,
  );

  readonly data = input.required<ActionSheetData>();
  /** The menu's name where there is no header to supply one. */
  readonly label = input<string>();

  constructor() {
    // CDK's menu keeps a disabled row in the arrow-key order, but a natively disabled
    // button takes no focus, so the arrow would stall on it. `keyManager` is protected API.
    afterNextRender(() => {
      const keys = (
        this.menu() as unknown as
          { keyManager?: FocusKeyManager<CdkMenuItem> } | undefined
      )?.keyManager;
      keys?.skipPredicate((item) => item.disabled);
    });
  }

  /** The concrete box for this invocation, once Angular has rendered it. */
  get surface(): HTMLElement | null {
    return this.host.nativeElement.querySelector<HTMLElement>(
      '[data-testid="action-sheet-surface"], [role="menu"]',
    );
  }

  protected onClick(button: ActionSheetButton): void {
    // Native `disabled` blocks user clicks; the guard is the contract for direct calls.
    if (button.disabled) return;
    this.ref.close();
    if (button.role !== 'cancel') button.handler?.();
  }

  /** Same close-then-run order as a row: the handler often opens another overlay. */
  protected onReact(reaction: ActionSheetReaction): void {
    this.ref.close();
    reaction.handler();
  }

  protected buttonVariant(
    button: ActionSheetButton,
  ): TrnActionSheetButtonVariant {
    return button.variant ?? 'neutral';
  }
}
