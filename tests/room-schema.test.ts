import { describe, expect, it } from 'vitest';
import { createEmptyScene, createTokenMovementState, type SceneV2 } from '../packages/scene/src/index.js';
import { ArraySchema, MapSchema, RoomScene, roomSchemaToScene, sceneToRoomSchema } from '../packages/room-schema/src/index.js';

describe('Colyseus SceneV2 schema conversion', () => {
  it('uses builder schemas and synchronized collection types', () => {
    const room = new RoomScene();
    expect(room.tokens).toBeInstanceOf(MapSchema);
    expect(room.walls).toBeInstanceOf(MapSchema);
    expect(room.initiative.entries).toBeInstanceOf(ArraySchema);
    expect(room.fog.operations).toBeInstanceOf(ArraySchema);
    expect(room.map).toBeUndefined();
    expect(room.initiative.turnIndex).toBe(-1);
    expect(room.wallRevision).toBe(0);
    expect(room.structureRevision).toBe(0);
  });

  it('round-trips all SceneV2 collections and persisted null fields', () => {
    const scene: SceneV2 = createEmptyScene();
    scene.map = { assetId: 'keep-map', width: 1200, height: 800 };
    scene.grid.visible = false;
    scene.grid.snap = false;
    scene.permissions.playerMovement = 'all';
    scene.permissions.playerPerspectiveView = true;
    scene.wallRevision = 4;
    scene.structureRevision = 6;
    scene.extensions = { rules: { flanking: true }, scale: 2 };
    scene.tokens.hero = {
      id: 'hero', assetId: 'hero-asset', position: { x: -3, y: 7 }, size: { width: 1, height: 2 }, rotation: 370,
      label: 'Hero', ownerId: 'player', hpCurrent: 9, hpMaximum: 12, hpHidden: false, z: 5,
      movement: { ...createTokenMovementState(), allowanceCells: 6, spentCells: 2, activePath: [{ column: -1, row: 2 }], revision: 3 }, revision: 2,
    };
    scene.walls.door = {
      id: 'door', type: 'door', doorState: 'locked', start: { x: 0, y: 0 }, end: { x: 0, y: 5 },
      height: 9, thickness: 0.5, elevation: 2, material: 'masonry', openings: [], revision: 1,
    };
    scene.walls.windowed = {
      id: 'windowed', type: 'blocking', start: { x: 5, y: 0 }, end: { x: 5, y: 5 },
      height: 9, thickness: 0.5, elevation: 2, material: 'wood',
      openings: [{ type: 'window', start: .2, end: .4, bottom: 1, height: 3 }], revision: 2,
    };
    scene.fog = { version: 1, mode: 'per-player', enabled: true, base: 'concealed', revision: 2, operations: [{
      id: 'a', kind: 'reveal', points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 1, y: 1 }], playerId: 'player', revision: 1,
    }] };
    scene.initiative = {
      version: 1, active: true, round: 3, turnIndex: 0,
      entries: [{ id: 'turn', tokenId: 'hero', label: 'Hero', score: 18, hidden: false }],
      revision: 4,
    };
    scene.drawings.line = {
      id: 'line', kind: 'line', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }], color: '#fff', width: 2,
      fill: null, hidden: false, ownerId: 'player', z: 1, revision: 1,
    };
    scene.structures.crate = {
      id: 'crate', kind: 'floor', position: { x: 1, y: 2 }, size: { width: 2, height: 2 }, rotation: 20, label: 'Crate', z: 2,
      material: 'wood', baseElevation: 3, slabHeight: 0.5, revision: 1,
    };
    scene.lights.torch = {
      id: 'torch', position: { x: 2, y: 3 }, radius: 20, color: '#ffaa00', intensity: 0.8, enabled: true, revision: 1,
    };
    scene.effects.smoke = {
      id: 'smoke', position: { x: 3, y: 4 }, radius: 6, label: 'Smoke', duration: 4, z: 3, revision: 1,
    };

    const room = sceneToRoomSchema(scene);
    expect(room.tokens.get('hero')?.hpCurrent).toBe(9);
    expect(room.tokens.get('hero')?.movement.activePath[0]?.column).toBe(-1);
    expect(room.walls.get('door')?.doorState).toBe('locked');
    expect(room.walls.get('windowed')?.openings[0]?.start).toBe(.2);
    expect(room.wallRevision).toBe(4);
    expect(room.structureRevision).toBe(6);
    expect(room.fog.operations[0]?.playerId).toBe('player');
    expect(room.fog).toMatchObject({ enabled: true, base: 'concealed', revision: 2 });
    expect(room.initiative.revision).toBe(4);
    expect(roomSchemaToScene(room)).toEqual(scene);
  });

  it('round-trips the exact persisted empty scene shape', () => {
    const scene = createEmptyScene();
    const room = sceneToRoomSchema(scene);
    expect(roomSchemaToScene(room)).toEqual(scene);
    expect(roomSchemaToScene(room)).toMatchObject({ map: null, initiative: { turnIndex: null } });
  });

  it('validates room state while converting back to a DTO', () => {
    const room = sceneToRoomSchema(createEmptyScene());
    room.grid.cellSize = 0;
    expect(() => roomSchemaToScene(room)).toThrow();
    room.grid.cellSize = 1;
    room.extensions = '{broken';
    expect(() => roomSchemaToScene(room)).toThrow(/extensions/);
  });
});
