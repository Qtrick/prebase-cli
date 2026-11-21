import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createHoverHysteresisController,
  HOVER_HYSTERESIS_THRESHOLD_MS,
  HOVER_RELEASE_GRACE_PERIOD_MS,
} from '../hoverHysteresis';

describe('NetworkCanvas Hover Hysteresis Behavioral Regression Suite', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Fast Pointer Traversal (Anti-Strobing Protection)', () => {
    it('does not trigger visual hover strobing during fast pointer sweep across multiple nodes', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // Pointer rapidly traverses nodes 1, 2, 3, 4, 5 (15ms per node = 60ms total traversal)
      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(15);
      expect(commitMock).not.toHaveBeenCalled();

      controller.handlePointerMoveOverNode('node-2');
      vi.advanceTimersByTime(15);
      expect(commitMock).not.toHaveBeenCalled();

      controller.handlePointerMoveOverNode('node-3');
      vi.advanceTimersByTime(15);
      expect(commitMock).not.toHaveBeenCalled();

      controller.handlePointerMoveOverNode('node-4');
      vi.advanceTimersByTime(15);
      expect(commitMock).not.toHaveBeenCalled();

      controller.handlePointerMoveOverNode('node-5');
      vi.advanceTimersByTime(15);
      expect(commitMock).not.toHaveBeenCalled();

      // Verified: Zero commits during traversal! Visual strobing is completely avoided.
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      controller.dispose();
    });

    it('commits hover ONLY after pointer lingers on a node past the 100ms threshold', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // Sweep through node-1 and node-2 quickly
      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(20);
      controller.handlePointerMoveOverNode('node-2');
      vi.advanceTimersByTime(30);

      // Settle and linger on node-3
      controller.handlePointerMoveOverNode('node-3');
      expect(controller.getPendingHoverNodeId()).toBe('node-3');

      // Advance by 99ms (1ms before threshold)
      vi.advanceTimersByTime(99);
      expect(commitMock).not.toHaveBeenCalled();
      expect(controller.getCommittedHoverNodeId()).toBeNull();

      // Cross 100ms threshold
      vi.advanceTimersByTime(1);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(commitMock).toHaveBeenCalledWith('node-3');
      expect(controller.getCommittedHoverNodeId()).toBe('node-3');
      expect(controller.getPendingHoverNodeId()).toBeNull();

      controller.dispose();
    });

    it('resets linger timer when moving between nodes without flashing previous candidate', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // Linger on node-A for 80ms (not quite 100ms)
      controller.handlePointerMoveOverNode('node-A');
      vi.advanceTimersByTime(80);
      expect(commitMock).not.toHaveBeenCalled();

      // Move to node-B (should cancel node-A timer and restart 100ms for node-B)
      controller.handlePointerMoveOverNode('node-B');
      vi.advanceTimersByTime(40); // 120ms since start, but only 40ms on node-B
      expect(commitMock).not.toHaveBeenCalled();

      // Finish 100ms on node-B (another 60ms)
      vi.advanceTimersByTime(60);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(commitMock).toHaveBeenCalledWith('node-B');

      controller.dispose();
    });
  });

  describe('Canvas Exit & Empty Space Hover Cancellation', () => {
    it('immediately cancels committed hover and clears timers when pointer leaves canvas', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // Linger and commit node-1
      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(100);
      expect(commitMock).toHaveBeenCalledWith('node-1');

      // Pointer leaves canvas
      controller.handlePointerLeaveCanvas();
      expect(commitMock).toHaveBeenCalledWith(null);
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      expect(controller.getPendingHoverNodeId()).toBeNull();

      controller.dispose();
    });

    it('cancels pending hover timer if pointer leaves canvas before threshold elapses', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(50); // halfway to threshold

      // Leave canvas before 100ms
      controller.handlePointerLeaveCanvas();

      // Advance time past 100ms
      vi.advanceTimersByTime(100);
      // Verify node-1 was NEVER committed
      expect(commitMock).not.toHaveBeenCalled();

      controller.dispose();
    });

    it('clears hover when pointer moves over empty canvas space', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // Commit node-1
      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-1');

      // Move over empty space
      controller.handlePointerMoveOverEmpty();
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      expect(commitMock).toHaveBeenLastCalledWith(null);

      controller.dispose();
    });
  });

  describe('Immediate Click Selection (Zero Delay Invariant)', () => {
    it('immediately selects node on click without waiting for 100ms hover delay', () => {
      const commitMock = vi.fn();
      const selectMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
        onSelectNodeImmediate: selectMock,
      });

      // Pointer moves to node-Target at t=0
      controller.handlePointerMoveOverNode('node-Target');
      vi.advanceTimersByTime(10); // only 10ms in, far below 100ms threshold

      // Click occurs immediately
      controller.handleClickNode('node-Target');

      // Selection must be called synchronously without delay!
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(selectMock).toHaveBeenCalledWith('node-Target');

      // Pending hover timer must be cleared and hover committed
      expect(controller.getPendingHoverNodeId()).toBeNull();
      expect(controller.getCommittedHoverNodeId()).toBe('node-Target');

      // Advancing remaining 90ms should not trigger redundant timers
      vi.advanceTimersByTime(100);
      expect(selectMock).toHaveBeenCalledTimes(1);

      controller.dispose();
    });
  });

  describe('Gesture & Rotation Suppression', () => {
    it('suppresses hover during 3D rotation / panning gesture', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        onCommitHover: commitMock,
      });

      // User starts dragging/rotating 3D orb
      controller.handleGestureStart();
      expect(controller.isGestureActive()).toBe(true);

      // Pointer crosses multiple nodes during drag
      controller.handlePointerMoveOverNode('node-A');
      vi.advanceTimersByTime(150);
      expect(commitMock).not.toHaveBeenCalled();

      // Gesture ends
      controller.handleGestureEnd();
      expect(controller.isGestureActive()).toBe(false);

      // Now hovering works again
      controller.handlePointerMoveOverNode('node-B');
      vi.advanceTimersByTime(100);
      expect(commitMock).toHaveBeenCalledWith('node-B');

      controller.dispose();
    });
  });

  describe('Hover Hysteresis Release Grace Period', () => {
    it('does not immediately clear committed hover during fast sweep through empty space for < 50ms when grace period (60ms) is active', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        gracePeriodMs: 60,
        onCommitHover: commitMock,
      });

      // 1. Hover and commit node-Alpha
      controller.handlePointerMoveOverNode('node-Alpha');
      vi.advanceTimersByTime(100);
      expect(commitMock).toHaveBeenCalledTimes(1);
      expect(commitMock).toHaveBeenCalledWith('node-Alpha');
      expect(controller.getCommittedHoverNodeId()).toBe('node-Alpha');

      // 2. Cursor transiently passes through empty space for 35ms (< 50ms)
      controller.handlePointerMoveOverEmpty();
      vi.advanceTimersByTime(35);

      // Committed hover MUST remain intact without clearing or flickering!
      expect(controller.getCommittedHoverNodeId()).toBe('node-Alpha');
      expect(commitMock).toHaveBeenCalledTimes(1); // No null commit!

      // 3. Cursor returns to node-Alpha before 60ms grace period expires
      controller.handlePointerMoveOverNode('node-Alpha');
      vi.advanceTimersByTime(100);

      // Node-Alpha remains continuously committed; grace period was cleanly cancelled
      expect(controller.getCommittedHoverNodeId()).toBe('node-Alpha');
      expect(commitMock).toHaveBeenCalledTimes(1);

      controller.dispose();
    });

    it('clears committed hover when lingering in empty space > 60ms', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        gracePeriodMs: 60,
        onCommitHover: commitMock,
      });

      // Commit node-Beta
      controller.handlePointerMoveOverNode('node-Beta');
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-Beta');

      // Move into empty space
      controller.handlePointerMoveOverEmpty();

      // At 59ms, still preserved
      vi.advanceTimersByTime(59);
      expect(controller.getCommittedHoverNodeId()).toBe('node-Beta');

      // Cross 60ms grace period boundary
      vi.advanceTimersByTime(1);
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      expect(commitMock).toHaveBeenLastCalledWith(null);

      controller.dispose();
    });

    it('immediately cancels committed hover and pending grace timers when pointer leaves canvas (zero delay)', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        gracePeriodMs: 60,
        onCommitHover: commitMock,
      });

      // Commit node-Gamma
      controller.handlePointerMoveOverNode('node-Gamma');
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-Gamma');

      // Move to empty space, starting 60ms grace timer
      controller.handlePointerMoveOverEmpty();
      vi.advanceTimersByTime(20); // only 20ms in

      // Pointer exits canvas: MUST clear immediately without waiting remaining 40ms!
      controller.handlePointerLeaveCanvas();
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      expect(commitMock).toHaveBeenLastCalledWith(null);

      // Advancing remaining time should not cause duplicate callbacks
      const callsBefore = commitMock.mock.calls.length;
      vi.advanceTimersByTime(100);
      expect(commitMock.mock.calls.length).toBe(callsBefore);

      controller.dispose();
    });

    it('immediately selects and commits hover on click even during empty space grace period (zero delay)', () => {
      const commitMock = vi.fn();
      const selectMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        gracePeriodMs: 60,
        onCommitHover: commitMock,
        onSelectNodeImmediate: selectMock,
      });

      // Commit node-1
      controller.handlePointerMoveOverNode('node-1');
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-1');

      // Move over empty space (grace active)
      controller.handlePointerMoveOverEmpty();
      vi.advanceTimersByTime(25);

      // User clicks node-2 directly
      controller.handleClickNode('node-2');

      // Synchronous, zero-delay selection and hover commit
      expect(selectMock).toHaveBeenCalledTimes(1);
      expect(selectMock).toHaveBeenCalledWith('node-2');
      expect(controller.getCommittedHoverNodeId()).toBe('node-2');

      // Advancing time should not clear hover or fire stale timers
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-2');

      controller.dispose();
    });

    it('immediately cancels hover when drag/gesture starts during empty space grace period (zero delay)', () => {
      const commitMock = vi.fn();
      const controller = createHoverHysteresisController({
        thresholdMs: 100,
        gracePeriodMs: 60,
        onCommitHover: commitMock,
      });

      // Commit node-Delta
      controller.handlePointerMoveOverNode('node-Delta');
      vi.advanceTimersByTime(100);
      expect(controller.getCommittedHoverNodeId()).toBe('node-Delta');

      // Move over empty space (grace timer running)
      controller.handlePointerMoveOverEmpty();
      vi.advanceTimersByTime(15);

      // Drag / orbit gesture begins
      controller.handleGestureStart();
      expect(controller.isGestureActive()).toBe(true);
      expect(controller.getCommittedHoverNodeId()).toBeNull();
      expect(commitMock).toHaveBeenLastCalledWith(null);

      // Movement during drag is suppressed
      controller.handlePointerMoveOverNode('node-Delta');
      vi.advanceTimersByTime(150);
      expect(controller.getCommittedHoverNodeId()).toBeNull();

      controller.dispose();
    });

    it('uses exported HOVER_RELEASE_GRACE_PERIOD_MS constant (60ms) and HOVER_HYSTERESIS_THRESHOLD_MS (100ms)', () => {
      expect(HOVER_HYSTERESIS_THRESHOLD_MS).toBe(100);
      expect(HOVER_RELEASE_GRACE_PERIOD_MS).toBe(60);
    });
  });
});
