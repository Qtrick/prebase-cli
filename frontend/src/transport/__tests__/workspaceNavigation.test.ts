import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  dispatchWorkspaceNavigate,
  getWorkspaceClientId,
  hasWorkspaceNavigateHandler,
  registerWorkspaceNavigateHandler,
  resetWorkspaceNavigationForTests,
} from '../workspaceNavigation';

describe('Workspace Navigation Transport Hook', () => {
  beforeEach(() => {
    resetWorkspaceNavigationForTests();
  });

  afterEach(() => {
    resetWorkspaceNavigationForTests();
    vi.restoreAllMocks();
  });

  it('generates a bounded, stable client_id matching ^[a-zA-Z0-9_-]{1,64}$', () => {
    const id1 = getWorkspaceClientId();
    const id2 = getWorkspaceClientId();
    expect(id1).toBe(id2);
    expect(id1.length).toBeGreaterThanOrEqual(1);
    expect(id1.length).toBeLessThanOrEqual(64);
    expect(/^[a-zA-Z0-9_-]{1,64}$/.test(id1)).toBe(true);
  });

  it('does not acknowledge navigation when no workspace handler is registered', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    expect(hasWorkspaceNavigateHandler()).toBe(false);
    const handled = await dispatchWorkspaceNavigate({
      request_id: 'nav_req_1',
      view: '2d',
      focus: 'src/main.rs',
    });

    expect(handled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('dispatches 3d, 2d, temporal, and focus to registered handler and sends correlated ack', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const received: Array<{ requestId: string; view: string; focus: string | null }> = [];
    const unsubscribe = registerWorkspaceNavigateHandler((target) => {
      received.push(target);
    });

    expect(hasWorkspaceNavigateHandler()).toBe(true);

    const ok = await dispatchWorkspaceNavigate({
      request_id: 'nav_req_2',
      view: 'temporal',
      focus: 'crates/prebase-cli/src/main.rs',
    });

    expect(ok).toBe(true);
    expect(received).toEqual([
      {
        requestId: 'nav_req_2',
        view: 'temporal',
        focus: 'crates/prebase-cli/src/main.rs',
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/v1/workspace/ack',
      expect.objectContaining({
        method: 'POST',
        credentials: 'same-origin',
        body: JSON.stringify({
          request_id: 'nav_req_2',
          client_id: getWorkspaceClientId(),
        }),
      })
    );

    unsubscribe();
    expect(hasWorkspaceNavigateHandler()).toBe(false);
  });

  it('ignores workspace.navigate targeted to a different client_id', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const handler = vi.fn();
    registerWorkspaceNavigateHandler(handler);

    const handled = await dispatchWorkspaceNavigate({
      request_id: 'nav_req_other',
      target_client_id: 'pb_some_other_tab',
      view: '2d',
      focus: 'src/main.rs',
    });

    expect(handled).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
