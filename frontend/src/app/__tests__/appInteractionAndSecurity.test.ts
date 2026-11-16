import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseInitialUrlParams,
  resolveInitialFocusNode,
  shouldIgnoreGlobalShortcut,
  hasModifierCombination,
} from '../App';
import { getNodeRelationshipSentence } from '../../inspector/Inspector';
import { FileNode, GraphSnapshot } from '../../types/graph';
import { createNetworkSnapshotCoordinator } from '../../transport/networkSnapshotCoordinator';
import { initSession } from '../../transport/api';

const makeNode = (id: string, relative_path: string, filename?: string): FileNode => ({
  id,
  relative_path,
  filename: filename || relative_path.split('/').pop() || id,
  language: 'typescript',
  size_bytes: 100,
  file_kind: 'Source',
  analysis_status: 'Analyzed',
  direct_dependency_count: 0,
  direct_dependent_count: 0,
});

describe('App interaction & security unit tests', () => {
  describe('Safe URL focus query parameter parsing', () => {
    it('parses standard query focus path', () => {
      const res = parseInitialUrlParams('?view=2d&focus=src/components/Button.tsx');
      expect(res.activeTab).toBe('network');
      expect(res.networkViewMode).toBe('2d');
      expect(res.initialFocusPath).toBe('src/components/Button.tsx');
    });

    it('parses paths with spaces and unicode correctly without double-decoding', () => {
      const res = parseInitialUrlParams('?view=3d&focus=src%2Fcomponents%2FMy%20Button%20%E2%9C%A8.tsx');
      expect(res.initialFocusPath).toBe('src/components/My Button ✨.tsx');
    });

    it('tolerates percent signs in filenames without throwing URIError', () => {
      const res = parseInitialUrlParams('?view=2d&focus=src/100%real.ts');
      expect(res.initialFocusPath).toBe('src/100%real.ts');
    });

    it('tolerates malformed percent sequences without crashing', () => {
      const res = parseInitialUrlParams('?view=2d&focus=%E0%A4%A');
      expect(res.networkViewMode).toBe('2d');
      expect(typeof res.initialFocusPath).toBe('string');
    });

    it('handles empty or missing focus parameter', () => {
      const res = parseInitialUrlParams('?view=temporal');
      expect(res.activeTab).toBe('temporal');
      expect(res.initialFocusPath).toBeNull();
    });

    it('preserves leading and trailing whitespace in focus path identity', () => {
      const resLeading = parseInitialUrlParams('?view=2d&focus=%20src%2Fleading.ts');
      expect(resLeading.initialFocusPath).toBe(' src/leading.ts');

      const resTrailing = parseInitialUrlParams('?view=2d&focus=src%2Ftrailing.ts%20');
      expect(resTrailing.initialFocusPath).toBe('src/trailing.ts ');

      const resBoth = parseInitialUrlParams('?view=2d&focus=%20%20src%2F%20both%20.ts%20%20');
      expect(resBoth.initialFocusPath).toBe('  src/ both .ts  ');
    });
  });

  describe('Finding B: Initial focus path whitespace & special character resolution', () => {
    it('matches node with leading spaces, proving trimming would cause resolution failure', () => {
      const leadingNode = makeNode('node-leading', ' src/components/Button.tsx', 'Button.tsx');
      const normalNode = makeNode('node-normal', 'src/components/Button.tsx', 'Button.tsx');
      const nodes = [normalNode, leadingNode];

      const focusTarget = ' src/components/Button.tsx';
      const resolved = resolveInitialFocusNode(focusTarget, nodes);
      expect(resolved).toBe(leadingNode);
      expect(resolved?.id).toBe('node-leading');

      // Proving the original problem: trimming the target would have resolved the wrong node!
      const trimmedTarget = focusTarget.trim();
      const trimmedResolved = resolveInitialFocusNode(trimmedTarget, nodes);
      expect(trimmedResolved).toBe(normalNode);
      expect(trimmedResolved).not.toBe(leadingNode);
    });

    it('matches node with trailing spaces in relative_path and filename', () => {
      const trailingNode = makeNode('node-trailing', 'src/trailing.ts ', 'trailing.ts ');
      const nodes = [trailingNode];

      const resolved = resolveInitialFocusNode('src/trailing.ts ', nodes);
      expect(resolved).toBe(trailingNode);

      // Trimming would fail completely because 'src/trailing.ts' does not exist
      expect(resolveInitialFocusNode('src/trailing.ts', nodes)).toBeNull();
    });

    it('matches node with both leading and trailing spaces and internal whitespace', () => {
      const complexSpaceNode = makeNode('node-complex', '  src/my sub folder/file name .ts  ');
      const nodes = [complexSpaceNode];

      const resolved = resolveInitialFocusNode('  src/my sub folder/file name .ts  ', nodes);
      expect(resolved).toBe(complexSpaceNode);
    });

    it('matches node with special characters (+, #, %, parentheses, unicode)', () => {
      const specialNode1 = makeNode('node-special-1', 'src/100%real.ts');
      const specialNode2 = makeNode('node-special-2', 'src/file (copy) #2+final.tsx');
      const specialNode3 = makeNode('node-special-3', 'src/🚀/launch✨.ts');
      const nodes = [specialNode1, specialNode2, specialNode3];

      expect(resolveInitialFocusNode('src/100%real.ts', nodes)).toBe(specialNode1);
      expect(resolveInitialFocusNode('src/file (copy) #2+final.tsx', nodes)).toBe(specialNode2);
      expect(resolveInitialFocusNode('src/🚀/launch✨.ts', nodes)).toBe(specialNode3);
    });

    it('returns null safely for empty, null, undefined, or missing focus paths without crashing', () => {
      const nodes = [makeNode('node-1', 'src/index.ts')];
      expect(resolveInitialFocusNode(null, nodes)).toBeNull();
      expect(resolveInitialFocusNode(undefined, nodes)).toBeNull();
      expect(resolveInitialFocusNode('', nodes)).toBeNull();
      expect(resolveInitialFocusNode('nonexistent/file.ts', nodes)).toBeNull();
    });
  });

  describe('Keyboard shortcut filtering rules', () => {
    it('ignores shortcuts when focused on input, textarea, or select', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'input' } })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'textarea' } })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'select' } })).toBe(true);
    });

    it('ignores shortcuts when focused on contenteditable or textbox role', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'div', isContentEditable: true } })).toBe(true);
      expect(
        shouldIgnoreGlobalShortcut({
          target: { tagName: 'div', getAttribute: (attr) => (attr === 'role' ? 'textbox' : null) },
        })
      ).toBe(true);
    });

    it('ignores shortcuts during IME composition', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' }, isComposing: true })).toBe(true);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' }, keyCode: 229 })).toBe(true);
    });

    it('detects modifier combinations (e.g. Cmd+C, Cmd+V, Cmd+1, Ctrl+C)', () => {
      expect(hasModifierCombination({ metaKey: true })).toBe(true);
      expect(hasModifierCombination({ ctrlKey: true })).toBe(true);
      expect(hasModifierCombination({ altKey: true })).toBe(true);
      expect(hasModifierCombination({})).toBe(false);
    });

    it('allows clean single-key shortcuts when not editing and without modifier keys', () => {
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'body' } })).toBe(false);
      expect(shouldIgnoreGlobalShortcut({ target: { tagName: 'canvas' } })).toBe(false);
    });
  });

  describe('Truthful file relationship descriptions (getNodeRelationshipSentence)', () => {
    it('returns empty string when node is null', () => {
      expect(getNodeRelationshipSentence(null)).toBe('');
    });

    it('reports unsupported files truthfully without false dependency claims', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Unsupported',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe('PreBase discovered this file but does not currently analyze its internal dependencies.');
    });

    it('reports failed parse status truthfully', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Failed',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe("PreBase encountered an error while parsing this file's imports.");
    });

    it('uses grounded language when dependent files exist without exaggerated foundation labels', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 0,
        direct_dependent_count: 4,
      });
      expect(text).toBe('This file is directly used by 4 other files, and imports no other indexed files.');
      expect(text).not.toContain('foundation');
      expect(text).not.toContain('core');
    });

    it('uses grounded language for isolated files', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 0,
        direct_dependent_count: 0,
      });
      expect(text).toBe('This file has no direct internal dependencies or dependents in this repository.');
    });

    it('uses grounded language for mixed dependencies and dependents', () => {
      const text = getNodeRelationshipSentence({
        analysis_status: 'Analyzed',
        direct_dependency_count: 2,
        direct_dependent_count: 3,
      });
      expect(text).toBe('This file uses 2 internal files and is used by 3 other files.');
    });
  });

  describe('Trailing revision SSE coalescing & race protection', () => {
    it('detects when an in-flight network response resolved an older revision than announced', async () => {
      let resolveFetch!: (snap: GraphSnapshot) => void;
      const fetchPromise = new Promise<GraphSnapshot>((res) => {
        resolveFetch = res;
      });
      const mockFetch = vi.fn().mockReturnValue(fetchPromise);
      const coordinator = createNetworkSnapshotCoordinator(mockFetch);

      // Trigger initial in-flight fetch
      const inFlightFetch = coordinator.fetchSnapshot();

      // Revision 2 SSE observed
      coordinator.recordObservedEventRevision(2);

      // Revision 3 SSE observed while fetch is in-flight
      coordinator.recordObservedEventRevision(3);

      // In-flight network response resolves revision 2
      const snapRev2: GraphSnapshot = {
        schema_version: '1.0.0',
        repository_id: 'test-repo',
        revision: 2,
        nodes: [],
        edges: [],
        coverage: {
          total_discovered: 0,
          total_analyzed: 0,
          total_excluded: 0,
          total_issues: 0,
          is_complete: true,
        },
        issues: [],
      };
      resolveFetch(snapRev2);
      const resolvedSnap = await inFlightFetch;

      expect(coordinator.shouldApplySnapshot(resolvedSnap.revision)).toBe(true);
      coordinator.recordAppliedRevision(resolvedSnap.revision);

      // Verify that when an in-flight network response resolves revision 2, but revision 3 was observed
      // via SSE during flight, hasPendingNewerRevision() returns true and getHighestObservedRevision() is 3
      // while getLatestAppliedRevision() is 2
      expect(coordinator.hasPendingNewerRevision()).toBe(true);
      expect(coordinator.getHighestObservedRevision()).toBe(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(2);

      // When revision 3 is subsequently applied via recordAppliedRevision(3), verify hasPendingNewerRevision() becomes false
      coordinator.recordAppliedRevision(3);
      expect(coordinator.getLatestAppliedRevision()).toBe(3);
      expect(coordinator.hasPendingNewerRevision()).toBe(false);
    });
  });

  describe('Session initialization failure and SSE subscription gating', () => {
    let prevWindow: unknown;
    let prevFetch: unknown;
    let replaceStateMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      prevWindow = (globalThis as unknown as { window?: unknown }).window;
      prevFetch = globalThis.fetch;
      replaceStateMock = vi.fn();

      (globalThis as unknown as { window: unknown }).window = {
        location: {
          pathname: '/',
          search: '',
          hash: '',
        },
        history: {
          state: {},
          replaceState: replaceStateMock,
        },
      };
    });

    afterEach(() => {
      (globalThis as unknown as { window: unknown }).window = prevWindow;
      globalThis.fetch = prevFetch as typeof fetch;
      vi.restoreAllMocks();
    });

    it('ensures session is not marked initialized and SSE is never subscribed upon auth or network failure', async () => {
      let sessionInitialized = false;
      let errorState: string | null = null;
      let sseSubscribed = false;

      const handleSessionInit = (initRes: { success: boolean; isAuthError?: boolean; error?: string }) => {
        if (!initRes.success) {
          errorState = initRes.error || 'Auth failed';
          return;
        }
        sessionInitialized = true;
      };

      const syncSseSubscription = () => {
        if (!sessionInitialized || errorState) return;
        sseSubscribed = true;
      };

      // Test 1: HTTP 401 response returns { success: false, isAuthError: true }
      (globalThis.window as { location: { search: string } }).location.search = '?bootstrap=bad_token';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid or expired bootstrap token.',
      }) as unknown as typeof fetch;

      const auth401Res = await initSession();
      expect(auth401Res.success).toBe(false);
      expect(auth401Res.isAuthError).toBe(true);

      handleSessionInit(auth401Res);
      syncSseSubscription();

      expect(sessionInitialized).toBe(false);
      expect(errorState).toContain('401');
      expect(sseSubscribed).toBe(false);

      // Test 2: Network failure returns { success: false, isAuthError: false }
      (globalThis.window as { location: { search: string } }).location.search = '?bootstrap=valid_token';
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused')) as unknown as typeof fetch;

      const networkFailRes = await initSession();
      expect(networkFailRes.success).toBe(false);
      expect(networkFailRes.isAuthError).toBe(false);

      errorState = null;
      handleSessionInit(networkFailRes);
      syncSseSubscription();

      expect(sessionInitialized).toBe(false);
      expect(errorState).toContain('Network failure');
      expect(sseSubscribed).toBe(false);

      // Test 3: Successful ambient session (200 { authenticated: true }) returns { success: true }
      (globalThis.window as { location: { search: string } }).location.search = '';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true }),
      }) as unknown as typeof fetch;

      const successRes = await initSession();
      expect(successRes.success).toBe(true);

      errorState = null;
      handleSessionInit(successRes);
      syncSseSubscription();

      expect(sessionInitialized).toBe(true);
      expect(errorState).toBeNull();
      expect(sseSubscribed).toBe(true);
    });

    it('returns { success: false, isAuthError: true } on HTTP 401 response', async () => {
      (globalThis.window as { location: { search: string } }).location.search = '?bootstrap=expired_token';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: async () => 'Invalid or expired bootstrap token.',
      }) as unknown as typeof fetch;

      const res = await initSession();
      expect(res.success).toBe(false);
      expect(res.isAuthError).toBe(true);
    });

    it('returns { success: false, isAuthError: false } on network failure', async () => {
      (globalThis.window as { location: { search: string } }).location.search = '?bootstrap=valid_token';
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error')) as unknown as typeof fetch;

      const res = await initSession();
      expect(res.success).toBe(false);
      expect(res.isAuthError).toBe(false);
    });

    it('returns { success: true } on successful ambient session (200 { authenticated: true })', async () => {
      (globalThis.window as { location: { search: string } }).location.search = '';
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ authenticated: true }),
      }) as unknown as typeof fetch;

      const res = await initSession();
      expect(res.success).toBe(true);
    });
  });
});

