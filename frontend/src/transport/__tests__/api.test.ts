import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initSession } from '../api';

describe('Transport Session Authentication & Isolation (initSession)', () => {
  let replaceStateMock: ReturnType<typeof vi.fn>;
  let prevWindow: unknown;

  beforeEach(() => {
    replaceStateMock = vi.fn();
    prevWindow = (globalThis as unknown as { window?: unknown }).window;

    (globalThis as unknown as { window: unknown }).window = {
      location: {
        pathname: '/',
        search: '',
        hash: '',
      },
      history: {
        replaceState: replaceStateMock,
      },
    };
  });

  afterEach(() => {
    (globalThis as unknown as { window: unknown }).window = prevWindow;
    vi.restoreAllMocks();
  });

  it('returns success: true when no bootstrap token exists in URL', async () => {
    (globalThis.window as { location: { search: string } }).location.search = '';
    const res = await initSession();
    expect(res.success).toBe(true);
    expect(res.hadBootstrapToken).toBe(false);
    expect(replaceStateMock).not.toHaveBeenCalled();
  });

  it('purges legacy token query parameter from URL without storing', async () => {
    (globalThis.window as { location: { search: string } }).location.search = '?token=legacy_token_123';
    const res = await initSession();
    expect(res.success).toBe(true);
    expect(res.hadBootstrapToken).toBe(false);
    expect(replaceStateMock).toHaveBeenCalledWith({}, '', '/');
  });

  it('exchanges bootstrap token successfully (HTTP 200) and cleans URL', async () => {
    (globalThis.window as { location: { search: string } }).location.search =
      '?bootstrap=boot_token_abc&view=3d';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ authenticated: true }),
    }) as unknown as typeof fetch;

    const res = await initSession();
    expect(res.success).toBe(true);
    expect(res.hadBootstrapToken).toBe(true);
    expect(replaceStateMock).toHaveBeenCalledWith({}, '', '/?view=3d');
  });

  it('handles terminal auth failure (HTTP 401), clears burnt bootstrap parameter and reports isAuthError: true', async () => {
    (globalThis.window as { location: { search: string } }).location.search =
      '?bootstrap=expired_token&view=3d';

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => 'Invalid or expired bootstrap token',
    }) as unknown as typeof fetch;

    const res = await initSession();
    expect(res.success).toBe(false);
    expect(res.hadBootstrapToken).toBe(true);
    expect(res.isAuthError).toBe(true);
    expect(res.error).toContain('401');
    expect(replaceStateMock).toHaveBeenCalledWith({}, '', '/?view=3d');
  });

  it('preserves bootstrap parameter in URL on transient network failure without calling replaceState', async () => {
    (globalThis.window as { location: { search: string } }).location.search =
      '?bootstrap=valid_token&view=3d';

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Failed to fetch')) as unknown as typeof fetch;

    const res = await initSession();
    expect(res.success).toBe(false);
    expect(res.hadBootstrapToken).toBe(true);
    expect(res.isAuthError).toBe(false);
    expect(res.error).toContain('Network failure');
    // Crucial security invariant: do NOT destroy the bootstrap parameter on network glitch!
    expect(replaceStateMock).not.toHaveBeenCalled();
  });
});
