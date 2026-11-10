import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/** How long the "Copied" affordance stays visible after a successful write. */
export const COPY_FEEDBACK_MS = 2000;

/**
 * Outcome of a clipboard write. Returning a value instead of rejecting keeps
 * callers honest: a denied permission or missing API must never look like a
 * successful copy.
 */
export type ClipboardWriteResult = 'copied' | 'unavailable' | 'rejected';

/**
 * Copy text through the real Clipboard API.
 *
 * `navigator` does not exist in every runtime (SSR, Node-based test runners,
 * older browsers), so both the global and the `clipboard` member are guarded.
 */
export async function writeToClipboard(text: string): Promise<ClipboardWriteResult> {
  const clipboard =
    typeof globalThis.navigator === 'undefined'
      ? undefined
      : globalThis.navigator.clipboard;

  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return 'unavailable';
  }

  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'rejected';
  }
}

export interface CopyFeedbackTimer {
  /** (Re)start the reset countdown, cancelling any previous one. */
  schedule(): void;
  /** Stop the countdown without invoking the reset callback. */
  cancel(): void;
}

/**
 * Single-shot reset timer shared by every copy affordance. Rapid copies reset
 * the same timer instead of stacking several that fire out of order.
 */
export function createCopyFeedback(
  onReset: () => void,
  resetMs: number = COPY_FEEDBACK_MS
): CopyFeedbackTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        onReset();
      }, resetMs);
    },
    cancel,
  };
}

/**
 * React binding for the copy affordance: `copied` flips true only after a real
 * successful write and clears itself after {@link COPY_FEEDBACK_MS}.
 */
export function useCopyFeedback(resetMs: number = COPY_FEEDBACK_MS) {
  const [copied, setCopied] = useState(false);
  const mountedRef = useRef(true);

  const feedback = useMemo(
    () => createCopyFeedback(() => setCopied(false), resetMs),
    [resetMs]
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      feedback.cancel();
    };
  }, [feedback]);

  const copy = useCallback(
    async (text: string): Promise<ClipboardWriteResult> => {
      const result = await writeToClipboard(text);
      if (result === 'copied' && mountedRef.current) {
        setCopied(true);
        feedback.schedule();
      }
      return result;
    },
    [feedback]
  );

  return { copied, copy };
}
