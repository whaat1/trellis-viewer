export interface SamplingAdapter {
  focus(): Promise<void>;
  focused(): Promise<boolean>;
  onFocus(handler: (focused: boolean) => void): Promise<() => void>;
  visible(): boolean;
  onVisibility(handler: () => void): () => void;
}
export interface SamplingEvidence {
  valid: boolean; focusVerifiedAtStart: boolean; visibleAtStart: boolean;
  nativeFocused: boolean | null; focusChecks: number; focusPollMs: number;
  failures: { reason: string; elapsedMs: number }[];
}
export class SamplingSession {
  readonly evidence: SamplingEvidence = { valid: false, focusVerifiedAtStart: false, visibleAtStart: false, nativeFocused: null, focusChecks: 0, focusPollMs: 500, failures: [] };
  private started = performance.now();
  private armed = false;
  private stopped = false;
  private failure = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private cleanups: (() => void)[] = [];
  constructor(private adapter: SamplingAdapter) {}
  private invalidate(reason: string): Error {
    if (!this.failure) {
      this.failure = reason; this.evidence.valid = false;
      this.evidence.failures.push({ reason, elapsedMs: performance.now() - this.started });
    }
    return new Error(this.failure);
  }
  private async bounded<T>(promise: Promise<T>, reason: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(this.invalidate(reason)), 2000); })]); }
    finally { clearTimeout(timer); }
  }
  private async verifyFocus() {
    const focused = await this.bounded(this.adapter.focused(), 'FOCUS_CHECK_TIMEOUT');
    this.evidence.focusChecks++; this.evidence.nativeFocused = focused;
    if (this.armed && !focused) throw this.invalidate('NATIVE_WINDOW_FOCUS_LOST');
    return focused;
  }
  async start() {
    this.cleanups.push(await this.bounded(this.adapter.onFocus(focused => {
      this.evidence.nativeFocused = focused;
      if (this.armed && !focused) this.invalidate('NATIVE_WINDOW_FOCUS_LOST');
    }).then(cleanup => { if (this.stopped) { cleanup(); return () => {}; } return cleanup; }), 'FOCUS_LISTENER_TIMEOUT'));
    this.cleanups.push(this.adapter.onVisibility(() => { if (this.armed && !this.adapter.visible()) this.invalidate('DOCUMENT_HIDDEN'); }));
    // One request at startup only; never steal focus back after a user leaves.
    await this.bounded(this.adapter.focus(), 'WINDOW_FOCUS_REQUEST_TIMEOUT');
    const deadline = performance.now() + 2000;
    while (!await this.verifyFocus() || !this.adapter.visible()) {
      if (performance.now() >= deadline) throw this.invalidate('WINDOW_NOT_FOREGROUND_AT_START');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    this.evidence.focusVerifiedAtStart = true;
    this.evidence.visibleAtStart = true;
    this.evidence.valid = true; this.armed = true;
    const poll = async () => {
      if (this.stopped || this.failure) return;
      try { await this.verifyFocus(); this.assertForeground(); }
      catch (error) { this.invalidate(error instanceof Error ? error.message : String(error)); return; }
      if (!this.stopped) this.timer = setTimeout(() => { void poll(); }, this.evidence.focusPollMs);
    };
    this.timer = setTimeout(() => { void poll(); }, this.evidence.focusPollMs);
  }
  assertForeground() {
    if (this.failure) throw new Error(this.failure);
    if (!this.armed || !this.evidence.nativeFocused) throw this.invalidate('WINDOW_NOT_FOREGROUND');
    if (!this.adapter.visible()) throw this.invalidate('DOCUMENT_HIDDEN');
  }
  eligible() { return this.armed && !this.failure && this.evidence.nativeFocused === true && this.adapter.visible(); }
  frame(): Promise<number> {
    this.assertForeground();
    return new Promise((resolve, reject) => {
      const id = requestAnimationFrame(now => {
        clearTimeout(timer);
        try { this.assertForeground(); resolve(now); } catch (error) { reject(error); }
      });
      const timer = setTimeout(() => { cancelAnimationFrame(id); reject(this.invalidate('FRAME_TIMEOUT: no frame callback within 2000ms')); }, 2000);
    });
  }
  stop() { this.stopped = true; clearTimeout(this.timer); for (const cleanup of this.cleanups.splice(0)) cleanup(); }
}
