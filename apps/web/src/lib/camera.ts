export type CameraMode = 'tactical' | 'overview' | 'follow';

export interface CameraVector {
  x: number;
  y: number;
  z: number;
}

export interface MapDimensions {
  width: number;
  height: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface LocalOrbitState {
  /** Target in Three-style centered ground coordinates, with Z up. */
  target: CameraVector;
  /** Horizontal rotation in radians. */
  yaw: number;
  /** Elevation above the XY ground plane in radians. */
  pitch: number;
  /** Camera distance from target in map units. */
  distance: number;
}

export interface CameraPose {
  position: CameraVector;
  target: CameraVector;
  up: CameraVector;
}

export interface CameraTargetScene {
  map: MapDimensions | null;
  tokens: Record<string, { position: MapPoint }>;
  initiative: { turnIndex: number | null; entries: Array<{ tokenId: string }> };
}

export interface CameraTargetSelection {
  scene: CameraTargetScene;
  explicitTokenId?: string | null;
  selectedTokenId?: string | null;
}

export interface OverviewOptions {
  fovRadians?: number;
  margin?: number;
  pitch?: number;
  yaw?: number;
}

export interface FollowOptions {
  distance?: number;
  pitch?: number;
  yaw?: number;
}

export const CAMERA_LIMITS = {
  minPitch: 0.05,
  maxPitch: Math.PI / 2 - 0.05,
  minDistance: 0.1,
  maxDistance: 100_000,
} as const;

const DEFAULT_FOV_RADIANS = Math.PI / 3;
const DEFAULT_OVERVIEW_PITCH = Math.PI / 3;
const DEFAULT_OVERVIEW_MARGIN = 1.1;
const DEFAULT_FOLLOW_DISTANCE = 20;
const DEFAULT_FOLLOW_PITCH = Math.PI / 5;
const DEFAULT_YAW = 0;
const UP: CameraVector = { x: 0, y: 0, z: 1 };

function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function positive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function assertMapDimensions(map: MapDimensions): void {
  if (!Number.isFinite(map.width) || map.width <= 0 || !Number.isFinite(map.height) || map.height <= 0) {
    throw new RangeError('Map dimensions must be positive and finite.');
  }
}

function assertMapPoint(point: MapPoint): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) throw new RangeError('Map point must be finite.');
}

export function clampPitch(pitch: number): number {
  return Math.max(CAMERA_LIMITS.minPitch, Math.min(CAMERA_LIMITS.maxPitch, finite(pitch, DEFAULT_OVERVIEW_PITCH)));
}

export function clampDistance(distance: number): number {
  const candidate = finite(distance, DEFAULT_FOLLOW_DISTANCE);
  return Math.max(CAMERA_LIMITS.minDistance, Math.min(CAMERA_LIMITS.maxDistance, candidate));
}

export function clampOrbitState(state: LocalOrbitState): LocalOrbitState {
  return {
    target: { x: finite(state.target.x, 0), y: finite(state.target.y, 0), z: finite(state.target.z, 0) },
    yaw: finite(state.yaw, DEFAULT_YAW),
    pitch: clampPitch(state.pitch),
    distance: clampDistance(state.distance),
  };
}

export function mapPointToThree(point: MapPoint, map: MapDimensions): CameraVector {
  assertMapDimensions(map);
  assertMapPoint(point);
  return { x: point.x - map.width / 2, y: map.height / 2 - point.y, z: 0 };
}

export function orbitPose(state: LocalOrbitState): CameraPose {
  const orbit = clampOrbitState(state);
  const horizontal = orbit.distance * Math.cos(orbit.pitch);
  return {
    position: {
      x: orbit.target.x + horizontal * Math.sin(orbit.yaw),
      y: orbit.target.y + horizontal * Math.cos(orbit.yaw),
      z: orbit.target.z + orbit.distance * Math.sin(orbit.pitch),
    },
    target: { ...orbit.target },
    up: { ...UP },
  };
}

export function resolveCameraTarget(selection: CameraTargetSelection): MapPoint {
  const { scene } = selection;
  const tokenFor = (tokenId: string | null | undefined): MapPoint | undefined => {
    if (!tokenId) return undefined;
    const token = scene.tokens[tokenId];
    if (!token || !Number.isFinite(token.position.x) || !Number.isFinite(token.position.y)) return undefined;
    return { x: token.position.x, y: token.position.y };
  };
  const explicit = tokenFor(selection.explicitTokenId);
  if (explicit) return explicit;
  const selected = tokenFor(selection.selectedTokenId);
  if (selected) return selected;
  const activeIndex = scene.initiative.turnIndex;
  const activeEntry = activeIndex === null ? undefined : scene.initiative.entries[activeIndex];
  const active = tokenFor(activeEntry?.tokenId);
  if (active) return active;
  if (scene.map) return { x: scene.map.width / 2, y: scene.map.height / 2 };
  return { x: 0, y: 0 };
}

export function createOverviewOrbit(map: MapDimensions, viewport: { width: number; height: number }, options: OverviewOptions = {}): LocalOrbitState {
  assertMapDimensions(map);
  if (!Number.isFinite(viewport.width) || viewport.width <= 0 || !Number.isFinite(viewport.height) || viewport.height <= 0) {
    throw new RangeError('Viewport dimensions must be positive and finite.');
  }
  const pitch = clampPitch(options.pitch ?? DEFAULT_OVERVIEW_PITCH);
  const fov = Math.max(0.1, Math.min(Math.PI - 0.1, finite(options.fovRadians ?? DEFAULT_FOV_RADIANS, DEFAULT_FOV_RADIANS)));
  const margin = Math.max(1, positive(options.margin ?? DEFAULT_OVERVIEW_MARGIN, DEFAULT_OVERVIEW_MARGIN));
  const halfFovTangent = Math.tan(fov / 2);
  const aspect = viewport.width / viewport.height;
  const horizontalDistance = map.width / 2 / (aspect * halfFovTangent);
  const verticalDistance = map.height / 2 / (Math.cos(pitch) * halfFovTangent);
  return clampOrbitState({
    target: mapPointToThree({ x: map.width / 2, y: map.height / 2 }, map),
    yaw: options.yaw ?? DEFAULT_YAW,
    pitch,
    distance: Math.max(horizontalDistance, verticalDistance) * margin,
  });
}

export function overviewPose(map: MapDimensions, viewport: { width: number; height: number }, options: OverviewOptions = {}): CameraPose {
  return orbitPose(createOverviewOrbit(map, viewport, options));
}

export function followPose(displayedTokenPosition: MapPoint, map: MapDimensions, options: FollowOptions = {}): CameraPose {
  return orbitPose({
    target: mapPointToThree(displayedTokenPosition, map),
    yaw: options.yaw ?? DEFAULT_YAW,
    pitch: options.pitch ?? DEFAULT_FOLLOW_PITCH,
    distance: options.distance ?? DEFAULT_FOLLOW_DISTANCE,
  });
}

export function tacticalPose(orbit: LocalOrbitState): CameraPose {
  return orbitPose(orbit);
}
