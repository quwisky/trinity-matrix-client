import {
  Directive,
  ViewContainerRef,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  type ComponentRef,
  type Type,
} from '@angular/core';
import type { ConfigEditorHost } from './config-editor-loader';

/**
 * Puts the lazily-loaded editor on screen and wires it to the document the section holds.
 *
 * The editor's type only exists once its chunk has arrived, so it is created imperatively
 * rather than through `@if`. `NgComponentOutlet` would bind the input but not the output, and
 * the output (the text coming back) is what makes the box dirty.
 *
 * The value flows in from the section's draft and edits flow straight back out, so the editor
 * never holds a document that could drift from the one Apply would check.
 */
@Directive({ selector: '[trnConfigEditorOutlet]' })
export class ConfigEditorOutletDirective {
  private readonly container = inject(ViewContainerRef);

  /** The component from the editor's chunk, once it has loaded. */
  readonly editor = input.required<Type<ConfigEditorHost>>({
    alias: 'trnConfigEditorOutlet',
  });

  /** The document to show. */
  readonly value = input.required<string>();

  /** The document as the user has since typed it. */
  readonly edited = output<string>();

  private readonly mounted = signal<ComponentRef<ConfigEditorHost> | null>(
    null,
  );

  constructor() {
    effect((onCleanup) => {
      const reference = this.container.createComponent(this.editor());
      reference.setInput('value', untracked(this.value));
      const subscription = reference.instance.edited.subscribe((text) =>
        this.edited.emit(text),
      );
      this.mounted.set(reference);
      onCleanup(() => {
        this.mounted.set(null);
        subscription.unsubscribe();
        reference.destroy();
      });
    });

    effect(() => {
      this.mounted()?.setInput('value', this.value());
    });
  }
}
