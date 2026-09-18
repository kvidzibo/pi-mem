import { MemoryStore, type Basis, type LessonId, type Origin } from "./store.ts";

export const ACTIONS = ["add", "supersede", "archive"] as const;
export interface MemoryRequest {
  action: typeof ACTIONS[number];
  id?: LessonId;
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
      const result = store.supersede(scope, requireId(request), input, origin);
      return { id: result.id, supersedes_id: result.supersedes_id, status: "superseded", scope };
    }
    case "archive": {
      const result = store.archive(scope, requireId(request));
      return { id: result.id, archived: result.archived, scope };
    }
    default:
      throw new Error("Unknown memory action");
  }
}

function requireId(request: MemoryRequest): LessonId {
  if (typeof request.id === "number" && Number.isSafeInteger(request.id) && request.id > 0) return request.id;
  if (typeof request.id === "string" && request.id.trim()) return request.id;
  throw new Error("This action requires a positive integer id (legacy references are also accepted)");
}
