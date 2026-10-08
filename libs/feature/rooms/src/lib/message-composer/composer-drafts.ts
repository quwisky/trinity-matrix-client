import {
  effect,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';

/** What the drafts need from the composer around them. */
export interface ComposerDraftsPorts {
  readonly roomId: Signal<string | null>;
  readonly editing: Signal<boolean>;
  readonly editTargetId: Signal<string | null>;
  /** The body to prefill when an edit starts. */
  readonly draft: Signal<string>;
  /** Conversation-owned draft; null keeps the local per-room store. */
  readonly composeDraft: Signal<string | null>;
  /** The composer's text, which every effect here reads or replaces. */
  readonly text: WritableSignal<string>;
  /** Per-room draft storage. */
  readonly store: {
    get(roomId: string): string;
    set(roomId: string, text: string): void;
  };
  /** Report a typed change of a Conversation-owned draft. */
  readonly emitDraft: (draft: string) => void;
  /** The room changed: drop what belonged to the old one. `prev` is undefined on mount. */
  readonly leaveRoom: (prev: string | null | undefined) => void;
  /** Close the preview, which the replaced text would otherwise leave stale. */
  readonly leavePreview: () => void;
  /** Re-measure the input after a text write. */
  readonly autoGrow: () => void;
  /** Focus the input with the caret at the end, once an edit's text is in. */
  readonly focusAtEnd: () => void;
}

/**
 * Which text the box holds: the draft for the room it shows, the body of the message being
 * edited, or the Conversation's own draft mirrored in.
 *
 * Four effects, created in this order and in the component's injection context: the room
 * switch, the edit prefill, the persistence and the external mirror. They fire in creation
 * order within one change-detection pass when inputs move together, and the `untracked`
 * reads decide which inputs may re-fire them — reordering either changes what a draft
 * becomes. In particular, typing and an external draft landing in the same pass emit the
 * typed text first and the external draft second (persistence before mirror); mirror-first
 * would emit only the external one. A plain class, like the other composer controllers;
 * construct it in the component's constructor.
 */
export class ComposerDrafts {
  private wasEditing = false;
  private wasEditTargetId: string | null = null;
  private wasRoomId: string | null | undefined = undefined;

  constructor(private readonly ports: ComposerDraftsPorts) {
    const { roomId, editing, editTargetId, draft, composeDraft, text, store } =
      ports;

    // On a room/thread change: drop the staged (unsent) attachment — it was staged
    // to send here — and swap drafts. The composer instance is reused across rooms,
    // so without this a half-typed message would leak into the next conversation.
    effect(() => {
      const id = roomId();
      if (id !== this.wasRoomId) {
        const prev = this.wasRoomId;
        this.wasRoomId = id;
        untracked(() => {
          ports.leaveRoom(prev);
          // Drafts only apply to compose mode; in edit mode `text` is the edit body.
          if (!editing()) {
            const managedDraft = composeDraft();
            if (managedDraft === null && prev != null) {
              store.set(prev, text());
            }
            text.set(managedDraft ?? (id != null ? store.get(id) : ''));
            queueMicrotask(() => ports.autoGrow());
          }
        });
      }
    });

    // Prefill on entering edit mode, or when the edit TARGET changes while still
    // editing (a different message was selected). Keyed on editTargetId — not the
    // draft body — and draft() is read untracked, so a mid-edit body change of the
    // same target (redaction, concurrent multi-device edit, a late echo) neither
    // fires this effect nor overwrites the user's in-progress text. Clear on
    // leaving edit mode. Typing never re-fires this (it updates `text`, unread here).
    effect(() => {
      const isEditing = editing();
      const targetId = editTargetId();
      if (
        isEditing &&
        (!this.wasEditing || targetId !== this.wasEditTargetId)
      ) {
        text.set(untracked(() => draft()));
        // Both branches replace the text wholesale, so a preview left open would be showing
        // content that is no longer there — and the focus() below cannot land on a hidden
        // textarea, leaving edit mode apparently unresponsive.
        ports.leavePreview();
        queueMicrotask(() => {
          ports.focusAtEnd();
          ports.autoGrow();
        });
      } else if (!isEditing && this.wasEditing) {
        // Leaving edit mode restores the conversation's compose draft (empty when
        // none), so an edit interlude doesn't discard a half-typed message.
        const id = untracked(() => roomId());
        const managedDraft = untracked(() => composeDraft());
        text.set(managedDraft ?? (id != null ? store.get(id) : ''));
        ports.leavePreview();
        queueMicrotask(() => ports.autoGrow());
      }
      this.wasEditing = isEditing;
      this.wasEditTargetId = targetId;
    });

    // Persist the compose draft on any text change (typing, emoji insert, inline
    // autocomplete). Gated to compose mode and the settled conversation so a room
    // switch's load never cross-saves; sending blanks the field, dropping the draft.
    effect(() => {
      const value = text();
      const id = roomId();
      untracked(() => {
        if (id != null && id === this.wasRoomId) {
          if (composeDraft() === null && !editing()) {
            store.set(id, value);
          } else if (composeDraft() !== null) {
            ports.emitDraft(value);
          }
        }
      });
    });

    // A failed or cancelled runtime send restores its durable draft after this component
    // optimistically clears the textarea. Mirror only external changes; caret-local typing
    // does not trigger this effect because `text` is read untracked.
    effect(() => {
      const managedDraft = composeDraft();
      const isEditing = editing();
      if (managedDraft === null || isEditing) return;
      untracked(() => {
        if (text() !== managedDraft) {
          text.set(managedDraft);
          queueMicrotask(() => ports.autoGrow());
        }
      });
    });
  }
}
