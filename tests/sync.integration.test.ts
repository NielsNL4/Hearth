import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listen } from '@colyseus/tools';
import { createEmptyScene, type SceneV2 } from '@hearth/scene';
import { createMultiplayerConnection } from '../packages/sync/src/index.js';
import { createServerConfig } from '../apps/multiplayer/src/server.js';
import type { Actor, AuthProvider, Persistence } from '../apps/multiplayer/src/contracts.js';

const roomId = '10000000-0000-4000-8000-000000000000';
const accessToken = 'in-memory-test-token';
const actor: Actor = { userId: 'integration-user', role: 'player', displayName: 'Integration User' };

class InMemoryPersistence implements Persistence {
  private readonly scene: SceneV2 = createEmptyScene();

  async loadRoomState(requestedRoomId: string) {
    return { roomId: requestedRoomId, scene: structuredClone(this.scene), sceneRevision: 0 };
  }

  async getRoomAsset() { return null; }

  async commitRoomState() {
    return { roomId, sceneRevision: 1, eventId: 1 };
  }

  async reserveRoomAsset(input: Parameters<Persistence['reserveRoomAsset']>[0]) {
    return {
      id: '20000000-0000-4000-8000-000000000000', roomId: input.roomId, status: 'reserved',
      sourceObjectKey: 'source', outputObjectPrefix: 'output/',
    };
  }
}

const auth: AuthProvider = {
  async verifyAccessToken(token) {
    if (token !== accessToken) throw new Error('Unexpected test access token.');
    return { userId: actor.userId };
  },
  async getMembership(requestedRoomId, userId) {
    return requestedRoomId === roomId && userId === actor.userId ? actor : null;
  },
};

describe('real Colyseus SDK integration', () => {
  let server: Awaited<ReturnType<typeof listen>>;

  beforeAll(async () => {
    server = await listen(createServerConfig({ auth, persistence: new InMemoryPersistence() }), 0);
  });

  afterAll(async () => {
    await server.gracefullyShutdown(false);
  });

  it('joins the real room and exposes presence-only schema state', async () => {
    const connection = createMultiplayerConnection({
      endpoint: `http://127.0.0.1:${(server.transport.server?.address() as { port: number }).port}`,
      roomId,
      accessToken,
      onStatus() {},
      onProjection() {},
    });

    try {
      await connection.connect();
      expect(connection.getRoom()?.state.connections).toBeDefined();
    } finally {
      await connection.disconnect();
    }
  });
});
