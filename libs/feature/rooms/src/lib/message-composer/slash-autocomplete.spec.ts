import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS } from '@trinity/util/matrix';
import { SlashAutocomplete } from './slash-autocomplete';

/** Sync against the end of `text`, which is where the caret is while typing. */
function typed(text: string): SlashAutocomplete {
  const engine = new SlashAutocomplete();
  engine.sync(text, text.length);
  return engine;
}

const names = (engine: SlashAutocomplete) =>
  engine.matches().map((command) => command.name);

describe('SlashAutocomplete', () => {
  it('offers everything for a bare slash', async () => {
    // How anyone finds out these exist: there is no other affordance for them in the app.
    const engine = typed('/');

    expect(engine.open()).toBe(true);
    expect(names(engine)).toEqual(SLASH_COMMANDS.map((c) => c.name));
  });

  it('narrows as the name is typed', async () => {
    expect(names(typed('/s'))).toEqual(['shrug', 'spoiler']);
    expect(names(typed('/sh'))).toEqual(['shrug']);
  });

  it('closes on a name that matches nothing', async () => {
    // `/method` and `/etc/passwd` send as literal text, so offering a menu over them would be
    // promising a command that does not exist.
    const engine = typed('/nope');

    expect(engine.open()).toBe(false);
  });

  it('only triggers at the start of the message', async () => {
    // The parser only ever matches a LEADING command, so a menu mid-sentence would complete
    // something that then sends as plain text.
    expect(typed('hello /me').open()).toBe(false);
    expect(typed('  /me').open()).toBe(false);
  });

  it('closes once the command has an argument', async () => {
    // `/me ` is finished as far as the menu is concerned — what follows is the message.
    expect(typed('/me waves').open()).toBe(false);
    expect(typed('/me ').open()).toBe(false);
  });

  it('is case-insensitive, like the parser', async () => {
    expect(names(typed('/SH'))).toEqual(['shrug']);
  });

  it('accepts with a trailing space, which the parser needs', async () => {
    // Without it the next keystroke lands against the name — `/mehello` sends as literal text.
    const engine = typed('/m');

    expect(engine.accept('/m', 2, 0)).toEqual({
      start: 0,
      end: 2,
      insert: '/me ',
    });
  });

  it('accepts nothing when the caret has drifted off the fragment', async () => {
    const engine = typed('/m');

    expect(engine.accept('hello', 5, 0)).toBeNull();
  });

  it('accepts nothing for an index with no command behind it', async () => {
    const engine = typed('/m');

    expect(engine.accept('/m', 2, 9)).toBeNull();
  });

  it('wraps the highlight in both directions', async () => {
    const engine = typed('/s'); // shrug, spoiler

    expect(engine.move(1)).toBe(1);
    expect(engine.move(1)).toBe(0);
    expect(engine.move(-1)).toBe(1);
  });

  it('has nothing to move when the menu is closed', async () => {
    expect(typed('/nope').move(1)).toBeNull();
  });

  it('describes every command it offers', async () => {
    // The descriptions are the whole point of a menu over a list of names, and they come from
    // `@trinity/util/matrix` so they cannot drift from what the parser accepts.
    for (const command of typed('/').matches()) {
      expect(command.description, command.name).toBeTruthy();
    }
  });

  it('returns the highlight to the top when the fragment narrows the list', () => {
    // Otherwise the index outlives the list it indexed: highlight the last command on a bare
    // `/`, type one more letter, and `accept` looks up a match that no longer exists — Enter
    // is swallowed by the open menu and nothing happens at all.
    const engine = new SlashAutocomplete();
    engine.sync('/', 1);
    engine.move(-1);
    expect(engine.activeIndex()).toBe(SLASH_COMMANDS.length - 1);

    engine.sync('/sh', 3);

    expect(engine.activeIndex()).toBe(0);
    expect(engine.accept('/sh', 3, engine.activeIndex())).toEqual({
      start: 0,
      end: 3,
      insert: '/shrug ',
    });
  });

  it('keeps the highlight while the fragment is unchanged', () => {
    // A caret move or a toolbar edit elsewhere in the message re-syncs the same fragment;
    // that must not yank the highlight back from wherever the user arrowed it to.
    const engine = new SlashAutocomplete();
    engine.sync('/', 1);
    engine.move(1);

    engine.sync('/', 1);

    expect(engine.activeIndex()).toBe(1);
  });
});
