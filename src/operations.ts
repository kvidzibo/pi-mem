import { MemoryStore, type Basis, type Origin } from "./store.ts";

export const ACTIONS = ["add", "supersede", "archive"] as const;
export interface MemoryRequest {
  action: typeof ACTIONS[number];
  id?: number;
  text?: string;
  evidence?: string;
  basis?: Exclude<Basis, "import">;
}

/** Agent-facing writes only. Reads stay internal to automatic recall and explicit user commands. */
export function runMemory(store: MemoryStore, scope: string, request: MemoryRequest, origin: Origin): unknown {
  switch (request.action) {
    case "add":
    case "supersede": {
      if (request.basis !== "validated_learning" && request.basis !== "validated_fix" && request.basis !== "user_request") {
        throw new Error("add/supersede requires basis: validated_learning, validated_fix, or user_request");
      }
      const input = { text: request.text!, evidence: request.evidence!, basis: request.basis };
      if (request.action === "add") {
        const result = store.add(scope, input, origin);
        return { id: result.lesson.id, status: result.created ? "saved" : "already exists", scope };
      }
      const result = store.supersede(scope, parseLessonId(request.id), input, origin);
      return { id: result.id, supersedes_id: result.supersedes_id, status: "superseded", scope };
    }
    case "archive": {
      const result = store.archive(scope, parseLessonId(request.id));
      return { id: result.id, archived: result.archived, scope };
    }
    default:
      throw new Error("Unknown memory action");
  }
}

/** Parse decimal IDs at command/tool boundaries; UUIDs and coercible non-ID values are invalid. */
export function parseLessonId(value: unknown): number {
  const id = typeof value === "string" && /^#?[1-9]\d*$/.test(value.trim())
    ? Number(value.trim().replace(/^#/, "")) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new Error("id must be a positive safe integer");
  }
  return id;
}
