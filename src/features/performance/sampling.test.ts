import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SamplingSession, type SamplingAdapter } from './sampling';
let focusEvent: (focused: boolean) => void;
let visibilityEvent: () => void;
let visible = true;
let adapter: SamplingAdapter;
let session: SamplingSession;
let unsubscribe: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); visible = true; unsubscribe = vi.fn();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  adapter = { focus: vi.fn(async () => {}), focused: vi.fn(async () => true), onFocus: async handler => { focusEvent = handler; return unsubscribe; }, visible: () => visible, onVisibility: handler => { visibilityEvent = handler; return unsubscribe; } };
  session = new SamplingSession(adapter);
});
afterEach(() => { session.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });
describe('foreground sampling evidence', () => {
  it('requests focus once, verifies native focus and visibility, and aborts permanently on loss', async () => {
    await session.start();
    expect(adapter.focus).toHaveBeenCalledTimes(1);
    expect(session.evidence.focusVerifiedAtStart).toBe(true);
    expect(session.evidence.visibleAtStart).toBe(true);
    focusEvent(false); focusEvent(true);
    expect(session.eligible()).toBe(false);
    expect(() => session.assertForeground()).toThrow('NATIVE_WINDOW_FOCUS_LOST');
    expect(session.evidence.valid).toBe(false);
    expect(adapter.focus).toHaveBeenCalledTimes(1);
  });
  it('bounds a missing frame callback and cancels it instead of hanging', async () => {
    await session.start();
    const failed = expect(session.frame()).rejects.toThrow('FRAME_TIMEOUT');
    await vi.advanceTimersByTimeAsync(2001);
    await failed;
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(session.evidence.valid).toBe(false);
  });
  it('rejects an initially hidden window without entering sampling', async () => {
    visible = false;
    const failed = expect(session.start()).rejects.toThrow('WINDOW_NOT_FOREGROUND_AT_START');
    await vi.advanceTimersByTimeAsync(2100); await failed;
    expect(session.evidence.focusVerifiedAtStart).toBe(false);
    expect(session.evidence.valid).toBe(false);
  });
  it('rejects visibility loss and native focus loss detected by fallback polling', async () => {
    await session.start();
    vi.mocked(adapter.focused).mockResolvedValue(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(session.eligible()).toBe(false);
    expect(session.evidence.failures[0].reason).toBe('NATIVE_WINDOW_FOCUS_LOST');
    session.stop();
    session = new SamplingSession(adapter);
    vi.mocked(adapter.focused).mockResolvedValue(true);
    await session.start(); visible = false; visibilityEvent();
    expect(() => session.assertForeground()).toThrow('DOCUMENT_HIDDEN');
  });
  it('cleans native and visibility subscriptions on completion', async () => {
    await session.start(); session.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(adapter.focused).toHaveBeenCalledTimes(1);
  });
});
