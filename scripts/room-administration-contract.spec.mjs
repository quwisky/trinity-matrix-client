import { globSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const workspaceRoot = join(import.meta.dirname, '..');

function source(file) {
  return readFileSync(join(workspaceRoot, file), 'utf8');
}

const productionSources = globSync(['apps/**/*.ts', 'libs/**/*.ts'], {
  cwd: workspaceRoot,
})
  .filter((file) => !file.endsWith('.spec.ts'))
  .sort();

const governanceSymbols =
  /\b(?:RoomActionPermissionsService|RoomSettingsService|RoomModerationService|RoomAliasesService|RoomMessageGovernanceService|RoomPinGovernanceService|RoomMembersService|MemberSummary|BannedMember|MemberRole|MEMBER_ROLE_LABEL|MEMBER_ROLE_ORDER|ASSIGNABLE_MEMBER_ROLES|memberRole|ModerationCaps|ActionAvailability|RoomAdministrationError)\b/;
const broadImport =
  /import\s*(?:type\s*)?{([^}]*)}\s*from\s*['"]@trinity\/data-access\/(?:rooms|room-library)['"]/gs;

/** Freeze #318's Room Administration expand-contract migration. */
describe('Room Administration production boundary', () => {
  it('owns governance through one capability entrypoint', () => {
    const entrypoint = source(
      'libs/data-access/room-administration/src/index.ts',
    );

    for (const module of [
      'room-action-permissions.service',
      'room-administration-error',
      'room-members.service',
      'room-member-role',
      'room-settings.service',
      'room-moderation.service',
      'room-aliases.service',
      'room-message-governance.service',
      'room-pin-governance.service',
    ]) {
      expect(entrypoint).toContain(`export * from './lib/${module}'`);
    }
    expect(source('tsconfig.base.json')).toContain(
      '"@trinity/data-access/room-administration"',
    );
    expect(productionSources).not.toContain(
      'libs/feature/rooms/src/lib/shared/member-role.ts',
    );
  });

  it('keeps former governance barrels and caller allowlists empty', () => {
    const offenders = productionSources.filter((file) =>
      [...source(file).matchAll(broadImport)].some((match) =>
        governanceSymbols.test(match[1]),
      ),
    );

    expect(offenders).toEqual([]);
    expect(source('libs/data-access/discovery/src/index.ts')).not.toMatch(
      governanceSymbols,
    );
    expect(source('libs/data-access/room-library/src/index.ts')).not.toMatch(
      governanceSymbols,
    );
  });

  it('keeps Conversation and Room Library on narrow composition-root policies', () => {
    const composition = source(
      'libs/application/runtime/src/lib/composition/application-capability.providers.ts',
    );
    const roomLibrary = productionSources
      .filter((file) => file.startsWith('libs/data-access/room-library/'))
      .map(source)
      .join('\n');
    const conversations = productionSources
      .filter((file) => file.startsWith('libs/data-access/timeline/'))
      .map(source)
      .join('\n');

    expect(roomLibrary).not.toContain(
      "from '@trinity/data-access/room-administration'",
    );
    expect(roomLibrary).toContain('ROOM_LIBRARY_GOVERNANCE_POLICY');
    expect(conversations).not.toContain(
      "from '@trinity/data-access/room-administration'",
    );
    expect(composition).toContain('provide: ROOM_LIBRARY_GOVERNANCE_POLICY');
    expect(composition).toContain('inject(RoomActionPermissionsService)');
    expect(composition).toContain('provide: CONVERSATION_MESSAGE_POLICY');
    expect(composition).toContain('provide: CONVERSATION_PIN_POLICY');
  });

  it('reconciles membership from Matrix state without optimistic edits', () => {
    const members = source(
      'libs/data-access/room-administration/src/lib/room-members.service.ts',
    );
    const moderation = source(
      'libs/data-access/room-administration/src/lib/room-moderation.service.ts',
    );
    const roomLibrary = source(
      'libs/data-access/room-library/src/lib/room-library.service.ts',
    );
    const bannedMembers = source(
      'libs/feature/rooms/src/lib/banned-members/banned-members.component.ts',
    );

    expect(members).toContain('getJoinedMembers()');
    expect(members).toContain('getMembersWithMembership(KnownMembership.Ban)');
    expect(members).toContain('bannedFor(roomId: string | null)');
    expect(members).toContain('RoomStateEvent.Members');
    expect(members).toContain('projectFromClient({');
    expect(moderation).not.toContain('removeMemberFromProjection');
    expect(moderation).not.toContain('bannedMembers(');
    expect(bannedMembers).toContain('this.members.bannedFor(this.roomId())');
    expect(bannedMembers).not.toContain('this.banned.update');
    expect(roomLibrary).not.toMatch(/\b(?:membersFor|membersOf)\s*\(/);
  });

  it('keeps cold commands and typed recovery metadata inside the capability', () => {
    const administration = productionSources
      .filter((file) =>
        file.startsWith('libs/data-access/room-administration/'),
      )
      .map(source)
      .join('\n');

    expect(administration).toContain('return defer(() =>');
    expect(administration).toContain("failure: 'permission-denied'");
    expect(administration).toContain("| 'partial-update';");
    expect(administration).toContain("| 'server-rejected'");
    expect(administration).toContain(
      "failure: partial ? 'partial-update' : 'server-rejected'",
    );
    expect(administration).toContain("recovery: 'refresh-authority'");
    expect(administration).not.toMatch(
      /\basync\s+(?:set|add|remove|kick|ban|unban)/,
    );
  });
});
