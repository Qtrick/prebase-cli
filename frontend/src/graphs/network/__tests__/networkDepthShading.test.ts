import { describe, it, expect } from 'vitest';
import {
  computeCameraDepthShading,
  computeEdgeDepthAttenuation,
  compositeDepthColor,
  GRAPH_BACKGROUND_DARK,
  GRAPH_BACKGROUND_LIGHT,
  projectPoint3D,
} from '../render/networkRenderMath';

describe('3D Camera-Relative Depth Shading Math Suite', () => {
  const SPHERE_R = 100;

  describe('Camera-Relative Depth & Shading Cardinal Boundaries', () => {
    it('evaluates nearest node (z = -R) at front apex with depth = 1.0 and shading = 1.0', () => {
      const result = computeCameraDepthShading(-SPHERE_R, SPHERE_R, 'dark');
      expect(result.depth).toBeCloseTo(1.0, 6);
      expect(result.shading).toBeCloseTo(1.0, 6);
      expect(result.prominence).toBeCloseTo(1.0, 6);
      expect(result.backgroundColor).toBe(GRAPH_BACKGROUND_DARK);
    });

    it('evaluates equator node (z = 0) with depth = 0.5 and shading = 0.5', () => {
      const result = computeCameraDepthShading(0, SPHERE_R, 'dark');
      expect(result.depth).toBeCloseTo(0.5, 6);
      expect(result.shading).toBeCloseTo(0.5, 6);
      expect(result.prominence).toBeCloseTo(0.5, 6);
    });

    it('evaluates farthest node (z = +R) at rear apex with depth = 0.0 and shading = 0.0', () => {
      const result = computeCameraDepthShading(SPHERE_R, SPHERE_R, 'dark');
      expect(result.depth).toBeCloseTo(0.0, 6);
      expect(result.shading).toBeCloseTo(0.0, 6);
      expect(result.prominence).toBeCloseTo(0.0, 6);
    });
  });

  describe('Monotonicity and Continuous Linear Gradient', () => {
    it('strictly decreases depth and shading as cameraSpaceZ increases from -R to +R', () => {
      const sampleZs = [-100, -75, -50, -25, 0, 25, 50, 75, 100];
      const depths = sampleZs.map((z) => computeCameraDepthShading(z, SPHERE_R, 'dark').depth);

      for (let i = 1; i < depths.length; i++) {
        expect(depths[i]).toBeLessThan(depths[i - 1]);
      }
    });

    it('maintains continuous linear transition across arbitrary step intervals', () => {
      const zA = -40;
      const zB = -20;
      const zC = 0;
      const resA = computeCameraDepthShading(zA, SPHERE_R).depth;
      const resB = computeCameraDepthShading(zB, SPHERE_R).depth;
      const resC = computeCameraDepthShading(zC, SPHERE_R).depth;

      // Equal 20-unit step produces equal depth decrements (20 / (2 * 100) = 0.1)
      expect(resA - resB).toBeCloseTo(0.1, 6);
      expect(resB - resC).toBeCloseTo(0.1, 6);
    });
  });

  describe('Numerical Robustness and Degenerate Geometry Safety', () => {
    it('safely clamps extreme coordinates beyond [-R, +R]', () => {
      const farOvershoot = computeCameraDepthShading(5000, SPHERE_R);
      expect(farOvershoot.depth).toBe(0.0);
      expect(farOvershoot.shading).toBe(0.0);

      const nearOvershoot = computeCameraDepthShading(-5000, SPHERE_R);
      expect(nearOvershoot.depth).toBe(1.0);
      expect(nearOvershoot.shading).toBe(1.0);
    });

    it('safely handles degenerate radius (R <= 0) with 0.5 equator fallback', () => {
      const zeroR = computeCameraDepthShading(0, 0);
      expect(zeroR.depth).toBe(0.5);
      expect(zeroR.shading).toBe(0.5);

      const negativeR = computeCameraDepthShading(10, -50);
      expect(negativeR.depth).toBe(0.5);
      expect(negativeR.shading).toBe(0.5);
    });

    it('safely handles NaN and Infinite inputs with deterministic fallbacks', () => {
      const nanZ = computeCameraDepthShading(NaN, SPHERE_R);
      expect(nanZ.depth).toBe(0.5);
      expect(nanZ.shading).toBe(0.5);

      const infZ = computeCameraDepthShading(Infinity, SPHERE_R);
      expect(infZ.depth).toBe(0.5);
      expect(infZ.shading).toBe(0.5);

      const nanR = computeCameraDepthShading(0, NaN);
      expect(nanR.depth).toBe(0.5);
      expect(nanR.shading).toBe(0.5);

      const infR = computeCameraDepthShading(0, Infinity);
      expect(infR.depth).toBe(0.5);
      expect(infR.shading).toBe(0.5);
    });
  });

  describe('3D Rotational Camera Depth Inversion', () => {
    it('inverts camera-relative depth and shading from rear to front when rotating 180 degrees (yaw = 0 vs yaw = PI)', () => {
      // Node fixed in 3D world space at (0, 0, 100)
      const worldX = 0;
      const worldY = 0;
      const worldZ = 100;
      const radius = 100;

      // 1. Initial camera view: yaw = 0, pitch = 0
      // In camera space, point is on the rear side (z2 = +100)
      const projAt0 = projectPoint3D(worldX, worldY, worldZ, 0, 0);
      expect(projAt0.z).toBeCloseTo(100, 4);

      const shadingAt0 = computeCameraDepthShading(projAt0.z, radius);
      expect(shadingAt0.depth).toBeCloseTo(0.0, 4);
      expect(shadingAt0.shading).toBeCloseTo(0.0, 4);

      // 2. Camera rotates 180 degrees: yaw = Math.PI, pitch = 0
      // Point rotates to the front side facing camera (z2 = -100)
      const projAtPi = projectPoint3D(worldX, worldY, worldZ, Math.PI, 0);
      expect(projAtPi.z).toBeCloseTo(-100, 4);

      const shadingAtPi = computeCameraDepthShading(projAtPi.z, radius);
      expect(shadingAtPi.depth).toBeCloseTo(1.0, 4);
      expect(shadingAtPi.shading).toBeCloseTo(1.0, 4);

      // 3. Verified: Depth and shading cleanly inverted from rear (0.0) to front (1.0)!
      expect(shadingAtPi.depth - shadingAt0.depth).toBeCloseTo(1.0, 4);

      // 4. Halfway rotation (yaw = Math.PI / 2): point traverses to the equator (z2 = 0)
      const projAtHalf = projectPoint3D(worldX, worldY, worldZ, Math.PI / 2, 0);
      expect(projAtHalf.z).toBeCloseTo(0, 4);

      const shadingAtHalf = computeCameraDepthShading(projAtHalf.z, radius);
      expect(shadingAtHalf.depth).toBeCloseTo(0.5, 4);
      expect(shadingAtHalf.shading).toBeCloseTo(0.5, 4);
    });
  });

  describe('Theme Compositing (Graphite vs Alabaster Background Blending)', () => {
    const cyanBase = '#38bdf8'; // rgb(56, 189, 248)

    it('composites fully toward graphite background (#111113) at rear apex (prominence = 0) in dark mode', () => {
      const blendedRear = compositeDepthColor(cyanBase, 0.0, 'dark');
      expect(blendedRear).toBe(GRAPH_BACKGROUND_DARK); // #111113
    });

    it('preserves full base color at front apex (prominence = 1.0) in dark mode', () => {
      const blendedFront = compositeDepthColor(cyanBase, 1.0, 'dark');
      expect(blendedFront).toBe(cyanBase); // #38bdf8
    });

    it('composites fully toward alabaster background (#fafaf9) at rear apex (prominence = 0) in light mode', () => {
      const blendedRear = compositeDepthColor(cyanBase, 0.0, 'light');
      expect(blendedRear).toBe(GRAPH_BACKGROUND_LIGHT); // #fafaf9
    });

    it('preserves full base color at front apex (prominence = 1.0) in light mode', () => {
      const blendedFront = compositeDepthColor(cyanBase, 1.0, 'light');
      expect(blendedFront).toBe(cyanBase); // #38bdf8
    });

    it('smoothly interpolates intermediate RGB channels at equator (prominence = 0.5)', () => {
      // cyan = rgb(56, 189, 248)
      // graphite = rgb(17, 17, 19)
      // Expected halfway:
      // R = round(56 * 0.5 + 17 * 0.5) = round(36.5) = 37 -> 0x25
      // G = round(189 * 0.5 + 17 * 0.5) = round(103) = 103 -> 0x67
      // B = round(248 * 0.5 + 19 * 0.5) = round(133.5) = 134 -> 0x86
      const halfwayDark = compositeDepthColor(cyanBase, 0.5, 'dark');
      expect(halfwayDark).toBe('#256786');
    });

    it('handles 3-digit shorthand hex colors', () => {
      // #fff = rgb(255, 255, 255)
      const whiteRear = compositeDepthColor('#fff', 0.0, 'dark');
      expect(whiteRear).toBe(GRAPH_BACKGROUND_DARK);
      const whiteFront = compositeDepthColor('#fff', 1.0, 'dark');
      expect(whiteFront).toBe('#ffffff');
    });
  });

  describe('Edge Depth Attenuation', () => {
    it('attenuates ordinary edge between far nodes more than edge between front nodes', () => {
      const frontEdgeProminence = computeEdgeDepthAttenuation(-SPHERE_R, -SPHERE_R, SPHERE_R);
      const rearEdgeProminence = computeEdgeDepthAttenuation(SPHERE_R, SPHERE_R, SPHERE_R);

      expect(frontEdgeProminence).toBeCloseTo(1.0, 6);
      expect(rearEdgeProminence).toBeCloseTo(0.0, 6);
      expect(rearEdgeProminence).toBeLessThan(frontEdgeProminence);
    });

    it('computes midpoint depth for edges spanning from front to rear', () => {
      const crossEdgeProminence = computeEdgeDepthAttenuation(-SPHERE_R, SPHERE_R, SPHERE_R);
      expect(crossEdgeProminence).toBeCloseTo(0.5, 6);
    });

    it('boosts edge prominence to >= 0.75 when endpoints are selected or hovered even at rear', () => {
      const highlightedEdgeProminence = computeEdgeDepthAttenuation(SPHERE_R, SPHERE_R, SPHERE_R, {
        isSourceSelected: true,
      });
      expect(highlightedEdgeProminence).toBeGreaterThanOrEqual(0.75);
    });
  });

  describe('Selection and Hover Visibility Floor Invariant', () => {
    it('enforces visibility floor >= 0.75 for selected nodes even at the farthest rear apex (z = +R)', () => {
      const unselectedRear = computeCameraDepthShading(SPHERE_R, SPHERE_R, 'dark', {
        isSelected: false,
      });
      expect(unselectedRear.depth).toBe(0.0);
      expect(unselectedRear.shading).toBe(0.0);

      const selectedRear = computeCameraDepthShading(SPHERE_R, SPHERE_R, 'dark', {
        isSelected: true,
      });
      // Depth is geometry-relative (0.0), but visual shading/prominence floor is >= 0.75!
      expect(selectedRear.depth).toBe(0.0);
      expect(selectedRear.shading).toBeGreaterThanOrEqual(0.75);
      expect(selectedRear.prominence).toBeGreaterThanOrEqual(0.75);
    });

    it('enforces visibility floor >= 0.75 for hovered nodes at rear apex', () => {
      const hoveredRear = computeCameraDepthShading(SPHERE_R, SPHERE_R, 'dark', {
        isHovered: true,
      });
      expect(hoveredRear.depth).toBe(0.0);
      expect(hoveredRear.shading).toBeGreaterThanOrEqual(0.75);
    });

    it('does not attenuate front-facing nodes below their higher natural prominence', () => {
      const selectedFront = computeCameraDepthShading(-SPHERE_R, SPHERE_R, 'dark', {
        isSelected: true,
      });
      // Front node has natural depth 1.0, so shading stays at 1.0 (> 0.75)
      expect(selectedFront.depth).toBe(1.0);
      expect(selectedFront.shading).toBe(1.0);
    });
  });
});
