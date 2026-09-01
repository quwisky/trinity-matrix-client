import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { tags } from '@lezer/highlight';

/**
 * Syntax classes keep the selected Trinity Theme authoritative. CodeMirror names the spans;
 * the supported theme extension below resolves their paint from semantic tokens.
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
 * The CodeMirror-owned style module for Trinity's configuration editor.
 *
 * CodeMirror builds its own DOM and mounts style modules in the document root. Supplying its
 * supported `EditorView.theme()` extension keeps that runtime stylesheet ordered after the
 * vendor defaults without introducing a global, unlayered Trinity override. All colours remain
 * semantic tokens, so Mode and Theme changes apply without rebuilding the editor.
 */
const TRINITY_CONFIG_EDITOR_THEME = EditorView.theme({
  '&': {
    background: 'var(--trinity-chat)',
    color: 'var(--trinity-text)',
    border: '1px solid var(--trinity-divider)',
    borderRadius: 'var(--trinity-radius-md)',
    maxHeight: '26rem',
    fontSize: 'calc(0.75rem * var(--trinity-code-scale))',
  },
  '&.cm-focused': {
    outline: '2px solid var(--trinity-accent)',
    outlineOffset: '-1px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, monospace',
    lineHeight: '1.5',
  },
  '.cm-content': {
    caretColor: 'var(--trinity-text)',
  },
  '.cm-gutters': {
    background: 'var(--trinity-surface)',
    color: 'var(--trinity-text-muted)',
    borderRight: '1px solid var(--trinity-divider)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    background: 'var(--trinity-hover)',
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--trinity-text)',
  },
  '.cm-selectionBackground, .cm-content ::selection': {
    background: 'var(--trinity-active)',
  },
  '.cm-matchingBracket': {
    background: 'var(--trinity-active)',
    outline: '1px solid var(--trinity-accent)',
  },
  '.trn-cm-property': {
    color: 'var(--trinity-syntax-variable)',
  },
  '.trn-cm-string': {
    color: 'var(--trinity-syntax-string)',
  },
  '.trn-cm-number': {
    color: 'var(--trinity-syntax-number)',
  },
  '.trn-cm-literal': {
    color: 'var(--trinity-syntax-keyword)',
  },
  '.trn-cm-punctuation': {
    color: 'var(--trinity-syntax-punctuation)',
  },
  '.cm-diagnostic-error': {
    borderLeftColor: 'var(--trinity-danger)',
  },
  '.cm-diagnostic-warning': {
    borderLeftColor: 'var(--trinity-status-warning-surface)',
  },
  '.cm-lintRange-error': {
    background:
      'linear-gradient(var(--trinity-danger), var(--trinity-danger)) 0 100% / 100% 2px no-repeat',
  },
  '.cm-lintRange-warning': {
    background:
      'linear-gradient(var(--trinity-status-warning-surface), var(--trinity-status-warning-surface)) 0 100% / 100% 2px no-repeat',
  },
  '.cm-lint-marker-error': {
    color: 'var(--trinity-danger)',
  },
  '.cm-lint-marker-warning': {
    color: 'var(--trinity-status-warning-surface)',
  },
  '.cm-tooltip': {
    background: 'var(--trinity-surface-card)',
    color: 'var(--trinity-text)',
    border: '1px solid var(--trinity-divider)',
    borderRadius: 'var(--trinity-radius-md)',
    boxShadow: 'var(--trinity-shadow-floating)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    background: 'var(--trinity-accent)',
    color: 'var(--trinity-accent-foreground)',
  },
  '.cm-completionDetail': {
    color: 'var(--trinity-text-muted)',
    fontStyle: 'normal',
  },
  '.cm-completionInfo': {
    background: 'var(--trinity-surface-card)',
    color: 'var(--trinity-text)',
    border: '1px solid var(--trinity-divider)',
    borderRadius: 'var(--trinity-radius-md)',
    maxWidth: '22rem',
  },
  '.trn-cm-hover': {
    padding: '0.5rem 0.625rem',
    maxWidth: '24rem',
  },
  '.trn-cm-hover__path': {
    fontFamily: 'ui-monospace, monospace',
    fontSize: '0.75rem',
    color: 'var(--trinity-text-muted)',
  },
  '.trn-cm-hover__description': {
    paddingTop: '0.25rem',
    fontSize: '0.8125rem',
  },
  '.trn-cm-hover__choices': {
    paddingTop: '0.25rem',
    fontSize: '0.75rem',
    color: 'var(--trinity-text-muted)',
  },
});

export const TRINITY_CONFIG_EDITOR_THEME_EXTENSIONS: readonly Extension[] = [
  TRINITY_CONFIG_EDITOR_THEME,
  syntaxHighlighting(TRINITY_JSON_HIGHLIGHT),
];
