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
 * The editor cannot be named in a template — its type only exists once its chunk has arrived —
 * so it is created imperatively here rather than through `@if`. `NgComponentOutlet` would bind
 * the input but not the output, and the output is the whole point: the text coming back is what
 * makes the box dirty.
 *
 * One state, two views: the value flows in from the section's draft and the edit flows straight
 * back out, so the editor never holds a document of its own that could drift from the one Apply
 * would check.
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
