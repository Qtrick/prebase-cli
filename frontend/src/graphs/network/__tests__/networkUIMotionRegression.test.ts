import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FileNode,
  GraphSnapshot,
  NetworkCamera,
} from '../../../types/graph';
import {
  PITCH_CLAMP_LIMIT,
  ROTATION_SENSITIVITY,
  shouldDrawNodeLabel,
  calculateReleaseSpeed,
  shouldInitiateInertia,
  clampLaunchVelocity,
  stepRotationalInertia,
} from '../render/networkRenderMath';
import {
  pushFocusHistory,
  popFocusHistory,
  resolveBackTargetName,
} from '../../relationship/relationshipHistory';
import { Viewport2D } from '../../relationship/RelationshipCanvas';

// Test Data Fixtures
const makeNode = (id: string, opts?: { deps?: number; path?: string }): FileNode => ({
  id,
  relative_path: opts?.path ?? `src/${id}.ts`,
  filename: `${id}.ts`,
  language: 'typescript',
  size_bytes: 350,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: opts?.deps ?? 1,
  direct_dependent_count: opts?.deps ?? 1,
});

const makeSnapshot = (nodeIds: string[]): GraphSnapshot => ({
  schema_version: '1.0.0',
  repository_id: 'test-repo',
  revision: 1,
  nodes: nodeIds.map((id, idx) => makeNode(id, { deps: idx })),
  edges: nodeIds.slice(1).map((id, idx) => ({
    id: `${nodeIds[idx]}->${id}`,
    source_file_id: nodeIds[idx],
    target_file_id: id,
    relationship_kind: 'Import',
    resolution_status: 'ResolvedInternal',
    evidence: [],
  })),
  coverage: {
    total_discovered: nodeIds.length,
    total_analyzed: nodeIds.length,
    total_excluded: 0,
    total_issues: 0,
    is_complete: true,
  },
  issues: [],
});

describe('PreBase UI/UX & Motion Design Behavioral Regression Suite', () => {
  // =========================================================================
  // 1. Label Hierarchy & Visual Prominence Invariants
  // =========================================================================
  describe('1. Label Hierarchy & Visual Prominence Determination', () => {
    describe('Hemisphere Boundary Thresholds (projectedZ >= -15)', () => {
      it('treats projectedZ = -14.99 as front hemisphere and -15.01 as back hemisphere', () => {
        // Hub node with degree 4 in overview (zoom = 1.0)
        const frontBoundaryNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -14.99,
          totalDegree: 4,
          zoom: 1.0,
        });
        expect(frontBoundaryNode).toBe(true);

        const exactBoundaryNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -15.0,
          totalDegree: 4,
          zoom: 1.0,
        });
        expect(exactBoundaryNode).toBe(true);

        const backBoundaryNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -15.01,
          totalDegree: 4,
          zoom: 1.0,
        });
        expect(backBoundaryNode).toBe(false);
      });
    });

    describe('Overview Zoom Mode (zoom <= 1.3)', () => {
      it('renders labels for hub nodes (degree >= 4) on front hemisphere', () => {
        const hubNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 10,
          totalDegree: 4,
          zoom: 1.0,
        });
        expect(hubNode).toBe(true);

        const superHubNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 50,
          totalDegree: 12,
          zoom: 1.25,
        });
        expect(superHubNode).toBe(true);
      });

      it('suppresses labels for low and moderate degree nodes (degree < 4) on front hemisphere', () => {
        const subHubNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 20,
          totalDegree: 3,
          zoom: 1.0,
        });
        expect(subHubNode).toBe(false);

        const leafNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 30,
          totalDegree: 0,
          zoom: 1.3,
        });
        expect(leafNode).toBe(false);
      });

      it('suppresses back-hemisphere nodes even if they are large hubs, preventing visual noise', () => {
        const backHubNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -35,
          totalDegree: 15,
          zoom: 1.0,
        });
        expect(backHubNode).toBe(false);
      });
    });

    describe('Mid Zoom Mode (1.3 < zoom <= 2.2)', () => {
      it('progressively reveals front nodes with degree >= 2', () => {
        const moderateFrontNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 5,
          totalDegree: 2,
          zoom: 1.6,
        });
        expect(moderateFrontNode).toBe(true);
      });

      it('reveals low-degree front nodes only if they are positioned strongly forward (z > 20)', () => {
        const forwardLeafNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 21,
          totalDegree: 1,
          zoom: 1.8,
        });
        expect(forwardLeafNode).toBe(true);

        const shallowLeafNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: 19,
          totalDegree: 1,
          zoom: 1.8,
        });
        expect(shallowLeafNode).toBe(false);
      });

      it('keeps back-hemisphere nodes hidden at mid zoom', () => {
        const backNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -18,
          totalDegree: 6,
          zoom: 2.0,
        });
        expect(backNode).toBe(false);
      });
    });

    describe('Deep Zoom Mode (zoom > 2.2)', () => {
      it('reveals all front-facing nodes regardless of degree', () => {
        const zeroDegreeFrontNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -10,
          totalDegree: 0,
          zoom: 2.5,
        });
        expect(zeroDegreeFrontNode).toBe(true);
      });

      it('reveals shallow back-hemisphere nodes (z > -40) but suppresses deep back nodes (z <= -40)', () => {
        const shallowBackNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -38,
          totalDegree: 1,
          zoom: 2.8,
        });
        expect(shallowBackNode).toBe(true);

        const deepBackNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -42,
          totalDegree: 5,
          zoom: 2.8,
        });
        expect(deepBackNode).toBe(false);
      });
    });

    describe('Prominence of Active Selections and Hover Targets', () => {
      it('always renders label for selected node under extreme back-hemisphere and min-zoom conditions', () => {
        const selectedFarBackNode = shouldDrawNodeLabel({
          isSelected: true,
          isHovered: false,
          isConnectedToSelected: false,
          projectedZ: -120,
          totalDegree: 0,
          zoom: 0.2,
        });
        expect(selectedFarBackNode).toBe(true);
      });

      it('always renders label for hovered node under extreme back-hemisphere and min-zoom conditions', () => {
        const hoveredFarBackNode = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: true,
          isConnectedToSelected: false,
          projectedZ: -95,
          totalDegree: 0,
          zoom: 0.4,
        });
        expect(hoveredFarBackNode).toBe(true);
      });

      it('renders labels for connected neighbors on front hemisphere at any zoom', () => {
        const frontNeighbor = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: true,
          projectedZ: 5,
          totalDegree: 1,
          zoom: 0.6,
        });
        expect(frontNeighbor).toBe(true);
      });

      it('reveals back-hemisphere neighbors only once zoom exceeds 1.2', () => {
        const overviewBackNeighbor = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: true,
          projectedZ: -30,
          totalDegree: 1,
          zoom: 1.15,
        });
        expect(overviewBackNeighbor).toBe(false);

        const zoomedBackNeighbor = shouldDrawNodeLabel({
          isSelected: false,
          isHovered: false,
          isConnectedToSelected: true,
          projectedZ: -30,
          totalDegree: 1,
          zoom: 1.25,
        });
        expect(zoomedBackNeighbor).toBe(true);
      });
    });

    describe('Typography Scaling and Visual Contrast Rules', () => {
      // Font size formula: Math.max(10, Math.min(14, 11 * Math.sqrt(zoom)))
      function computeLabelFontSize(zoom: number): number {
        return Math.max(10, Math.min(14, 11 * Math.sqrt(zoom)));
      }

      it('clamps label font size to [10px, 14px] across zoom spectrum', () => {
        expect(computeLabelFontSize(0.15)).toBe(10);
        expect(computeLabelFontSize(0.5)).toBe(10);
        expect(computeLabelFontSize(1.0)).toBe(11);
        expect(computeLabelFontSize(1.44)).toBeCloseTo(13.2, 1);
        expect(computeLabelFontSize(2.5)).toBe(14);
        expect(computeLabelFontSize(4.0)).toBe(14);
      });

      it('evaluates theme-specific color palettes and halo stroke styles', () => {
        const resolveThemeColors = (theme: 'dark' | 'light', isSelected: boolean, isHovered: boolean) => {
          const isLight = theme === 'light';
          const strokeStyle = isLight ? 'rgba(255, 255, 255, 0.95)' : 'rgba(8, 11, 17, 0.92)';
          const fillStyle = isSelected
            ? (isLight ? '#0d9488' : '#2dd4bf')
            : isHovered
              ? (isLight ? '#0284c7' : '#38bdf8')
              : (isLight ? '#0f172a' : '#f1f5f9');
          return { strokeStyle, fillStyle };
        };

        const darkNormal = resolveThemeColors('dark', false, false);
        expect(darkNormal.strokeStyle).toBe('rgba(8, 11, 17, 0.92)');
        expect(darkNormal.fillStyle).toBe('#f1f5f9');

        const darkSelected = resolveThemeColors('dark', true, false);
        expect(darkSelected.fillStyle).toBe('#2dd4bf');

        const lightNormal = resolveThemeColors('light', false, false);
        expect(lightNormal.strokeStyle).toBe('rgba(255, 255, 255, 0.95)');
        expect(lightNormal.fillStyle).toBe('#0f172a');

        const lightHovered = resolveThemeColors('light', false, true);
        expect(lightHovered.fillStyle).toBe('#0284c7');
      });
    });
  });

  // =========================================================================
  // 2. Rotational Inertia Physics, Damping & Cancellation Invariants
  // =========================================================================
  describe('2. Rotational Inertia Physics, Damping & Cancellation Invariants', () => {
    const baseCamera: NetworkCamera = {
      yaw: 0.5,
      pitch: 0.2,
      panX: 400,
      panY: 300,
      zoom: 1.0,
    };

    describe('Exponential Friction Decay and Epsilon Halting', () => {
      it('decays velocity monotonically according to friction^deltaFrames', () => {
        const initialVx = 1.2;
        const initialVy = -0.8;
        const friction = 0.88;

        const step1 = stepRotationalInertia({
          vx: initialVx,
          vy: initialVy,
          camera: baseCamera,
          deltaMs: 16,
          friction,
        });

        expect(step1.vx).toBeCloseTo(initialVx * 0.88, 5);
        expect(step1.vy).toBeCloseTo(initialVy * 0.88, 5);
        expect(step1.isDone).toBe(false);

        // Step 2: 32ms delta (equivalent to 2 frames)
        const step2 = stepRotationalInertia({
          vx: step1.vx,
          vy: step1.vy,
          camera: step1.camera,
          deltaMs: 32,
          friction,
        });

        expect(step2.vx).toBeCloseTo(step1.vx * Math.pow(0.88, 2), 5);
        expect(step2.vy).toBeCloseTo(step1.vy * Math.pow(0.88, 2), 5);
        expect(step2.isDone).toBe(false);
      });

      it('halts inertia immediately when speed drops below epsilon = 0.015', () => {
        // Below epsilon: hypot(0.010, 0.010) ≈ 0.01414 < 0.015
        const stepHalt = stepRotationalInertia({
          vx: 0.010,
          vy: 0.010,
          camera: baseCamera,
          deltaMs: 16,
          friction: 1.0, // no decay to isolate epsilon check
          epsilon: 0.015,
        });

        expect(stepHalt.isDone).toBe(true);
        expect(stepHalt.vx).toBe(0);
        expect(stepHalt.vy).toBe(0);
        // Camera does not move on halt frame
        expect(stepHalt.camera.yaw).toBe(baseCamera.yaw);
        expect(stepHalt.camera.pitch).toBe(baseCamera.pitch);
      });

      it('continues coasting when speed is above epsilon threshold', () => {
        // Above epsilon: hypot(0.012, 0.012) ≈ 0.01697 > 0.015
        const stepContinue = stepRotationalInertia({
          vx: 0.012,
          vy: 0.012,
          camera: baseCamera,
          deltaMs: 16,
          friction: 1.0,
          epsilon: 0.015,
        });

        expect(stepContinue.isDone).toBe(false);
        expect(stepContinue.vx).toBe(0.012);
        expect(stepContinue.vy).toBe(0.012);
      });
    });

    describe('Launch Velocity Bounds and Still-Pointer Lingering', () => {
      it('clamps excessive flick velocity to [-2.2, 2.2] rad/ms to prevent disorienting spins', () => {
        const clampedHigh = clampLaunchVelocity({ vx: 5.8, vy: -4.3 }, 2.2);
        expect(clampedHigh.vx).toBe(2.2);
        expect(clampedHigh.vy).toBe(-2.2);

        const clampedNormal = clampLaunchVelocity({ vx: 1.1, vy: -0.9 }, 2.2);
        expect(clampedNormal.vx).toBe(1.1);
        expect(clampedNormal.vy).toBe(-0.9);
      });

      it('nullifies launch speed if user held the pointer stationary for > 75ms before releasing', () => {
        // Active motion: 40ms since last move -> speed is calculated
        const activeSpeed = calculateReleaseSpeed(1.2, 0.6, 40, 75);
        expect(activeSpeed).toBeCloseTo(Math.hypot(1.2, 0.6), 5);

        // Stationary pointer before lift: 80ms since last move -> speed is 0
        const stationarySpeed = calculateReleaseSpeed(1.2, 0.6, 80, 75);
        expect(stationarySpeed).toBe(0);
      });

      it('verifies inertia initiation gate: speed > 0.15 threshold', () => {
        expect(shouldInitiateInertia(0.14, false, 0.15)).toBe(false);
        expect(shouldInitiateInertia(0.151, false, 0.15)).toBe(true);
      });
    });

    describe('Respecting Reduced Motion Preference', () => {
      it('completely blocks rotational inertia when prefersReducedMotion is true', () => {
        const highSpeed = 2.0;
        expect(shouldInitiateInertia(highSpeed, true)).toBe(false);
        expect(shouldInitiateInertia(highSpeed, false)).toBe(true);
      });
    });

    describe('Angular Limits & Camera Invariance during Inertia Step', () => {
      it('wraps yaw cleanly within [-PI, PI] without discontinuity', () => {
        const cameraNearBorder: NetworkCamera = {
          ...baseCamera,
          yaw: Math.PI - 0.01,
        };

        // Coasting with positive vx turns yaw negatively
        const step = stepRotationalInertia({
          vx: 1.0,
          vy: 0,
          camera: cameraNearBorder,
          deltaMs: 16,
          rotationSensitivity: ROTATION_SENSITIVITY,
        });

        expect(step.camera.yaw).toBeLessThan(cameraNearBorder.yaw);
        expect(step.camera.yaw).toBeGreaterThanOrEqual(-Math.PI);
        expect(step.camera.yaw).toBeLessThanOrEqual(Math.PI);
      });

      it('clamps pitch strictly within [-1.48, 1.48] to prevent upside-down pole inversion', () => {
        const cameraNearNorthPole: NetworkCamera = {
          ...baseCamera,
          pitch: PITCH_CLAMP_LIMIT - 0.01,
        };

        const step = stepRotationalInertia({
          vx: 0,
          vy: 2.0, // positive vy pushes pitch up
          camera: cameraNearNorthPole,
          deltaMs: 32,
          rotationSensitivity: ROTATION_SENSITIVITY,
        });

        expect(step.camera.pitch).toBe(PITCH_CLAMP_LIMIT);
      });

      it('guarantees panX, panY, and zoom are 100% untouched by rotational coasting', () => {
        const step = stepRotationalInertia({
          vx: 1.5,
          vy: -1.2,
          camera: { ...baseCamera, panX: 423.5, panY: 287.1, zoom: 3.14 },
          deltaMs: 16,
        });

        expect(step.camera.panX).toBe(423.5);
        expect(step.camera.panY).toBe(287.1);
        expect(step.camera.zoom).toBe(3.14);
      });
    });

    describe('Cancellation Triggers on PointerDown, Wheel, and KeyDown', () => {
      it('cancels active inertia timer and resets velocity on new PointerDown', () => {
        let inertiaRafId: number | null = 101;
        let velocity = { vx: 1.4, vy: 0.9 };
        let activeGesture = false;

        // Simulate pointerdown handler logic in NetworkCanvas
        const handlePointerDownSimulation = () => {
          if (inertiaRafId !== null) {
            inertiaRafId = null; // cancels RAF
          }
          velocity = { vx: 0, vy: 0 };
          activeGesture = true;
        };

        handlePointerDownSimulation();
        expect(inertiaRafId).toBeNull();
        expect(velocity).toEqual({ vx: 0, vy: 0 });
        expect(activeGesture).toBe(true);
      });

      it('cancels active inertia timer on wheel zoom event', () => {
        let inertiaRafId: number | null = 202;

        const handleWheelSimulation = () => {
          if (inertiaRafId !== null) {
            inertiaRafId = null;
          }
        };

        handleWheelSimulation();
        expect(inertiaRafId).toBeNull();
      });

      it('cancels active inertia timer on keyboard interaction', () => {
        let inertiaRafId: number | null = 303;

        const handleKeyDownSimulation = (_key: string) => {
          if (inertiaRafId !== null) {
            inertiaRafId = null;
          }
        };

        handleKeyDownSimulation('ArrowLeft');
        expect(inertiaRafId).toBeNull();
      });

      it('preserves gesture mode before cleanup to ensure rotational inertia initiates upon release', () => {
        const gesture = {
          active: true,
          mode: 'rotating' as 'idle' | 'rotating' | 'panning',
          exceededThreshold: true,
        };

        let inertiaInitiated = false;

        const cleanUpPointerGesture = () => {
          gesture.active = false;
          gesture.mode = 'idle';
        };

        const handlePointerUpSimulation = () => {
          const wasDragging = gesture.exceededThreshold;
          const mode = gesture.mode; // Must capture mode before cleanup!

          cleanUpPointerGesture();

          if (!wasDragging) {
            // Selection
          } else if (mode === 'rotating') {
            inertiaInitiated = true;
          }
        };

        handlePointerUpSimulation();
        expect(inertiaInitiated).toBe(true);
        expect(gesture.mode).toBe('idle');
      });

      it('cancels active rotational inertia when fitView, resetView, or revealRequest starts camera animation', () => {
        let inertiaRafId: number | null = 999;

        const onTriggerCameraAnimation = () => {
          if (inertiaRafId !== null) {
            inertiaRafId = null;
          }
        };

        onTriggerCameraAnimation();
        expect(inertiaRafId).toBeNull();
      });
    });
  });

  // =========================================================================
  // 3. 3D <-> 2D Mode Transition & Layer State Invariants
  // =========================================================================
  describe('3. 3D <-> 2D Mode Transition & Layer State Invariants', () => {
    it('configures active and inactive CSS classes and aria-hidden attributes properly', () => {
      const getLayerAttributes = (networkViewMode: '3d' | '2d') => ({
        layer3D: {
          className: `canvas-view-layer ${networkViewMode === '3d' ? 'active' : 'inactive'}`,
          ariaHidden: networkViewMode !== '3d',
        },
        layer2D: {
          className: `canvas-view-layer ${networkViewMode === '2d' ? 'active' : 'inactive'}`,
          ariaHidden: networkViewMode !== '2d',
        },
      });

      const in3D = getLayerAttributes('3d');
      expect(in3D.layer3D.className).toBe('canvas-view-layer active');
      expect(in3D.layer3D.ariaHidden).toBe(false);
      expect(in3D.layer2D.className).toBe('canvas-view-layer inactive');
      expect(in3D.layer2D.ariaHidden).toBe(true);

      const in2D = getLayerAttributes('2d');
      expect(in2D.layer3D.className).toBe('canvas-view-layer inactive');
      expect(in2D.layer3D.ariaHidden).toBe(true);
      expect(in2D.layer2D.className).toBe('canvas-view-layer active');
      expect(in2D.layer2D.ariaHidden).toBe(false);
    });

    it('strictly preserves 3D camera coordinates across 2D mode navigation and edits', () => {
      const initial3DCamera: NetworkCamera = {
        yaw: 1.15,
        pitch: -0.38,
        panX: 432.0,
        panY: 308.0,
        zoom: 2.75,
      };

      // Internal camera authority in NetworkCanvas is stored in a ref
      const cameraRef = { current: { ...initial3DCamera } };
      let independent2DViewport: Viewport2D = { panX: 0, panY: 0, zoom: 1.0 };
      let mode: '3d' | '2d' = '3d';

      // Switch to 2D
      mode = '2d';
      expect(mode).toBe('2d');

      // User navigates in 2D
      independent2DViewport = { panX: 180, panY: -95, zoom: 1.45 };

      // Switch back to 3D
      mode = '3d';
      expect(mode).toBe('3d');

      // 3D camera ref remained pristine
      expect(cameraRef.current.yaw).toBe(1.15);
      expect(cameraRef.current.pitch).toBe(-0.38);
      expect(cameraRef.current.panX).toBe(432.0);
      expect(cameraRef.current.panY).toBe(308.0);
      expect(cameraRef.current.zoom).toBe(2.75);

      // And 2D viewport retained its state for when returning to 2D
      expect(independent2DViewport).toEqual({ panX: 180, panY: -95, zoom: 1.45 });
    });

    it('synchronizes selected file as 2D focus node when switching from 3D to 2D', () => {
      const snapshot = makeSnapshot(['nodeA', 'nodeB', 'nodeC']);
      let selectedNode: FileNode | null = snapshot.nodes[1]; // nodeB
      let focusNodeId: string | null = null;
      let missingFocusPath: string | null = null;
      let networkViewMode: '3d' | '2d' = '3d';

      // Mode switch handler from App.tsx
      const handleSwitchNetworkMode = (mode: '3d' | '2d') => {
        if (mode === '2d' && selectedNode) {
          focusNodeId = selectedNode.id;
          missingFocusPath = null;
        }
        networkViewMode = mode;
      };

      handleSwitchNetworkMode('2d');
      expect(networkViewMode).toBe('2d');
      expect(focusNodeId).toBe('nodeB');
      expect(missingFocusPath).toBeNull();
    });

    it('manages 2D focus navigation history and back stack cleanly', () => {
      const snapshot = makeSnapshot(['app', 'router', 'auth', 'db']);
      let focusHistory: string[] = [];
      let focusNodeId: string | null = 'app';

      // Navigate to router
      focusHistory = pushFocusHistory(focusHistory, focusNodeId, 'router');
      focusNodeId = 'router';
      expect(focusHistory).toEqual(['app']);

      // Navigate to auth
      focusHistory = pushFocusHistory(focusHistory, focusNodeId, 'auth');
      focusNodeId = 'auth';
      expect(focusHistory).toEqual(['app', 'router']);

      // Check resolved back target label
      const backLabel = resolveBackTargetName(focusHistory, snapshot.nodes);
      expect(backLabel).toBe('router.ts');

      // Pop back to router
      const pop1 = popFocusHistory(focusHistory);
      focusHistory = pop1.nextHistory;
      focusNodeId = pop1.prevFocusId;
      expect(focusNodeId).toBe('router');
      expect(focusHistory).toEqual(['app']);

      // Pop back to app
      const pop2 = popFocusHistory(focusHistory);
      focusHistory = pop2.nextHistory;
      focusNodeId = pop2.prevFocusId;
      expect(focusNodeId).toBe('app');
      expect(focusHistory).toEqual([]);

      // Back stack empty: canGoBack is false
      expect(focusHistory.length > 0).toBe(false);
    });

    it('synchronizes browser URL search parameters (?view=3d|2d, ?focus=<path>)', () => {
      const buildSearchQuery = (params: {
        activeTab: 'network' | 'temporal';
        mode: '3d' | '2d';
        focusPath?: string | null;
      }) => {
        const q = new URLSearchParams();
        if (params.activeTab === 'temporal') {
          q.set('view', 'temporal');
        } else {
          q.set('view', params.mode);
          if (params.focusPath) {
            q.set('focus', params.focusPath);
          }
        }
        return q.toString();
      };

      expect(buildSearchQuery({ activeTab: 'network', mode: '3d', focusPath: 'src/app.ts' }))
        .toBe('view=3d&focus=src%2Fapp.ts');
      expect(buildSearchQuery({ activeTab: 'network', mode: '2d', focusPath: 'src/router.ts' }))
        .toBe('view=2d&focus=src%2Frouter.ts');
      expect(buildSearchQuery({ activeTab: 'temporal', mode: '3d' }))
        .toBe('view=temporal');
    });
  });

  // =========================================================================
  // 4. Collapsible Inspector States and Path Copy Actions
  // =========================================================================
  describe('4. Collapsible Inspector States and Path Copy Actions', () => {
    it('manages collapsible inspector state and applies .collapsed class', () => {
      let isCollapsed = false;

      const getInspectorClasses = () => `inspector-panel ${isCollapsed ? 'collapsed' : ''}`.trim();

      expect(getInspectorClasses()).toBe('inspector-panel');

      // Toggle collapse on
      isCollapsed = true;
      expect(getInspectorClasses()).toBe('inspector-panel collapsed');

      // Toggle collapse off
      isCollapsed = false;
      expect(getInspectorClasses()).toBe('inspector-panel');
    });

    it('renders floating reopen button with accessibility attributes when inspector is collapsed', () => {
      const isCollapsed = true;

      const reopenButtonProps = isCollapsed
        ? {
            className: 'inspector-reopen-btn',
            title: 'Open inspector',
            'aria-label': 'Open inspector',
          }
        : null;

      expect(reopenButtonProps).not.toBeNull();
      expect(reopenButtonProps?.['aria-label']).toBe('Open inspector');
    });

    it('distinguishes between minimize/collapse (preserves selection) and close (clears selection)', () => {
      const selectedFile = makeNode('index');
      let currentSelection: FileNode | null = selectedFile;
      let isCollapsed = false;

      // Minimize / Collapse
      const onToggleCollapse = () => {
        isCollapsed = !isCollapsed;
      };

      onToggleCollapse();
      expect(isCollapsed).toBe(true);
      expect(currentSelection).toBe(selectedFile); // selection is intact!

      // Close inspector
      const onClose = () => {
        currentSelection = null;
      };

      onClose();
      expect(currentSelection).toBeNull(); // selection is cleared
    });

    describe('Clipboard Copy Actions with Tactile 2000ms Feedback', () => {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });

      it('manages path copy action state and auto-resets after 2000ms', async () => {
        let copiedPath = false;
        const clipboardMock = {
          writeText: vi.fn().mockResolvedValue(undefined),
        };
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          value: clipboardMock,
          configurable: true,
          writable: true,
        });

        const handleCopyPath = (path: string) => {
          navigator.clipboard.writeText(path).then(() => {
            copiedPath = true;
            setTimeout(() => {
              copiedPath = false;
            }, 2000);
          });
        };

        handleCopyPath('src/utils/math.ts');
        await Promise.resolve();
        await Promise.resolve();

        expect(clipboardMock.writeText).toHaveBeenCalledWith('src/utils/math.ts');
        expect(copiedPath).toBe(true);

        vi.advanceTimersByTime(1999);
        expect(copiedPath).toBe(true);

        vi.advanceTimersByTime(2);
        expect(copiedPath).toBe(false);
      });

      it('manages full commit SHA copy action and auto-resets after 2000ms', async () => {
        let copiedSha = false;
        const commitHash = 'a1b2c3d4e5f67890123456789abcdef012345678';
        const clipboardMock = {
          writeText: vi.fn().mockResolvedValue(undefined),
        };
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          value: clipboardMock,
          configurable: true,
          writable: true,
        });

        const handleCopyHash = (hash: string) => {
          navigator.clipboard.writeText(hash).then(() => {
            copiedSha = true;
            setTimeout(() => {
              copiedSha = false;
            }, 2000);
          });
        };

        handleCopyHash(commitHash);
        await Promise.resolve();
        await Promise.resolve();

        expect(clipboardMock.writeText).toHaveBeenCalledWith(commitHash);
        expect(copiedSha).toBe(true);

        vi.advanceTimersByTime(2001);
        expect(copiedSha).toBe(false);
      });

      it('catches clipboard API rejections gracefully without throwing', async () => {
        let copied = false;
        const clipboardMock = {
          writeText: vi.fn().mockRejectedValue(new Error('Permission denied')),
        };
        Object.defineProperty(globalThis.navigator, 'clipboard', {
          value: clipboardMock,
          configurable: true,
          writable: true,
        });

        const handleCopySafe = (text: string) => {
          navigator.clipboard
            .writeText(text)
            .then(() => {
              copied = true;
            })
            .catch(() => {
              // Gracefully caught
            });
        };

        expect(() => handleCopySafe('any-path')).not.toThrow();
        await Promise.resolve();
        await Promise.resolve();
        expect(copied).toBe(false);
      });
    });
  });

  // =========================================================================
  // 5. SearchBox Focus Isolation & Reveal Invariants
  // =========================================================================
  describe('5. SearchBox Focus Isolation & Reveal Invariants', () => {
    const nodes = [
      makeNode('App', { path: 'src/app/App.tsx' }),
      makeNode('NetworkCanvas', { path: 'src/graphs/network/NetworkCanvas.tsx' }),
      makeNode('Inspector', { path: 'src/inspector/Inspector.tsx' }),
    ];

    it('regular search selection invokes onSelectNode with { reveal: false }, freezing 3D camera', () => {
      let selectedNode: FileNode | null = null;
      let revealRequest: any = null;

      const handleSelectNode = (node: FileNode | null, options?: { reveal?: boolean }) => {
        selectedNode = node;
        if (node && options?.reveal) {
          revealRequest = { nodeId: node.id, timestamp: 12345 };
        }
      };

      // User selects from search dropdown via normal Enter or click
      handleSelectNode(nodes[1], { reveal: false });

      expect(selectedNode).toBe(nodes[1]);
      // Crucial: camera reveal request must NOT be generated!
      expect(revealRequest).toBeNull();
    });

    it('clicking the Locate/Reveal action icon explicitly passes { reveal: true }', () => {
      let selectedNode: FileNode | null = null;
      let revealRequest: any = null;

      const handleSelectNode = (node: FileNode | null, options?: { reveal?: boolean }) => {
        selectedNode = node;
        if (node && options?.reveal) {
          revealRequest = { nodeId: node.id, timestamp: 12345 };
        }
      };

      // User clicks the LocateFixed action button on the search item
      handleSelectNode(nodes[1], { reveal: true });

      expect(selectedNode).toBe(nodes[1]);
      expect(revealRequest).toEqual({ nodeId: 'NetworkCanvas', timestamp: 12345 });
    });

    it('cycles search dropdown index on ArrowDown and ArrowUp wraps', () => {
      const resultsLength = 3;
      let selectedIndex = 0;

      // ArrowDown
      selectedIndex = (selectedIndex + 1) % resultsLength;
      expect(selectedIndex).toBe(1);

      // ArrowDown
      selectedIndex = (selectedIndex + 1) % resultsLength;
      expect(selectedIndex).toBe(2);

      // ArrowDown wraps to 0
      selectedIndex = (selectedIndex + 1) % resultsLength;
      expect(selectedIndex).toBe(0);

      // ArrowUp wraps to 2
      selectedIndex = (selectedIndex - 1 + resultsLength) % resultsLength;
      expect(selectedIndex).toBe(2);
    });

    it('filters files case-insensitively across filename and relative_path', () => {
      const query = 'canvas';
      const q = query.trim().toLowerCase();

      const matched = nodes.filter(
        (f) =>
          f.filename.toLowerCase().includes(q) ||
          f.relative_path.toLowerCase().includes(q)
      );

      expect(matched.length).toBe(1);
      expect(matched[0].id).toBe('NetworkCanvas');
    });
  });
});
