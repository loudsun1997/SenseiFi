import type Database from "libsql";
import { AbortedError, handleMessage } from "./agent.js";
import type { ProgressCallback } from "./agent.js";
import type { ChatSurface } from "./system-prompt.js";

export interface AgentChatRequest {
  db: Database.Database;
  message: string;
  onProgress?: ProgressCallback;
  signal?: AbortSignal;
  surface?: ChatSurface;
}

export interface AgentRuntime {
  name: string;
  chat(request: AgentChatRequest): Promise<string>;
}

class LocalAgentRuntime implements AgentRuntime {
  name = "local-agent-loop";

  async chat(request: AgentChatRequest): Promise<string> {
    return handleMessage(
      request.db,
      request.message,
      request.onProgress,
      request.signal,
      { surface: request.surface || "cli" },
    );
  }
}

let singletonRuntime: AgentRuntime | null = null;

export function getAgentRuntime(): AgentRuntime {
  if (!singletonRuntime) {
    singletonRuntime = new LocalAgentRuntime();
  }
  return singletonRuntime;
}

export { AbortedError };
