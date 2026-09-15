import { useEffect, useMemo } from 'react';
import type { ProjectionStructure as StructureRecord } from '../../lib/projectionModel';
import { BoxGeometry, DoubleSide, MeshStandardMaterial, type ColorRepresentation } from 'three';

export type StructurePresentation = 'exterior' | 'tactical' | 'cutaway' | 'follow';
type StructureKind = 'block' | 'floor' | 'roof';
type StructureMaterial = 'default' | 'masonry' | 'wood' | 'metal';

interface StructureVisual {
  color: ColorRepresentation;
  roughness: number;
  metalness: number;
  opacity?: number;
}

const materialVisuals: Record<StructureMaterial, StructureVisual> = {
  default: { color: '#aab9a4', roughness: .72, metalness: .04 },
  masonry: { color: '#9a9b91', roughness: .94, metalness: .01 },
  wood: { color: '#a8794f', roughness: .8, metalness: .02 },
  metal: { color: '#788d91', roughness: .32, metalness: .72 },
};

function visualFor(kind: StructureKind, material: StructureMaterial): StructureVisual {
  const base = materialVisuals[material];
  if (kind === 'floor') return { ...base, color: '#8eaa96', roughness: Math.min(1, base.roughness + .08) };
  if (kind === 'roof') return { ...base, color: '#657d6d', roughness: Math.min(1, base.roughness + .06), opacity: .96 };
  return base;
}

type StructurePart = {
  structure: StructureRecord;
  geometry: BoxGeometry;
  material: MeshStandardMaterial;
};

function createStructurePart(structure: StructureRecord): StructurePart {
  // The canonical size is footprint width/height; slabHeight is the local Z
  // thickness. Keeping the box centered makes baseElevation explicit and stable.
  const geometry = new BoxGeometry(structure.size.width, structure.size.height, structure.slabHeight, 1, 1, 1);
  const visual = visualFor(structure.structureKind, structure.material);
  const material = new MeshStandardMaterial({
    color: visual.color,
    roughness: visual.roughness,
    metalness: visual.metalness,
    transparent: visual.opacity !== undefined,
    opacity: visual.opacity ?? 1,
    side: DoubleSide,
  });
  return { structure, geometry, material };
}

export interface StructureMeshesProps {
  scene: { structures: Record<string, StructureRecord> };
  mapWidth: number;
  mapHeight: number;
  /** Roofs are intentionally an exterior-only presentation detail. */
  mode?: StructurePresentation;
  revision?: number;
}

/**
 * Projects the explicitly presented rectangular structures into centered Three coordinates.
 * It owns only local geometry/material resources and emits no scene commands.
 */
export function StructureMeshes({ scene, mapWidth, mapHeight, mode = 'exterior', revision }: StructureMeshesProps) {
  const structureRevision = revision ?? 0;
  const parts = useMemo(() => Object.values(scene.structures)
    .filter((structure) => mode === 'exterior' || structure.structureKind !== 'roof')
    .sort((first, second) => first.structureId.localeCompare(second.structureId))
    .map(createStructurePart), [mapHeight, mapWidth, mode, scene.structures, structureRevision]);

  useEffect(() => () => {
    for (const part of parts) {
      part.geometry.dispose();
      part.material.dispose();
    }
  }, [parts]);

  return <group name="structure-meshes" dispose={null}>
    {parts.map(({ structure, geometry, material }) => <mesh
      key={structure.structureId}
      name={structure.structureId}
      geometry={geometry}
      material={material}
      position={[structure.position.x - mapWidth / 2, mapHeight / 2 - structure.position.y, structure.baseElevation + structure.slabHeight / 2]}
      rotation={[0, 0, -structure.rotation * Math.PI / 180]}
      castShadow
      receiveShadow
      dispose={null}
    />)}
  </group>;
}
