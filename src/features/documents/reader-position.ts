/** Scroll positions belong to the content on screen, never to a requested
 * selection that has not finished reading and parsing yet. */
export class ReaderPositionMemory {
  identity = '';
  private committing = false;
  constructor(private positions = new Map<string, number>()) {}
  record(top: number) {
    if (!this.identity || this.committing) return;
    this.positions.set(this.identity, top);
    if (this.positions.size > 100) this.positions.delete(this.positions.keys().next().value!);
  }
  startCommit(identity: string, currentTop: number) {
    this.record(currentTop);
    this.committing = true;
    return identity === this.identity ? currentTop : this.positions.get(identity) ?? 0;
  }
  finishCommit(identity: string) { this.identity = identity; this.committing = false; }
  clear(top: number) { this.record(top); this.identity = ''; this.committing = false; }
}
