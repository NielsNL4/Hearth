import { Client, type Room } from '@colyseus/sdk';
import { RoomScene, type RoomScene as RoomSceneState } from '@hearth/room-schema';

const ENDPOINT = 'ws://127.0.0.1:2567';
const TIMEOUT_MS = 15_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FAILURE = 'M4 smoke failed.';

type SmokeRoom = Room<any, RoomSceneState>;
type StatePredicate = (state: RoomSceneState) => boolean;

function requiredEnvironment(name: 'M4_SMOKE_ROOM_ID' | 'M4_SMOKE_DM_TOKEN' | 'M4_SMOKE_PLAYER_TOKEN'): string {
  const value = process.env[name];
  if (!value) throw new Error('Missing smoke configuration.');
  return value;
}

function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Smoke operation timed out.')), TIMEOUT_MS);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function waitForState(room: SmokeRoom, predicate: StatePredicate): Promise<RoomSceneState> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      room.onStateChange.remove(onState);
      reject(new Error('Authoritative state callback timed out.'));
    }, TIMEOUT_MS);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      room.onStateChange.remove(onState);
      callback();
    };
    const onState = (state: RoomSceneState) => {
      if (!predicate(state)) return;
      finish(() => resolve(state));
    };
    room.onStateChange(onState);
  });
}

function sendCommand(room: SmokeRoom, type: string, payload: unknown): Promise<void> {
  const commandId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(() => reject(new Error('Command acknowledgement timed out.'))), TIMEOUT_MS);
    const removeMessage = room.onMessage('command.result', (raw: unknown) => {
      if (typeof raw !== 'object' || raw === null) return;
      const message = raw as { commandId?: unknown; type?: unknown; ok?: unknown; sceneRevision?: unknown };
      if (message.commandId !== commandId) return;
      if (message.type !== type || message.ok !== true || typeof message.sceneRevision !== 'number') {
        finish(() => reject(new Error('Command acknowledgement was rejected.')));
        return;
      }
      finish(resolve);
    });
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeMessage();
      callback();
    };
    try {
      room.send(type, { commandId, payload });
    } catch {
      finish(() => reject(new Error('Command could not be sent.')));
    }
  });
}

function hasCreatedRoof(state: RoomSceneState, structureId: string, expectedRevision: number): boolean {
  return state.permissions.playerPerspectiveView === true
    && state.structureRevision === expectedRevision
    && state.structures.has(structureId)
    && state.structures.get(structureId)?.kind === 'roof';
}

async function leaveRoom(room: SmokeRoom | undefined): Promise<void> {
  if (!room) return;
  try {
    await withTimeout(Promise.resolve(room.leave(false)));
  } catch {
    // Cleanup is best effort after a failed smoke run.
  }
}

async function run(): Promise<void> {
  const roomId = requiredEnvironment('M4_SMOKE_ROOM_ID');
  const dmToken = requiredEnvironment('M4_SMOKE_DM_TOKEN');
  const playerToken = requiredEnvironment('M4_SMOKE_PLAYER_TOKEN');
  if (!UUID_PATTERN.test(roomId)) throw new Error('Smoke room ID is not a UUID.');

  const dmClient = new Client(ENDPOINT);
  const playerClient = new Client(ENDPOINT);
  let dmRoom: SmokeRoom | undefined;
  let playerRoom: SmokeRoom | undefined;
  let reconnectedPlayerRoom: SmokeRoom | undefined;
  try {
    dmRoom = await withTimeout(dmClient.joinOrCreate('battle', { databaseRoomId: roomId, accessToken: dmToken }, RoomScene) as Promise<SmokeRoom>);
    playerRoom = await withTimeout(playerClient.joinOrCreate('battle', { databaseRoomId: roomId, accessToken: playerToken }, RoomScene) as Promise<SmokeRoom>);

    const expectedStructureRevision = dmRoom.state.structureRevision;
    const structureId = crypto.randomUUID();
    const roof = {
      id: structureId,
      kind: 'roof' as const,
      position: { x: 100, y: 100 },
      size: { width: 100, height: 100 },
      rotation: 0,
      label: 'Milestone 4 smoke roof',
      z: 0,
      material: 'default' as const,
      baseElevation: 0,
      slabHeight: 8,
    };
    if ('revision' in roof) throw new Error('Smoke roof unexpectedly contains a revision.');

    const dmState = waitForState(dmRoom, (state) => hasCreatedRoof(state, structureId, expectedStructureRevision + 1));
    const playerState = waitForState(playerRoom, (state) => hasCreatedRoof(state, structureId, expectedStructureRevision + 1));
    await sendCommand(dmRoom, 'permissions.playerPerspectiveView.set', { enabled: true });
    await sendCommand(dmRoom, 'structure.create', { structure: roof, expectedStructureRevision });
    await Promise.all([dmState, playerState]);

    const reconnectionToken = playerRoom.reconnectionToken;
    playerRoom.reconnection.enabled = false;
    playerRoom.connection.close();
    reconnectedPlayerRoom = await withTimeout(playerClient.reconnect(reconnectionToken, RoomScene) as Promise<SmokeRoom>);
    if (!hasCreatedRoof(reconnectedPlayerRoom.state, structureId, expectedStructureRevision + 1)) {
      throw new Error('Reconnected state did not retain the smoke changes.');
    }
  } finally {
    await leaveRoom(reconnectedPlayerRoom);
    await leaveRoom(playerRoom);
    await leaveRoom(dmRoom);
  }
}

try {
  await run();
  console.log('M4 smoke passed.');
} catch {
  console.error(FAILURE);
  process.exitCode = 1;
}
