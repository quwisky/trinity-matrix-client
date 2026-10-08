import { EmptyStateComponent } from '@trinity/components/generic-content';
import {
  ChangeDetectionStrategy,
  Component,
  OnChanges,
  SimpleChanges,
  inject,
  input,
} from '@angular/core';
import { FormField } from '@angular/forms/signals';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import { TrnToastService } from '@trinity/components/overlay';
import { RoomAliasRowComponent, matrixToUrl } from './room-alias-row.component';
import { RoomAliasesController } from './room-aliases.controller';

/**
 * Manage one Room or Space's published addresses inside its settings hub. The address
 * list, primary address and public copy/link actions stay readable after a live
 * power-level change while administration actions disappear with an explanation. Every
 * read and command stays pinned to the Account and target that opened settings.
 */
@Component({
  selector: 'trn-room-aliases',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room-aliases.component.html',
  providers: [RoomAliasesController],
  imports: [
    EmptyStateComponent,
    FormField,
    TrnButton,
    TrnInput,
    RoomAliasRowComponent,
  ],
})
export class RoomAliasesComponent implements OnChanges {
  private readonly toast = inject(TrnToastService);
  readonly controller = inject(RoomAliasesController);
  protected readonly matrixToUrl = matrixToUrl;

  readonly accountId = input.required<string>();
  readonly roomId = input.required<string>();
  readonly noun = input<'Room' | 'Space'>('Room');
  readonly available = input(true);

  constructor() {
    this.controller.connect(this);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (!changes['accountId'] && !changes['roomId']) {
      if (changes['available'] && this.available()) this.controller.load();
      return;
    }
    this.controller.switchTarget();
    this.controller.load();
  }

  /** Swallow Enter so the enclosing settings form cannot treat this as a global Save. */
  onEnter(event: Event): void {
    event.preventDefault();
    this.controller.add();
  }

  /** Copy an address, selecting its full wrapped value when the Clipboard API fails. */
  copy(alias: string, address: HTMLElement): void {
    let write: Promise<void>;
    try {
      write =
        typeof navigator.clipboard?.writeText === 'function'
          ? navigator.clipboard.writeText(alias)
          : Promise.reject(new Error('Clipboard API unavailable'));
    } catch (error) {
      write = Promise.reject(error);
    }
    void write.then(
      () => this.toast.show('Address copied.', { duration: 2000 }),
      () => {
        this.selectAddress(address);
        this.toast.show(
          'Could not copy the address. It is selected above; copy it manually.',
          { duration: 5000, variant: 'danger' },
        );
      },
    );
  }

  private selectAddress(address: HTMLElement): void {
    const selection = address.ownerDocument.getSelection();
    if (!selection) return;
    address.focus();
    const range = address.ownerDocument.createRange();
    range.selectNodeContents(address);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}
