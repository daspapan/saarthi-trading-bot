// Rolling numbers: ease from the old value to the new one.
export const easeOutCubic = (t: number) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3;
export const tween = (from: number, to: number, t: number) => from + (to - from) * easeOutCubic(t);
