import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera, Vector3, type Camera } from 'three';
import {
  clampOrbitState,
  createOverviewOrbit,
  followPose,
  orbitPose,
  resolveCameraTarget,
  type CameraMode,
  type CameraTargetScene,
  type LocalOrbitState,
  type MapDimensions,
} from '../../lib/camera';

export type CameraOrbitAction =
  | { id: number; kind: 'yaw'; amount: number }
  | { id: number; kind: 'pitch'; amount: number }
  | { id: number; kind: 'distance'; amount: number };

export interface CameraProbe {
  sequence: number;
  mode: CameraMode;
  isCanvasCamera: boolean;
  camera: {
    type: string;
    projection: 'orthographic' | 'perspective' | 'unknown';
    zoom?: number;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
    fov?: number;
    aspect?: number;
  };
  orbit?: {
    target: { x: number; y: number; z: number };
    yaw: number;
    pitch: number;
    distance: number;
  };
}

interface CameraControllerProps {
  mode: CameraMode;
  map: MapDimensions;
  viewport: { width: number; height: number };
  scene: CameraTargetScene;
  selectedTokenId?: string;
  orbitAction?: CameraOrbitAction;
}

const SMOOTHING = 8;
const CAMERA_FOV = Math.PI / 3;
type CameraHarness = { camera?: CameraProbe };

function damp(current: number, target: number, delta: number): number {
  return current + (target - current) * (1 - Math.exp(-SMOOTHING * delta));
}

function cameraHarness(): CameraHarness | undefined {
  if (!import.meta.env.DEV) return;
  return (window as Window & { __HEARTH_E2E__?: CameraHarness }).__HEARTH_E2E__;
}

function recordCameraProbe(sequence: number, mode: CameraMode, active: Camera, canvasCamera: Camera, state: LocalOrbitState | undefined): void {
  const harness = cameraHarness();
  if (!harness) return;
  const orthographic = active as OrthographicCamera;
  const perspective = active as PerspectiveCamera;
  const camera = orthographic.isOrthographicCamera
    ? { type: active.type, projection: 'orthographic' as const, zoom: orthographic.zoom, left: orthographic.left, right: orthographic.right, top: orthographic.top, bottom: orthographic.bottom }
    : perspective.isPerspectiveCamera
      ? { type: active.type, projection: 'perspective' as const, fov: perspective.fov, aspect: perspective.aspect }
      : { type: active.type, projection: 'unknown' as const };
  harness.camera = {
    sequence,
    mode,
    isCanvasCamera: active === canvasCamera,
    camera,
    ...(state ? { orbit: { target: { ...state.target }, yaw: state.yaw, pitch: state.pitch, distance: state.distance } } : {}),
  };
}

/** Owns only local R3F cameras and pose interpolation; it never writes scene state. */
export function CameraController({ mode, map, viewport, scene, selectedTokenId, orbitAction }: CameraControllerProps) {
  const { camera: canvasCamera, get, set, size } = useThree();
  const perspective = useMemo(() => new PerspectiveCamera(60, 1, .1, 100_000), []);
  const tacticalCamera = useRef(canvasCamera);
  const orbit = useRef<LocalOrbitState | undefined>(undefined);
  const lastAction = useRef<number | undefined>(undefined);
  const probeSequence = useRef(0);
  const lookTarget = useMemo(() => new Vector3(), []);

  useEffect(() => {
    if (mode === 'tactical') {
      if (get().camera !== tacticalCamera.current) set({ camera: tacticalCamera.current });
      return;
    }
    set({ camera: perspective });
    return () => {
      if (get().camera === perspective) set({ camera: tacticalCamera.current });
    };
  }, [get, mode, perspective, set]);

  useEffect(() => {
    if (mode === 'overview') {
      orbit.current = createOverviewOrbit(map, viewport, { fovRadians: CAMERA_FOV });
    } else if (mode === 'follow') {
      const overview = createOverviewOrbit(map, viewport, { fovRadians: CAMERA_FOV });
      orbit.current = clampOrbitState({ ...overview, distance: Math.max(20, Math.min(overview.distance, 80)) });
    }
  }, [map.height, map.width, mode, viewport.height, viewport.width]);

  useEffect(() => {
    if (!orbitAction || orbitAction.id === lastAction.current || !orbit.current || mode === 'tactical') return;
    lastAction.current = orbitAction.id;
    const next = { ...orbit.current };
    if (orbitAction.kind === 'yaw') next.yaw += orbitAction.amount;
    if (orbitAction.kind === 'pitch') next.pitch += orbitAction.amount;
    if (orbitAction.kind === 'distance') next.distance *= orbitAction.amount;
    orbit.current = clampOrbitState(next);
  }, [mode, orbitAction]);

  useEffect(() => {
    const harness = cameraHarness();
    if (!harness) return;
    recordCameraProbe(++probeSequence.current, mode, get().camera, tacticalCamera.current, orbit.current);
  });

  useEffect(() => {
    perspective.fov = 60;
    perspective.aspect = Math.max(.01, size.width / Math.max(1, size.height));
    perspective.updateProjectionMatrix();
  }, [perspective, size.height, size.width]);

  useFrame((_, delta) => {
    if (mode === 'tactical') return;
    const state = orbit.current;
    if (!state) return;
    const pose = mode === 'follow'
      ? followPose(resolveCameraTarget({ scene, selectedTokenId }), map, { distance: state.distance, pitch: state.pitch, yaw: state.yaw })
      : orbitPose(state);
    const active = perspective;
    active.position.x = damp(active.position.x, pose.position.x, delta);
    active.position.y = damp(active.position.y, pose.position.y, delta);
    active.position.z = damp(active.position.z, pose.position.z, delta);
    lookTarget.set(pose.target.x, pose.target.y, pose.target.z);
    active.up.set(pose.up.x, pose.up.y, pose.up.z);
    active.lookAt(lookTarget);
    active.updateProjectionMatrix();
  });

  return null;
}
