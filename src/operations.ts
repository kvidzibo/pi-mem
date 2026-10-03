import { checkedPriority, MemoryStore, type Basis, type Origin } from "./store.ts";

export const ACTIONS = ["add", "supersede", "archive", "set_priority"] as const;
export interface MemoryRequest {
  action: typeof ACTIONS[number];
  id?: number;
  text?: string;
  evidence?: string;
  priority?: number;
  reason?: string;
  basis?: Exclude<Basis, "import">;
}

/** Internal active-lesson writes; model additions stage candidates in the tool adapter. */
export function runMemory(store: MemoryStore, scope: string, request: MemoryRequest, origin: Origin) {
  origin = { ...origin, reason: request.reason };
  if ("scope" in request) throw new Error("memory does not accept scope; evaluation decides promotion scope");
  if (request.action !== "add" && ACTIONS.includes(request.action)) {
    scope = store.scopeForId(scope, parseLessonId(request.id));
  }
  switch (request.action) {
    case "add":
    case "supersede": {
      if (request.basis !== "validated_learning" && request.basis !== "validated_fix" && request.basis !== "user_request") {
        throw new Error("add/supersede requires basis: validated_learning, validated_fix, or user_request");
      }
      if (request.action === "add" || request.priority !== undefined) checkedPriority(request.priority, 1);
      const input = { text: request.text!, evidence: request.evidence!, basis: request.basis, priority: request.priority };
      if (request.action === "add") {
        const result = store.add(scope, input, origin);
        return { id: result.lesson.id, priority: result.lesson.priority, status: result.created ? "saved" : "already exists", scope };
      }
      const result = store.supersede(scope, parseLessonId(request.id), input, origin, true);
      return { id: result.id, priority: result.priority, supersedes_id: result.supersedes_id, status: "superseded", scope };
    }
    case "set_priority": {
      checkedPriority(request.priority, 1);
      const id = parseLessonId(request.id);
      if (store.get(scope, id).priority === 0) throw new Error("Priority 0 is user-reserved; models cannot reprioritize it");
      const result = store.setPriority(scope, id, request.priority!, origin);
      return { id: result.id, priority: result.priority, status: "priority updated", scope };
    }
    case "archive": {
      const result = store.archive(scope, parseLessonId(request.id), origin);
      return { id: result.lesson.id, archived: result.lesson.archived, changed: result.changed, scope };
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
