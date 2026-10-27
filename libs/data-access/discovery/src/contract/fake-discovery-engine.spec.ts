import { defineDiscoveryEngineContract } from './discovery-engine.contract';
import { FakeDiscoveryEngine } from './fake-discovery-engine';

defineDiscoveryEngineContract(async () => {
  const engine = new FakeDiscoveryEngine();
  engine.accounts.add('@me:example.org');
  engine.servers.set('example.org', 'https://matrix.example.org');
  engine.rooms.push({
    roomId: '!lobby:example.org',
    name: 'Lobby',
    topic: null,
    alias: '#lobby:example.org',
    avatarMxc: null,
    memberCount: 3,
    isSpace: false,
  });
  const preview = {
    canonicalAddress: null,
    topic: null,
    avatarMxc: null,
    memberCount: 1,
    encrypted: null,
    joinRule: 'public',
    membership: 'leave',
    isSpace: false,
    via: [],
    restrictedEligible: false,
  } as const;
  engine.previews.push(
    {
      ...preview,
      roomId: '!plaza:example.org',
      name: 'Plaza',
      canonicalAddress: '#plaza:example.org',
    },
    {
      ...preview,
      roomId: '!mine:example.org',
      name: 'Mine',
      membership: 'join',
      encrypted: false,
    },
    {
      ...preview,
      roomId: '!door:example.org',
      name: 'Door',
      joinRule: 'knock',
    },
  );
  engine.users.push({
    userId: '@bob:example.org',
    displayName: 'Bob',
    avatarMxc: null,
  });
  return {
    engine,
    accountId: '@me:example.org',
    domain: 'example.org',
    publicRoom: {
      roomId: '!lobby:example.org',
      name: 'Lobby',
      alias: '#lobby:example.org',
    },
    unjoinedRoom: {
      roomId: '!plaza:example.org',
      name: 'Plaza',
      alias: '#plaza:example.org',
    },
    joinedRoom: { roomId: '!mine:example.org', name: 'Mine' },
    knockRoom: { roomId: '!door:example.org' },
    otherUser: { userId: '@bob:example.org', displayName: 'Bob' },
  };
});
