import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewEncapsulation,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { json } from '@codemirror/lang-json';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { lintKeymap, linter, lintGutter } from '@codemirror/lint';
import { EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  hoverTooltip,
  keymap,
  lineNumbers,
  type Tooltip,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { AppConfigService, configJsonSchema } from '@trinity/platform-native';
import type { ConfigEditorHost } from '../config-editor-loader';
import {
  configCompletionSource,
  configDiagnostics,
  configHoverInfo,
  type ConfigHoverInfo,
} from './config-intellisense';

/** The exported document is written with two spaces; typing in it should match. */
const INDENT = '  ';

/** How long typing settles before the document is re-checked. */
const LINT_DELAY = 300;

/**
 * Syntax colours by class rather than by value, so the palette lives in SCSS with the rest of
 * the app's tokens. A `HighlightStyle` that carried colours would be a second theme, blind to
 * light/dark and to the palette the user picked.
 */
const TRINITY_JSON_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.propertyName, class: 'trn-cm-property' },
  { tag: tags.string, class: 'trn-cm-string' },
  { tag: tags.number, class: 'trn-cm-number' },
  { tag: tags.bool, class: 'trn-cm-literal' },
  { tag: tags.null, class: 'trn-cm-literal' },
  { tag: tags.separator, class: 'trn-cm-punctuation' },
  { tag: tags.brace, class: 'trn-cm-punctuation' },
  { tag: tags.squareBracket, class: 'trn-cm-punctuation' },
]);

/**
 * The configuration document in a real editor: completion, hover text and live diagnostics,
 * all of them driven by this app's own settings registry.
 *
 * **Loaded only through `config-editor-loader.ts`'s dynamic import**, which is what keeps
 * CodeMirror in a chunk of its own — nothing may import this module directly, or the editor
 * lands in the settings chunk and every visitor to any settings page pays for it.
 *
 * ## Where the intelligence comes from
 *
 * Not from a JSON Schema fetched from anywhere, and not from a second description of the
 * settings written for the editor's benefit. `configJsonSchema(entries)` generates the model
 * from the same `ConfigEntry` registry that `read`s the document, `validate`s an import and
 * `write`s an applied one — so the values completion offers are the values Apply accepts, and
 * the diagnostics are literally the plan Apply would build (`validateJson`), placed on the
 * ranges the syntax tree says they belong to. The editor and the gate cannot disagree because
 * they are the same check run twice.
 *
 * ## One state, two views
 *
 * The section owns the text. `value` comes in, `edited` goes out, and the editor holds nothing
 * of its own: the document it shows is either the section's live export or the section's draft,
 * never a third thing. That is also why the update listener compares before it emits — a
 * document pushed in from outside must not come straight back out as if it had been typed.
 */
@Component({
  selector: 'trn-config-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // The editor builds its own DOM, which no component stylesheet could reach through emulated
  // encapsulation. Every selector in the stylesheet is under `.trn-config-editor` for it.
  encapsulation: ViewEncapsulation.None,
  templateUrl: './config-editor.component.html',
  styleUrl: './config-editor.component.scss',
})
export class ConfigEditorComponent implements ConfigEditorHost {
  private readonly config = inject(AppConfigService);
  private readonly host =
    viewChild.required<ElementRef<HTMLElement>>('editorHost');
  private readonly view = signal<EditorView | null>(null);

  /** The settings the registry publishes, as the editor's model of the document. */
  private readonly schema = computed(() =>
    configJsonSchema(this.config.entries),
  );

  /** The document to show. */
  readonly value = input.required<string>();

  /** The document as the user has typed it, on every change they make. */
  readonly edited = output<string>();

  constructor() {
    afterNextRender(() => {
      this.view.set(
        new EditorView({
          state: EditorState.create({
            doc: this.value(),
            extensions: this.extensions(),
          }),
          parent: this.host().nativeElement,
        }),
      );
    });

    effect(() => {
      const text = this.value();
      const view = this.view();
      if (!view || view.state.doc.toString() === text) {
        return;
      }
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    });

    inject(DestroyRef).onDestroy(() => this.view()?.destroy());
  }

  private extensions(): readonly Extension[] {
    return [
      lineNumbers(),
      lintGutter(),
      history(),
      json(),
      indentUnit.of(INDENT),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      syntaxHighlighting(TRINITY_JSON_HIGHLIGHT),
      autocompletion({ override: [configCompletionSource(this.schema())] }),
      hoverTooltip((view, pos) => this.tooltip(view.state, pos)),
      linter(
        (view) =>
          configDiagnostics(
            view.state,
            this.config.validateJson(view.state.doc.toString()),
          ),
        { delay: LINT_DELAY },
      ),
      keymap.of([
        ...closeBracketsKeymap,
        ...completionKeymap,
        ...historyKeymap,
        ...lintKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }
        const text = update.state.doc.toString();
        // A document pushed in from the section arrives here as a change too. Emitting it
        // would report the section's own text back to it as an edit, and mark a box dirty
        // that nobody has touched.
        if (text !== this.value()) {
          this.edited.emit(text);
        }
      }),
      EditorView.contentAttributes.of({
        'data-testid': 'advanced-config-editor',
        'aria-label': 'Settings JSON',
      }),
    ];
  }

  private tooltip(state: EditorState, pos: number): Tooltip | null {
    const info = configHoverInfo(this.schema(), state, pos);
    return info
      ? {
          pos: info.from,
          end: info.to,
          above: true,
          create: () => ({ dom: hoverCard(info) }),
        }
      : null;
  }
}

/**
 * The hover card: what this setting is, and — where it is a closed choice — everything it
 * accepts. Built as elements with `textContent` rather than markup, so a description can never
 * be read as HTML.
 */
function hoverCard(info: ConfigHoverInfo): HTMLElement {
  const card = document.createElement('div');
  card.className = 'trn-cm-hover';
  card.setAttribute('data-testid', 'advanced-config-hover');

  const path = document.createElement('div');
  path.className = 'trn-cm-hover__path';
  path.textContent = info.type ? `${info.path} — ${info.type}` : info.path;
  card.appendChild(path);

  const description = document.createElement('div');
  description.className = 'trn-cm-hover__description';
  description.textContent = info.description;
  card.appendChild(description);

  if (info.choices.length > 0) {
    const choices = document.createElement('div');
    choices.className = 'trn-cm-hover__choices';
    choices.textContent = `Accepts: ${info.choices.join(', ')}`;
    card.appendChild(choices);
  }
  return card;
}
