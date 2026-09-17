import { boundedPage } from "./presentation.ts";
import { MemoryStore, type Basis, type Origin, type State } from "./store.ts";

export const ACTIONS = ["list", "search", "get", "add", "update", "archive", "restore"] as const;
export interface MemoryRequest {
  action: typeof ACTIONS[number];
  id?: string;
  revision?: number;
  text?: string;
  evidence?: string;
  basis?: Exclude<Basis, "import">;
  query?: string;
  state?: State;
  offset?: number;
  limit?: number;
}

export function runMemory(store: MemoryStore, scope: string, request: MemoryRequest, origin: Origin): unknown {
  switch (request.action) {
    case "list":
    case "search": {
      if (request.action === "search" && !request.query?.trim()) throw new Error("search requires query");
      const offset = request.offset ?? 0;
      return boundedPage(store.list(scope, {
        query: request.query, state: request.state, offset, limit: request.limit,
      }), offset);
    }
    case "get":
      return store.get(scope, requireId(request));
    case "add":
    case "update": {
      if (request.basis !== "validated_fix" && request.basis !== "user_request") {
        throw new Error("add/update requires basis: validated_fix or user_request");
      }
      const input = { text: request.text!, evidence: request.evidence!, basis: request.basis };
      if (request.action === "add") {
        const result = store.add(scope, input, origin);
        return {
          id: result.lesson.id, revision: result.lesson.revision, archived: result.lesson.archived,
          status: result.created ? "saved" : "already exists", scope,
        };
      }
      const result = store.update(scope, requireId(request), request.revision!, input, origin);
      return { id: result.id, revision: result.revision, status: "updated", scope };
    }
    case "archive":
    case "restore": {
      const result = store.setArchived(scope, requireId(request), request.revision!, request.action === "archive");
      return { id: result.id, revision: result.revision, archived: result.archived, scope };
    }
    default:
      throw new Error("Unknown memory action");
  }
}

function requireId(request: MemoryRequest): string {
  if (typeof request.id !== "string" || !request.id.trim()) throw new Error("This action requires id");
  return request.id;
}
