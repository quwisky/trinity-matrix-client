import { Injectable, signal } from '@angular/core';

export interface SettingsPart {
  readonly id: string;
  readonly label: string;
  readonly heading: HTMLElement;
}

/** Lowercase ASCII slug: accents folded, other runs of non-alphanumerics become one dash. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Parts of the open settings section, provided by the layout. */
@Injectable()
export class TrnSettingsParts {
  private readonly entries = signal<readonly SettingsPart[]>([]);

  readonly parts = this.entries.asReadonly();
  readonly current = signal<string | null>(null);

  register(part: SettingsPart): () => void {
    this.entries.update((list) =>
      [...list.filter((p) => p.id !== part.id), part].sort((a, b) =>
        a.heading.compareDocumentPosition(b.heading) &
        Node.DOCUMENT_POSITION_FOLLOWING
          ? -1
          : 1,
      ),
    );
    return () => this.entries.update((list) => list.filter((p) => p !== part));
  }
}
