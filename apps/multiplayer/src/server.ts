import { defineRoom } from '@colyseus/core';
import defineServer from '@colyseus/tools';
import type { Application, Request, Response } from 'express';
import type { BattleRoomDependencies } from './room.js';
import { createBattleRoom } from './room.js';

export function createServerConfig(dependencies: BattleRoomDependencies) {
  const BattleRoom = createBattleRoom(dependencies);
  return defineServer({
    rooms: {
      battle: defineRoom(BattleRoom).filterBy(['roomId']),
    },
    initializeExpress(app: Application) {
      app.get('/health', (_request: Request, response: Response) => response.status(200).json({ status: 'ok' }));
    },
  });
}
