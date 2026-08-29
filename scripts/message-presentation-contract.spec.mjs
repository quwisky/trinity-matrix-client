import { existsSync, globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');
const timelineRoot = 'libs/data-access/timeline/src/lib';
const utilEntrypoint = 'libs/util/matrix/src/index.ts';
const utilMessageView = 'libs/util/matrix/src/lib/message-view.ts';

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter(
    (file) => !file.endsWith('.spec.ts') && !file.endsWith('.spec-harness.ts'),
  )
  .sort();

/**
 * Freeze the Message Presentation boundary introduced by #305.
 *
 * Text and system events must cross the defensive Matrix normalizer and immutable
 * presenter. The old util projection remains only as a temporary fallback for media,
 * location, sticker, and poll migrations owned by later architecture tickets.
 */
describe('Message Presentation production boundary', () => {
  it('keeps the public presentation model in timeline data-access', () => {
    const retiredNames = new Set([
      'MessageView',
      'ReactionView',
      'MessageShield',
      'isEditableMessage',
      'isQuotableMessage',
    ]);
    const utilImports =
      /import\s+(?:type\s+)?{([^}]*)}\s+from\s+['"]@trinity\/util\/matrix['"]/g;
    const bypasses = productionSources.filter((file) =>
      [...source(file).matchAll(utilImports)].some((match) =>
        match[1]
          .split(',')
          .map(
            (name) =>
              name
                .trim()
                .replace(/^type\s+/, '')
                .split(/\s+as\s+/)[0],
          )
          .some((name) => retiredNames.has(name)),
      ),
    );

    expect(bypasses).toEqual([]);
    expect(source('libs/data-access/timeline/src/index.ts')).toContain(
      "export * from './lib/message-presentation';",
    );
  });

  it('routes both timeline surfaces through the single projection entrypoint', () => {
    expect(source(`${timelineRoot}/timeline.service.ts`)).toMatch(
      /projectMessage\(client, room, e(?:, shield)?\)/,
    );
    expect(source(`${timelineRoot}/threads.service.ts`)).toContain(
      'projectMessage(client, room, e, shield)',
    );

    const projection = source(`${timelineRoot}/project-message.ts`);
    expect(projection).toContain(
      'normalizeTimelineEvent(client, room, event, shield)',
    );
    expect(projection).toContain('presentNormalizedTimelineEvent(normalized)');
  });

  it('does not restore the retired util text or system-event API', () => {
    const entrypoint = source(utilEntrypoint);
    const legacy = source(utilMessageView);

    expect(entrypoint).not.toContain("export * from './lib/timeline-event';");
    expect(
      existsSync(
        join(workspaceRoot, `${timelineRoot}/message-presentation.ts`),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(workspaceRoot, `${timelineRoot}/normalize-timeline-event.ts`),
      ),
    ).toBe(true);
    expect(
      existsSync(
        join(workspaceRoot, 'libs/util/matrix/src/lib/timeline-event.ts'),
      ),
    ).toBe(false);
    expect(legacy).not.toMatch(
      /export (?:function|interface) (?:buildMessageView|safeBuildMessageView|MessageView)\b/,
    );
    expect(legacy).not.toMatch(/case ['"]m\.(?:text|emote|notice)['"]:/);
  });

  it('keeps syntax highlighting lazy and feature-local', () => {
    const paths = source('tsconfig.base.json');
    const contract = source('architecture/contract.json');
    const roomsPage = source('libs/feature/rooms/src/lib/rooms/rooms.page.ts');

    expect(paths).not.toContain('@trinity/util/matrix/code-highlight');
    expect(contract).not.toContain('@trinity/util/matrix/code-highlight');
    expect(roomsPage).toContain(
      "import '../message-presentation/code-highlight';",
    );
  });
});
