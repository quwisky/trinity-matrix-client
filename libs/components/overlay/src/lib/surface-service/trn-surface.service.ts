import { Injectable, inject, type Type } from '@angular/core';
import { isMobileOs } from '@trinity/platform-native';
import { BELOW_MD_QUERY, matchesQuery } from '@trinity/util/ui';
import type { Observable } from 'rxjs';
import type { TrnActionSheetRef } from '../action-sheet/trn-action-sheet-ref';
import type { ActionSheetData } from '../action-sheet/trn-action-list.component';
import { TrnActionSheetService } from '../action-sheet/trn-action-sheet.service';
import type { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  TrnDialogService,
  prefersCentred,
  type DialogOptions,
  type TrnDialogAutoFocus,
} from '../dialog/trn-dialog.service';

/** `'auto'` applies the sheet-or-dialog rule; the others are explicit opt-outs. */
export type TrnSurfaceKind = 'auto' | 'fullscreen' | 'panel' | 'popover';

export interface TrnSurfaceOptions<C = object> {
  /** Set on the opened component's inputs after creation. */
  inputs?: Record<string, unknown>;
  /** The dialog's accessible name; pass its visible title. */
  ariaLabel?: string;
  ariaDescribedBy?: string;
  /** A selector, `'first-heading'`, `'dialog'` or `false`; the first tabbable otherwise. */
  autoFocus?: TrnDialogAutoFocus;
  /** No X, handle or swipe; Esc, backdrop and Back are ignored. */
  disableClose?: boolean;
  /** Runs on every user dismissal; `false` keeps the surface open. */
  dismissGuard?: (component: C | null) => boolean;
  kind?: TrnSurfaceKind;
  /**
   * The element a `'popover'` hangs off. Without one, or on a touch pointer, a popover
   * follows the `'auto'` rule instead.
   */
  anchor?: HTMLElement;
}

export interface TrnActionsOptions {
  /** The element the user pressed. Without one an action list is always a sheet. */
  anchor?: HTMLElement;
  /** The list's accessible name; its header otherwise. */
  ariaLabel?: string;
  /** `false` when the opener restores focus itself, e.g. after a row opens another surface. */
  restoreFocus?: boolean;
}

/**
 * The one public way to open a modal surface. Feature code says what it opens; this
 * decides how: a bottom sheet on a phone or tablet or below `md`, a centred dialog
 * otherwise, read once at open.
 */
@Injectable({ providedIn: 'root' })
export class TrnSurfaceService {
  private readonly dialogs = inject(TrnDialogService);
  private readonly actionSheets = inject(TrnActionSheetService);

  /** Whether any overlay is presented on the shared stack. */
  readonly openState = this.dialogs.openState;

  /** The rule: any phone or tablet, or any screen narrower than `md`. */
  prefersSheet(): boolean {
    return isMobileOs() || matchesQuery(BELOW_MD_QUERY);
  }

  open<R = unknown, C = object>(
    component: Type<C>,
    options: TrnSurfaceOptions<C> = {},
  ): TrnDialogRef<R> {
    return this.dialogs.open<R, C>(component, this.dialogOptions(options));
  }

  /** Open and resolve the component's close value (null if dismissed without one). */
  openAndWait$<R = unknown, C = object>(
    component: Type<C>,
    options: TrnSurfaceOptions<C> = {},
  ): Observable<R | null> {
    return this.dialogs.openAndWait$<R, C>(
      component,
      this.dialogOptions(options),
    );
  }

  /** An action list; the opener keeps the handle so it can close it. */
  openActions(
    data: ActionSheetData,
    options: TrnActionsOptions = {},
  ): TrnActionSheetRef {
    // A menu only where it fits: a large screen and a fine pointer, beside the pressed element.
    const anchor =
      options.anchor && !this.prefersSheet() && !prefersCentred()
        ? options.anchor
        : undefined;
    return this.actionSheets.open(data, options.ariaLabel, {
      restoreFocus: options.restoreFocus,
      anchor,
    });
  }

  hasOpen(): boolean {
    return this.dialogs.hasOpen();
  }

  isTopmost(ref: TrnDialogRef<unknown>): boolean {
    return this.dialogs.isTopmost(ref);
  }

  /** The Back primitive: closes the top overlay unless it is `disableClose` or refuses. */
  closeTopmost(): boolean {
    return this.dialogs.closeTopmost();
  }

  closeAll(): void {
    this.dialogs.closeAll();
  }

  private dialogOptions<C>({
    kind = 'auto',
    anchor,
    ...rest
  }: TrnSurfaceOptions<C>): DialogOptions<C> {
    if (kind === 'fullscreen') return { ...rest, placement: 'fullscreen' };
    if (kind === 'panel') return { ...rest, placement: 'inline-end' };
    if (kind === 'popover' && anchor && !prefersCentred()) {
      return { ...rest, anchor };
    }
    return { ...rest, placement: this.prefersSheet() ? 'bottom' : 'center' };
  }
}
