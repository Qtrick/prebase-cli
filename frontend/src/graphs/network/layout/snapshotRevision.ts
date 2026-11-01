import {
  GraphSnapshot,
  NetworkCamera,
  Point3D,
  ViewportInsets,
} from '../../../types/graph';
import { layoutOrganic } from './organicLayout';
import {
  DEFAULT_YAW,
  DEFAULT_PITCH,
  computeGraphCentroid,
  projectGraph,
  computeNetworkFitTransform,
} from '../render/networkRenderMath';

export interface SnapshotRevisionState {
  repositoryId: string | null;
  positions: Map<string, Point3D>;
  camera: NetworkCamera;
}

export interface SnapshotRevisionResult {
  state: SnapshotRevisionState;
  didTriggerInitialFit: boolean;
}

/**
 * Handles a snapshot revision:
 * - If the repository ID matches the currently initialized repository, existing node world
 *   positions and camera state (yaw, pitch, pan, zoom) are strictly preserved.
 * - If the repository ID is new/different, the graph layout is computed from scratch and an
 *   initial fit view transform is applied.
 */
export function processSnapshotRevision(
  currentState: SnapshotRevisionState,
  snapshot: GraphSnapshot,
  viewport: { width: number; height: number; insets?: ViewportInsets }
): SnapshotRevisionResult {
  if (!snapshot || snapshot.nodes.length === 0) {
    return {
      state: {
        repositoryId: snapshot?.repository_id ?? null,
        positions: new Map(),
        camera: currentState.camera,
      },
      didTriggerInitialFit: false,
    };
  }

  const isNewRepo =
    currentState.repositoryId !== snapshot.repository_id || currentState.positions.size === 0;

  const layoutNodes = snapshot.nodes.map((n, idx) => ({
    id: n.id,
    val: (n.direct_dependency_count || 0) + (n.direct_dependent_count || 0) + 1,
    isEntry: idx === 0 || n.filename === 'index.ts' || n.filename === 'main.ts',
  }));

  const layoutLinks = snapshot.edges.map((e) => ({
    source: e.source_file_id,
    target: e.target_file_id,
  }));

  const computedPositions = layoutOrganic(
    layoutNodes,
    layoutLinks,
    undefined,
    isNewRepo ? undefined : currentState.positions
  );

  if (isNewRepo) {
    const centroid = computeGraphCentroid(computedPositions.values());
    const tempCamera: NetworkCamera = {
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      panX: viewport.width / 2,
      panY: viewport.height / 2,
      zoom: 1.0,
    };
    const proj = projectGraph(snapshot.nodes, computedPositions, centroid, tempCamera);
    const fit = computeNetworkFitTransform(
      proj.bounds,
      viewport.width,
      viewport.height,
      viewport.insets
    );

    const initialCamera: NetworkCamera = {
      yaw: DEFAULT_YAW,
      pitch: DEFAULT_PITCH,
      panX: fit.panX,
      panY: fit.panY,
      zoom: fit.zoom,
    };

    return {
      state: {
        repositoryId: snapshot.repository_id,
        positions: computedPositions,
        camera: initialCamera,
      },
      didTriggerInitialFit: true,
    };
  }

  // Same repository revision: strictly preserve camera state!
  return {
    state: {
      repositoryId: currentState.repositoryId,
      positions: computedPositions,
      camera: { ...currentState.camera },
    },
    didTriggerInitialFit: false,
  };
}
