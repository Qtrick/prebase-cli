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

  describe('React StrictMode & Concurrent Authentication Invariants', () => {
    it('coalesces concurrent initSession calls into a single fetch avoiding single-use token consumption', async () => {
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=single_use_token_123&view=3d';

      let fetchCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ authenticated: true }),
          };
        }
        // If a second concurrent fetch is triggered, single-use token on server returns 401
        return {
          ok: false,
          status: 401,
          text: async () => 'Invalid or expired bootstrap token.',
        };
      }) as unknown as typeof fetch;

      const [res1, res2] = await Promise.all([initSession(), initSession()]);

      expect(fetchCount).toBe(1);
      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res1.hadBootstrapToken).toBe(true);
      expect(res2.hadBootstrapToken).toBe(true);
      expect(res1.isAuthError).toBeFalsy();
      expect(res2.isAuthError).toBeFalsy();
    });

    it('protects against 200 + 401 race condition under React StrictMode double invocation', async () => {
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=single_use_token_race&view=3d';

      let callCount = 0;
      let resolveFirst: (val: unknown) => void;
      const slowSuccessPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return slowSuccessPromise;
        }
        return {
          ok: false,
          status: 401,
          text: async () => 'Token already consumed',
        };
      }) as unknown as typeof fetch;

      const promise1 = initSession();
      const promise2 = initSession();

      // First fetch eventually succeeds with 200 OK
      resolveFirst!({
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true }),
      });

      const [res1, res2] = await Promise.all([promise1, promise2]);
      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res2.isAuthError).toBeFalsy();
      expect(res2.error).toBeUndefined();
    });

    it('preserves bootstrap parameter in URL on HTTP 500 Internal Server Error without calling replaceState', async () => {
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=valid_token_500&view=3d';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => 'Internal Server Error: database connection timeout',
      }) as unknown as typeof fetch;

      const res = await initSession();
      expect(res.success).toBe(false);
      expect(res.hadBootstrapToken).toBe(true);
      expect(res.isAuthError).toBe(false);
      expect(res.error).toContain('500');
      // Bootstrap token must NOT be purged from URL on transient 500 server error!
      expect(replaceStateMock).not.toHaveBeenCalled();
    });

    it('preserves bootstrap parameter in URL on HTTP 503 Service Unavailable without calling replaceState', async () => {
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=valid_token_503&view=3d';

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable: server starting up',
      }) as unknown as typeof fetch;

      const res = await initSession();
      expect(res.success).toBe(false);
      expect(res.hadBootstrapToken).toBe(true);
      expect(res.isAuthError).toBe(false);
      expect(res.error).toContain('503');
      // Bootstrap token must NOT be purged from URL on transient 503 server error!
      expect(replaceStateMock).not.toHaveBeenCalled();
    });

    it('properly differentiates auth failure (401) from server error (500/503) for downstream gating', async () => {
      // 401 is terminal auth failure -> isAuthError: true, burns URL token
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=burnt_token&view=3d';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
      }) as unknown as typeof fetch;

      const authRes = await initSession();
      expect(authRes.success).toBe(false);
      expect(authRes.isAuthError).toBe(true);
      expect(replaceStateMock).toHaveBeenCalledTimes(1);

      replaceStateMock.mockClear();

      // 503 is transient service error -> isAuthError: false, preserves URL token
      (globalThis.window as { location: { search: string } }).location.search =
        '?bootstrap=preserved_token&view=3d';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: async () => 'Unavailable',
      }) as unknown as typeof fetch;

      const srvRes = await initSession();
      expect(srvRes.success).toBe(false);
      expect(srvRes.isAuthError).toBe(false);
      expect(replaceStateMock).not.toHaveBeenCalled();
    });
  });
});
