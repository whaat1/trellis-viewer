export function snapTaskHeight(value: number, min: number, max: number, rowHeight = 72) {
  const count = Math.max(0, Math.floor((max - min) / rowHeight));
  const targets = Array.from({ length: count + 1 }, (_, index) => min + index * rowHeight);
  return targets.reduce((closest, target) => Math.abs(target - value) < Math.abs(closest - value) ? target : closest, targets[0]);
}
