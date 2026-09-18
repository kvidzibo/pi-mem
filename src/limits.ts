export interface MemoryLimits { maxLessonWords: number; maxEvidenceWords: number; maxRecallLessons: number; maxRecallBytes: number }
export const DEFAULT_LIMITS: Readonly<MemoryLimits> = Object.freeze({
  maxLessonWords: 20, maxEvidenceWords: 20, maxRecallLessons: 30, maxRecallBytes: 8192,
});

export function memoryLimits(config: Record<string, unknown> = {}): Readonly<MemoryLimits> {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of ["maxLessonWords", "maxEvidenceWords", "maxRecallLessons", "maxRecallBytes"] as const) {
    const value = config[key] === undefined ? DEFAULT_LIMITS[key] : config[key];
    // Keep room for the heading and omission count even when no lessons fit.
    const minimum = key === "maxRecallBytes" ? 64 : 1;
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`${key} must be ${minimum === 1 ? "a positive safe integer" : `a safe integer of at least ${minimum}`}`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}
