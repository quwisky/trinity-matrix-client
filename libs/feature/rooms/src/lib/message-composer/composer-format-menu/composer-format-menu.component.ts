import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { TrnIconButton } from '@trinity/components/controls';
import {
  TrnActionSheetService,
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
  type ActionSheetButton,
  type TrnActionSheetRef,
} from '@trinity/components/overlay';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';
import { TrnTooltip } from '@trinity/components/generic-content';
import { isMobileOs } from '@trinity/platform-native';
import type { FormatAction } from '@trinity/util/matrix';

interface FormatEntry {
  readonly action: FormatAction;
  readonly text: string;
  readonly icon: TrnIconName;
}

const FORMATS: readonly FormatEntry[] = [
  { action: 'bold', text: 'Bold', icon: 'bold' },
  { action: 'italic', text: 'Italic', icon: 'italic' },
  { action: 'strike', text: 'Strikethrough', icon: 'strikethrough' },
  { action: 'code', text: 'Inline code', icon: 'code' },
  { action: 'codeblock', text: 'Code block', icon: 'square-code' },
  { action: 'quote', text: 'Quote', icon: 'text-quote' },
  { action: 'link', text: 'Link', icon: 'link' },
  { action: 'list', text: 'Bulleted list', icon: 'list' },
  { action: 'tasklist', text: 'Task list', icon: 'list-todo' },
];

interface FormatInvocation {
  readonly context: object | null;
  restoreFocus: boolean;
}

@Component({
  selector: 'trn-composer-format-menu',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnIconButton,
    TrnIconComponent,
    TrnTooltip,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
  ],
  templateUrl: './composer-format-menu.component.html',
  styleUrl: './composer-format-menu.component.scss',
})
export class ComposerFormatMenuComponent {
  private readonly actionSheet = inject(TrnActionSheetService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly trigger =
    viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly desktopTrigger = viewChild(TrnDropdownMenuTrigger);
  private invocation: FormatInvocation | null = null;
  private sheet: TrnActionSheetRef | null = null;

  protected readonly mobileInteraction = isMobileOs();
  protected readonly mobileSheetOpen = signal(false);
  protected readonly entries = FORMATS;

  readonly disabled = input(false);
  readonly contextKey = input<object | null>(null);
  readonly previewing = input(false);
  readonly format = output<FormatAction>();
  readonly preview = output<void>();
  readonly beforeOpen = output<void>();
  readonly dismissed = output<void>();

  constructor() {
    this.destroyRef.onDestroy(() => this.invalidate());
    effect(() => {
      const context = this.contextKey();
      const disabled = this.disabled();
      untracked(() => {
        if (
          this.invocation &&
          (disabled || this.invocation.context !== context)
        ) {
          this.invalidate();
        }
      });
    });
  }

  protected onDesktopOpened(): void {
    if (this.disabled()) {
      this.desktopTrigger()?.close();
      return;
    }
    this.begin();
  }

  protected onDesktopClosed(): void {
    if (this.invocation) this.onClosed(this.invocation);
  }

  protected openMobileSheet(): void {
    if (this.disabled() || this.mobileSheetOpen()) return;
    const invocation = this.begin();
    const buttons: ActionSheetButton[] = FORMATS.map((entry) => ({
      text: entry.text,
      icon: entry.icon,
      testId: `format-${entry.action}`,
      handler: () => this.choose(entry.action, invocation),
    }));
    buttons.push(
      {
        text: this.previewing() ? 'Edit message' : 'Preview',
        icon: this.previewing() ? 'pencil' : 'eye',
        testId: 'format-preview',
        handler: () => this.choose('preview', invocation),
      },
      { text: 'Cancel', role: 'cancel', testId: 'format-cancel' },
    );
    const ref = this.actionSheet.open(
      { header: 'Format message', buttons },
      'Format message',
      { restoreFocus: false },
    );
    this.sheet = ref;
    this.mobileSheetOpen.set(true);
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.sheet === ref) this.sheet = null;
      this.onClosed(invocation);
    });
  }

  protected choose(
    action: FormatAction | 'preview',
    invocation = this.invocation,
  ): void {
    if (!invocation || !this.isCurrent(invocation)) return;
    // Invalidate BEFORE closing: both overlay adapters can report closed synchronously.
    // Choosing an action hands focus to the composer; dismissal restores the Aa trigger.
    this.invalidate();
    if (action === 'preview') this.preview.emit();
    else this.format.emit(action);
  }

  protected cancel(): void {
    if (this.invocation) this.invocation.restoreFocus = true;
    this.desktopTrigger()?.close();
  }

  private begin(): FormatInvocation {
    const invocation = {
      context: this.contextKey(),
      restoreFocus: this.mobileInteraction,
    };
    this.invocation = invocation;
    this.beforeOpen.emit();
    return invocation;
  }

  private isCurrent(invocation: FormatInvocation): boolean {
    return (
      !this.destroyRef.destroyed &&
      !this.disabled() &&
      this.invocation === invocation &&
      invocation.context === this.contextKey()
    );
  }

  private onClosed(invocation: FormatInvocation): void {
    // Action sheets close before running their selected handler. Keep the invocation
    // valid through that handler, then restore focus only for an actual dismissal.
    queueMicrotask(() => {
      if (!this.isCurrent(invocation)) return;
      this.invocation = null;
      this.mobileSheetOpen.set(false);
      const trigger = this.trigger()?.nativeElement;
      if (!trigger?.isConnected || trigger.disabled) return;
      // An outside desktop press may have focused another control or placed a new
      // caret in the input. Preserve that intent instead of restoring an old range.
      if (
        invocation.restoreFocus ||
        trigger.ownerDocument.activeElement === trigger
      ) {
        this.dismissed.emit();
        if (invocation.restoreFocus) trigger.focus();
      }
    });
  }

  private invalidate(): void {
    this.invocation = null;
    const sheet = this.sheet;
    this.sheet = null;
    this.mobileSheetOpen.set(false);
    sheet?.close();
    this.desktopTrigger()?.close();
  }
}
