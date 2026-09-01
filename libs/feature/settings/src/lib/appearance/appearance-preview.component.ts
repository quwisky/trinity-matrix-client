import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A deliberately non-interactive miniature of Trinity's three-pane conversation surface.
 * It consumes only semantic CSS tokens, so the live Mode, Theme, text size and
 * density settings repaint and remeasure it without importing any room feature component.
 */
@Component({
  selector: 'trn-appearance-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-preview.component.html',
  styleUrl: './appearance-preview.component.scss',
})
export class AppearancePreviewComponent {
  readonly modeLabel = input.required<string>();
  readonly themeLabel = input.required<string>();
  readonly densityLabel = input.required<string>();
  readonly timeLabel = input.required<string>();
}
