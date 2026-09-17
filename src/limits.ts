export interface MemoryLimits { maxLessonWords: number; maxEvidenceWords: number; maxRecallLessons: number }
export const DEFAULT_LIMITS: Readonly<MemoryLimits> = Object.freeze({ maxLessonWords: 20, maxEvidenceWords: 20, maxRecallLessons: 30 });

export function memoryLimits(config: Record<string, unknown> = {}): Readonly<MemoryLimits> {
  const limits = { ...DEFAULT_LIMITS };
  for (const key of ["maxLessonWords", "maxEvidenceWords", "maxRecallLessons"] as const) {
    const value = config[key] === undefined ? DEFAULT_LIMITS[key] : config[key];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${key} must be a positive safe integer`);
    }
    limits[key] = value;
  }
  return Object.freeze(limits);
}
