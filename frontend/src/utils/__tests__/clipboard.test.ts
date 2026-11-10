import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  COPY_FEEDBACK_MS,
  createCopyFeedback,
  writeToClipboard,
} from '../clipboard';

function stubNavigator(value: unknown) {
  vi.stubGlobal('navigator', value);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('writeToClipboard (production clipboard boundary)', () => {
  it('writes the exact text and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubNavigator({ clipboard: { writeText } });

    await expect(writeToClipboard('src/utils/math.ts')).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('src/utils/math.ts');
  });

  it('reports a rejected permission without throwing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('Permission denied'));
    stubNavigator({ clipboard: { writeText } });

    await expect(writeToClipboard('secret')).resolves.toBe('rejected');
  });

  it('reports unavailable when navigator does not exist', async () => {
    // This is the Node/Vitest default that crashed the previous tests.
    stubNavigator(undefined);

    await expect(writeToClipboard('anything')).resolves.toBe('unavailable');
  });

  it('reports unavailable when the clipboard member is absent', async () => {
    stubNavigator({});

    await expect(writeToClipboard('anything')).resolves.toBe('unavailable');
  });

  it('reports unavailable when writeText is not callable', async () => {
    stubNavigator({ clipboard: { writeText: 'not-a-function' } });

    await expect(writeToClipboard('anything')).resolves.toBe('unavailable');
  });
});

describe('createCopyFeedback (shared copied-state timer)', () => {
  it('resets exactly after the documented 2000ms window', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    const feedback = createCopyFeedback(onReset);

    expect(COPY_FEEDBACK_MS).toBe(2000);
    feedback.schedule();

    vi.advanceTimersByTime(COPY_FEEDBACK_MS - 1);
    expect(onReset).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('restarts a single timer on rapid repeated copies', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    const feedback = createCopyFeedback(onReset);

    feedback.schedule();
    vi.advanceTimersByTime(1500);
    feedback.schedule(); // second copy at t=1500
    vi.advanceTimersByTime(1500); // t=3000: first timer would have fired

    expect(onReset).not.toHaveBeenCalled();

    vi.advanceTimersByTime(500); // t=3500: second timer fires
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it('cancel prevents a pending reset (component unmount path)', () => {
    vi.useFakeTimers();
    const onReset = vi.fn();
    const feedback = createCopyFeedback(onReset);

    feedback.schedule();
    feedback.cancel();

    vi.advanceTimersByTime(COPY_FEEDBACK_MS * 2);
    expect(onReset).not.toHaveBeenCalled();
  });
});
