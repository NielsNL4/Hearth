import { describe, expect, it } from 'vitest';
import {
  CAMERA_LIMITS,
  clampDistance,
  clampOrbitState,
  clampPitch,
  followPose,
  mapPointToThree,
  overviewPose,
  resolveCameraTarget,
} from '../apps/web/src/lib/camera.js';

const scene = {
  map: { width: 200, height: 100 },
  tokens: {
    explicit: { position: { x: 10, y: 20 } },
    selected: { position: { x: 30, y: 40 } },
    active: { position: { x: 50, y: 60 } },
  },
  initiative: { turnIndex: 0, entries: [{ tokenId: 'active' }] },
};

describe('pure local camera math', () => {
  it('clamps pitch and distance without mutating orbit state', () => {
    const state = { target: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: -2, distance: 0 };
    const clamped = clampOrbitState(state);
    expect(clamped).toEqual({ target: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: CAMERA_LIMITS.minPitch, distance: CAMERA_LIMITS.minDistance });
    expect(state).toEqual({ target: { x: 1, y: 2, z: 3 }, yaw: 4, pitch: -2, distance: 0 });
    expect(clampPitch(100)).toBe(CAMERA_LIMITS.maxPitch);
    expect(clampDistance(1_000_000)).toBe(CAMERA_LIMITS.maxDistance);
  });

  it('resolves explicit, selected, active, and map-center targets in priority order', () => {
    expect(resolveCameraTarget({ scene, explicitTokenId: 'explicit', selectedTokenId: 'selected' })).toEqual({ x: 10, y: 20 });
    expect(resolveCameraTarget({ scene, explicitTokenId: 'missing', selectedTokenId: 'selected' })).toEqual({ x: 30, y: 40 });
    expect(resolveCameraTarget({ scene, selectedTokenId: 'missing' })).toEqual({ x: 50, y: 60 });
    expect(resolveCameraTarget({ scene: { ...scene, initiative: { turnIndex: null, entries: [] } } })).toEqual({ x: 100, y: 50 });
  });

  it('centers and inverts canonical top-left map coordinates', () => {
    expect(mapPointToThree({ x: 0, y: 0 }, { width: 200, height: 100 })).toEqual({ x: -100, y: 50, z: 0 });
    expect(mapPointToThree({ x: 200, y: 100 }, { width: 200, height: 100 })).toEqual({ x: 100, y: -50, z: 0 });
  });

  it('creates deterministic overview and follow poses without scene mutation', () => {
    const overviewA = overviewPose({ width: 200, height: 100 }, { width: 800, height: 600 });
    const overviewB = overviewPose({ width: 200, height: 100 }, { width: 800, height: 600 });
    expect(overviewA).toEqual(overviewB);
    expect(overviewA.target).toEqual({ x: 0, y: 0, z: 0 });
    expect(overviewA.position).toEqual({ x: 0, y: 95.26279441628826, z: 164.99999999999997 });

    const displayed = { ...scene.tokens.active.position };
    const before = structuredClone(scene);
    const followA = followPose(displayed, scene.map, { yaw: Math.PI / 2, pitch: Math.PI / 6, distance: 20 });
    const followB = followPose(displayed, scene.map, { yaw: Math.PI / 2, pitch: Math.PI / 6, distance: 20 });
    expect(followA).toEqual(followB);
    expect(followA.target).toEqual({ x: -50, y: -10, z: 0 });
    expect(followA.position).toEqual({ x: -32.67949192431122, y: -9.999999999999998, z: 9.999999999999998 });
    expect(followA.up).toEqual({ x: 0, y: 0, z: 1 });
    expect(scene).toEqual(before);
  });
});
