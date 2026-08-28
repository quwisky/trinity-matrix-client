import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A deliberately non-interactive miniature of Trinity's three-pane conversation surface.
 * It consumes only semantic CSS tokens, so the live root theme, palette, text-scale and
 * density settings repaint and remeasure it without importing any room feature component.
 */
@Component({
  selector: 'trn-appearance-preview',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './appearance-preview.component.html',
  styleUrl: './appearance-preview.component.scss',
})
export class AppearancePreviewComponent {
  readonly themeLabel = input.required<string>();
  readonly paletteLabel = input.required<string>();
  readonly densityLabel = input.required<string>();
  readonly timeLabel = input.required<string>();
}
