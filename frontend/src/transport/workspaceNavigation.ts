import { WorkspaceNavigateEventData } from '../types/temporal';

export type WorkspaceView = '3d' | '2d' | 'temporal';

export interface WorkspaceNavigateTarget {
  requestId: string;
  view: WorkspaceView;
  focus: string | null;
}

export type WorkspaceNavigateHandler = (target: WorkspaceNavigateTarget) => void;

const CLIENT_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
let cachedClientId: string | null = null;
const activeHandlers = new Set<WorkspaceNavigateHandler>();

function generateBoundedClientId(): string {
  const randomPart =
    typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().replace(/-/g, '')
      : `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  return `pb_${randomPart}`.slice(0, 64);
}

/**
 * Returns a stable, bounded per-tab client identifier (`^[a-zA-Z0-9_-]{1,64}$`)
 * used to correlate SSE workspace navigation commands and acknowledgments.
 */
export function getWorkspaceClientId(): string {
  if (!cachedClientId || !CLIENT_ID_PATTERN.test(cachedClientId)) {
    cachedClientId = generateBoundedClientId();
  }
  return cachedClientId;
}

/**
 * Register a navigation callback for an active workspace view (for example in App.tsx).
 * Returns an unsubscribe function suitable for React `useEffect` cleanup.
 */
export function registerWorkspaceNavigateHandler(handler: WorkspaceNavigateHandler): () => void {
  activeHandlers.add(handler);
  return () => {
    activeHandlers.delete(handler);
  };
}

export function hasWorkspaceNavigateHandler(): boolean {
  return activeHandlers.size > 0;
}

/**
 * Dispatches an incoming `workspace.navigate` SSE command to registered workspace
 * handlers and acknowledges delivery back to the server if handled.
 */
export async function dispatchWorkspaceNavigate(
  data: WorkspaceNavigateEventData
): Promise<boolean> {
  if (data.target_client_id && data.target_client_id !== getWorkspaceClientId()) {
    return false;
  }
  if (activeHandlers.size === 0) {
    return false;
  }

  const target: WorkspaceNavigateTarget = {
    requestId: data.request_id,
    view: data.view,
    focus: data.focus ?? null,
  };

  for (const handler of activeHandlers) {
    try {
      handler(target);
    } catch {
      // Isolate handler errors so acknowledgment still reflects workspace dispatch
    }
  }

  try {
    const response = await fetch('/api/v1/workspace/ack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        request_id: data.request_id,
        client_id: getWorkspaceClientId(),
      }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function resetWorkspaceNavigationForTests(): void {
  activeHandlers.clear();
  cachedClientId = null;
}
