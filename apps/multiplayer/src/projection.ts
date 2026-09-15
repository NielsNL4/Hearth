import {
  createPresentedDrawing,
  createPresentedHp,
  createPresentedInitiativeEntry,
  createPresentedToken,
  parseActorProjectionV1,
  type ActorProjectionV1,
  type ProjectionStreamMetadata,
} from '@hearth/domain';
import { parseSceneV2, wallBlocksVision, type SceneV2, type TokenRecord } from '@hearth/scene';
import {
  canCreateDrawing,
  canEditDrawing,
  canEditInitiativeEntry,
  canEditToken,
  canMoveToken,
} from './engine.js';
import type { Actor } from './contracts.js';

export interface ActorProjectionBuildOptions {
  streamId: string;
  sceneRevision: number;
  projectionRevision: number;
  previous?: ProjectionStreamMetadata;
  streamReset?: boolean;
  failClosed?: boolean;
}

const tokenMovementRevision = (token: TokenRecord): number => token.movement?.revision ?? 0;

function derivedPresentationId(prefix: string, sourceId: string): string {
  let hash = 0x811c9dc5;
  for (const character of sourceId) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}-${hash.toString(16).padStart(8, '0')}`;
}

function tokenCanTransform(actor: Actor, scene: SceneV2, token: TokenRecord): boolean {
  if (!canMoveToken(actor, scene, token)) return false;
  return actor.role === 'dm' || !scene.initiative.active || (token.movement?.allowanceCells ?? null) === null;
}

function presentedToken(token: TokenRecord, actor: Actor) {
  const canPresentHp = actor.role === 'dm' || !token.hpHidden;
  const hp = canPresentHp && token.hpCurrent <= token.hpMaximum
    ? createPresentedHp(token.hpCurrent, token.hpMaximum)
    : undefined;
  return createPresentedToken(token, hp);
}

function presentedFog(scene: SceneV2): ActorProjectionV1['fog'] {
  // Until a faithful derived fog composer exists, even the omniscient DM
  // receives the explicit no-fog presentation rather than operation history.
  return { mode: 'disabled' };
}

function editableGeometry(scene: SceneV2): NonNullable<ActorProjectionV1['controls']['geometry']['editableGeometry']> {
  return {
    walls: Object.values(scene.walls).map((wall) => {
      const base = {
        wallId: wall.id,
        start: wall.start,
        end: wall.end,
        height: wall.height,
        thickness: wall.thickness,
        elevation: wall.elevation,
        material: wall.material,
        openings: wall.openings.map(({ start, end, bottom, height }) => ({ start, end, bottom, height })),
        recordRevision: wall.revision,
      };
      return wall.type === 'door'
        ? { ...base, wallKind: 'door' as const, doorState: wall.doorState }
        : { ...base, wallKind: wall.type };
    }),
    structures: Object.values(scene.structures).map((structure) => ({
      structureId: structure.id,
      structureKind: structure.kind,
      position: structure.position,
      size: structure.size,
      rotation: structure.rotation,
      label: structure.label,
      z: structure.z,
      material: structure.material,
      baseElevation: structure.baseElevation,
      slabHeight: structure.slabHeight,
      recordRevision: structure.revision,
    })),
  };
}

function wallMesh(scene: SceneV2): ActorProjectionV1['wallMesh'] {
  return {
    segments: Object.values(scene.walls).filter(wallBlocksVision).map((wall) => ({
      id: derivedPresentationId('mesh', wall.id),
      start: wall.start,
      end: wall.end,
      height: wall.height,
      thickness: wall.thickness,
      elevation: wall.elevation,
      material: wall.material,
      openings: wall.openings.map(({ start, end, bottom, height }) => ({ start, end, bottom, height })),
    })),
  };
}

function actorFog(scene: SceneV2, actor: Actor): ActorProjectionV1['fog'] {
  if (actor.role === 'dm') return presentedFog(scene);
  // Until Gate 5A provides a LOS solver, enabled player fog fails closed.
  if (scene.fog.enabled ?? false) return { mode: 'visible-regions', polygons: [] };
  return { mode: 'disabled' };
}

export function buildActorProjectionV1(
  inputScene: SceneV2,
  actor: Actor,
  options: ActorProjectionBuildOptions,
): ActorProjectionV1 {
  const scene = parseSceneV2(inputScene);
  const isDm = actor.role === 'dm';
  const failClosed = options.failClosed === true && !isDm;
  const fogEnabledForPlayer = !isDm && ((scene.fog.enabled ?? false) || failClosed);
  const presentedTokens = Object.values(scene.tokens)
    .filter((token) => !fogEnabledForPlayer || token.ownerId === actor.userId)
    .map((token) => presentedToken(token, actor));
  const presentedDrawings = fogEnabledForPlayer
    ? []
    : Object.values(scene.drawings).map((drawing) => createPresentedDrawing(isDm ? { ...drawing, hidden: false } : drawing)).filter((drawing): drawing is NonNullable<typeof drawing> => drawing !== null);
  const presentedInitiative = fogEnabledForPlayer
    ? { active: false, round: 0, turnIndex: null, entries: [] }
    : {
      active: scene.initiative.active,
      round: scene.initiative.round,
      turnIndex: scene.initiative.turnIndex ?? null,
      entries: scene.initiative.entries
        .map((entry) => createPresentedInitiativeEntry(isDm ? { ...entry, hidden: false } : entry, { includeHiddenPlaceholder: true }))
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null),
    };

  const tokenControls = presentedTokens.map((presented) => {
    const token = scene.tokens[presented.id]!;
    return {
      tokenId: presented.id,
      canTransform: tokenCanTransform(actor, scene, token),
      canUpdateDetails: canEditToken(actor, token),
      canDelete: canEditToken(actor, token),
      expectedTokenRevision: token.revision,
      expectedMovementRevision: tokenMovementRevision(token),
    };
  });
  const drawingControls = presentedDrawings.map((presented) => {
    const drawing = scene.drawings[presented.id]!;
    return {
      drawingId: presented.id,
      canUpdate: canEditDrawing(actor, scene, drawing),
      canDelete: canEditDrawing(actor, scene, drawing),
      expectedRecordRevision: drawing.revision,
    };
  });
  const initiativeControls = presentedInitiative.entries
    .filter((entry): entry is Extract<typeof entry, { id: string }> => 'id' in entry)
    .map((entry) => {
      const source = scene.initiative.entries.find((candidate) => candidate.id === entry.id)!;
      const active = scene.initiative.active && scene.initiative.turnIndex !== null &&
        scene.initiative.entries[scene.initiative.turnIndex]?.id === source.id;
      return {
        entryId: source.id,
        canUpdate: canEditInitiativeEntry(actor, scene, source),
        canRemove: canEditInitiativeEntry(actor, scene, source) && (isDm || !active),
      };
    });
  const anyOwnedToken = Object.values(scene.tokens).some((token) => canMoveToken(actor, scene, token));
  const playerDrawingPolicy = scene.permissions.playerDrawing ?? 'own';

  const projection = {
    protocolVersion: 1 as const,
    kind: 'full' as const,
    streamId: options.streamId,
    sceneRevision: options.sceneRevision,
    projectionRevision: options.projectionRevision,
    ...(options.streamReset ? { streamReset: { kind: 'initial' as const } } : {}),
    scene: {
      map: scene.map ? { assetId: scene.map.assetId, width: scene.map.width, height: scene.map.height } : null,
      grid: { ...scene.grid, offset: { ...scene.grid.offset } },
      tokens: presentedTokens,
      drawings: presentedDrawings,
      initiative: presentedInitiative,
    },
    sight: isDm || !fogEnabledForPlayer ? { mode: 'unrestricted' as const } : { mode: 'restricted' as const, polygons: [] },
    fog: actorFog(scene, actor),
    wallMesh: !fogEnabledForPlayer ? wallMesh(scene) : { segments: [] },
    lights: !fogEnabledForPlayer ? Object.values(scene.lights).map(({ id, position, radius, color, intensity, enabled }) => ({ id: derivedPresentationId('light', id), position, radius, color, intensity, enabled })) : [],
    controls: {
      movement: {
        canMove: isDm || anyOwnedToken,
        canSetPolicy: isDm,
        policy: scene.permissions.playerMovement,
        expectedNavigationRevision: scene.navigationRevision ?? 0,
      },
      // token.create is available to players only for a token they own; the
      // owner field is supplied by the authenticated command actor.
      tokens: { canCreate: true, records: tokenControls },
      drawings: {
        canCreate: canCreateDrawing(actor, scene),
        canSetPolicy: isDm,
        policy: playerDrawingPolicy,
        expectedDrawingRevision: scene.drawingRevision ?? 0,
        records: drawingControls,
      },
      initiative: {
        canAdd: isDm || Object.values(scene.tokens).some((token) => canEditToken(actor, token)),
        canReorder: isDm,
        canStart: isDm,
        canAdvance: isDm,
        canStop: isDm,
        expectedInitiativeRevision: scene.initiative.revision ?? 0,
        records: initiativeControls,
      },
      fog: {
        canCommit: isDm,
        canUndo: isDm,
        canClear: isDm,
        expectedFogRevision: scene.fog.revision ?? 0,
        latestOperationId: isDm ? scene.fog.operations.at(-1)?.id ?? null : null,
      },
      geometry: {
        canCreateWall: isDm,
        canUpdateWall: isDm,
        canDeleteWall: isDm,
        canCreateStructure: isDm,
        canUpdateStructure: isDm,
        canDeleteStructure: isDm,
        expectedWallRevision: scene.wallRevision ?? 0,
        expectedStructureRevision: scene.structureRevision ?? 0,
        ...(isDm ? { editableGeometry: editableGeometry(scene) } : {}),
      },
      perspective: { canUse: isDm || (scene.permissions.playerPerspectiveView ?? false), canSet: isDm, enabled: scene.permissions.playerPerspectiveView ?? false },
    },
  };
  return parseActorProjectionV1(projection, options.previous);
}
