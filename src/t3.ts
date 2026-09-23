import { logger } from "./log.ts";
import type { ModelSelection } from "./rules.ts";
import type { RuntimeMode } from "./shared.ts";

const log = logger("t3");

/**
 * Minimal client for a T3 Code environment.
 *
 * Reads go over HTTP (`packages/contracts/src/environmentHttp.ts`). Commands go
 * over the WebSocket RPC (`orchestration.dispatchCommand`) because only that
 * path runs the thread bootstrap: T3 fetches the base branch, creates the
 * worktree, runs the project's setup script, then starts the turn. The token
 * needs the `orchestration:operate` scope.
 */

export type T3Project = {
  id: string;
  title: string;
  workspaceRoot: string;
  deletedAt: string | null;
  defaultModelSelection: ModelSelection | null;
  repositoryIdentity?: {
    canonicalKey: string;
    provider?: string;
    owner?: string;
    name?: string;
  } | null;
};

export type T3Model = {
  slug: string;
  name: string;
  isDefault: boolean;
  isLegacy: boolean;
};

/** A configured provider instance and the models T3 currently offers for it. */
export type T3Provider = {
  instanceId: string;
  driver: string;
  displayName: string;
  enabled: boolean;
  status: string;
  models: T3Model[];
};

type ServerConfig = {
  providers: Array<{
    instanceId: string;
    driver: string;
    displayName?: string;
    enabled: boolean;
    status: string;
    models: Array<{ slug: string; name: string; isDefault?: boolean; isLegacy?: boolean }>;
  }>;
};

export type T3Environment = {
  environmentId: string;
  label: string;
  serverVersion: string;
};

/**
 * The slice of a thread snapshot needed to tell when the agent is done and
 * what it said. `activities` carry background tasks (subagents, background
 * shells) that outlive the turn that started them: T3 begins a new turn when
 * they report back, so a completed turn alone does not mean the thread is done.
 */
export type T3ThreadTurn = {
  latestTurn: {
    turnId: string;
    state: "running" | "interrupted" | "completed" | "error";
    completedAt: string | null;
    assistantMessageId: string | null;
  } | null;
  messages: Array<{ id: string; role: "user" | "assistant" | "system"; text: string; turnId: string | null }>;
  /** T3 keeps the last 500 entries plus a few pinned kinds. */
  activities: Array<{ kind: string; turnId: string | null; createdAt: string; payload: unknown }>;
  /** `stopped` means the provider process exited: nothing more will happen. */
  session: { status: string; activeTurnId: string | null; lastError: string | null } | null;
};

export type StartThreadInput = {
  project: Pick<T3Project, "id" | "workspaceRoot">;
  title: string;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  /** Branch the thread starts from (PR head, or the default branch). */
  baseBranch: string | null;
  /** Ask T3 to create a worktree from `origin/<baseBranch>`; otherwise run in the checkout. */
  worktree: boolean;
  pullRequest: { repository: string; number: number; url: string } | null;
};

/** Effect RPC JSON envelopes we care about (effect/unstable/rpc/RpcMessage). */
type RpcExit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: unknown };
type RpcMessage =
  | { _tag: "Ping" }
  | { _tag: "Exit"; requestId: string; exit: RpcExit }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: string };

/** Non-2xx reply from T3's HTTP API; `status` lets callers tell "gone" (404) from "flaky". */
export class T3HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "T3HttpError";
  }
}

const DISPATCH_TIMEOUT_MS = 10 * 60_000;

const PROVIDERS_CACHE_MS = 30_000;

export class T3Client {
  private environmentPromise: Promise<T3Environment> | null = null;
  private providersCache: { at: number; value: T3Provider[] } | null = null;

  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {}

  /** Public descriptor; cached because the environment id never changes while the server runs. */
  environment(): Promise<T3Environment> {
    this.environmentPromise ??= this.request<T3Environment>("GET", "/.well-known/t3/environment", {
      authenticated: false,
    }).catch((error) => {
      this.environmentPromise = null;
      throw error;
    });
    return this.environmentPromise;
  }

  async projects(): Promise<T3Project[]> {
    const snapshot = await this.request<{ projects: T3Project[] }>("GET", "/api/orchestration/snapshot");
    return snapshot.projects.filter((project) => project.deletedAt === null);
  }

  /** Provider instances with their model lists, from `server.getConfig`. Cached briefly: the config payload is large. */
  async providers(): Promise<T3Provider[]> {
    if (this.providersCache && Date.now() - this.providersCache.at < PROVIDERS_CACHE_MS) {
      return this.providersCache.value;
    }
    const config = await this.rpc<ServerConfig>("server.getConfig", {});
    const value = config.providers.map((provider) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      displayName: provider.displayName ?? provider.instanceId,
      enabled: provider.enabled,
      status: provider.status,
      models: provider.models.map((model) => ({
        slug: model.slug,
        name: model.name,
        isDefault: model.isDefault === true,
        isLegacy: model.isLegacy === true,
      })),
    }));
    this.providersCache = { at: Date.now(), value };
    return value;
  }

  /** Latest turn of a thread with only that turn's messages (`turnLimit=1`). */
  async thread(threadId: string): Promise<T3ThreadTurn> {
    const snapshot = await this.request<{ thread: T3ThreadTurn }>(
      "GET",
      `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=1`,
    );
    return snapshot.thread;
  }

  /** Creates the thread (and worktree, when asked), sends the prompt, links the PR. */
  async startThread(input: StartThreadInput) {
    const threadId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const prepareWorktree = input.worktree && input.baseBranch !== null;

    await this.dispatch({
      type: "thread.turn.start",
      commandId: crypto.randomUUID(),
      threadId,
      message: {
        messageId: crypto.randomUUID(),
        role: "user",
        text: input.prompt,
        attachments: [],
      },
      modelSelection: input.modelSelection,
      titleSeed: input.title,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: input.project.id,
          title: input.title,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          branch: input.baseBranch,
          worktreePath: null,
          createdAt,
        },
        ...(prepareWorktree
          ? {
              prepareWorktree: {
                projectCwd: input.project.workspaceRoot,
                baseBranch: input.baseBranch,
                // Same temporary branch shape T3's own composer uses.
                branch: `t3code/${crypto.randomUUID().replaceAll("-", "").slice(0, 8)}`,
                startFromOrigin: true,
                requireWorktree: true,
              },
              runSetupScript: true,
            }
          : {}),
      },
      createdAt,
    });

    if (input.pullRequest) {
      // Best effort: the thread is already running, a failed link is only cosmetic.
      await this.dispatch({
        type: "thread.pull-request.link",
        commandId: crypto.randomUUID(),
        threadId,
        host: "github.com",
        repository: input.pullRequest.repository,
        number: input.pullRequest.number,
        url: input.pullRequest.url,
        source: "manual",
      }).catch((error: unknown) => {
        log.warn("pull request link failed", { thread: threadId, error });
      });
    }

    const { environmentId } = await this.environment();
    return { threadId, threadUrl: `${this.origin}/${environmentId}/${threadId}` };
  }

  private dispatch(command: Record<string, unknown>): Promise<{ sequence: number }> {
    return this.rpc("orchestration.dispatchCommand", command);
  }

  /**
   * One RPC request per socket. The socket stays open until the server
   * replies: closing early would cancel an in-flight worktree bootstrap.
   */
  private async rpc<T>(tag: string, payload: Record<string, unknown>): Promise<T> {
    const { ticket } = await this.request<{ ticket: string }>("POST", "/api/auth/websocket-ticket");
    const url = new URL("/ws", this.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("wsTicket", ticket);

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
        ws.close();
      };
      const what = tag === "orchestration.dispatchCommand" ? `dispatch ${String(payload.type)}` : tag;
      const fail = (message: string) => finish(() => reject(new Error(`T3 ${what} failed: ${message}`)));
      const timer = setTimeout(() => fail(`no reply after ${DISPATCH_TIMEOUT_MS / 1000}s`), DISPATCH_TIMEOUT_MS);

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            _tag: "Request",
            id: "1",
            tag,
            payload,
            headers: [],
          }),
        );
      };
      ws.onmessage = (event) => {
        const decoded: RpcMessage | RpcMessage[] = JSON.parse(String(event.data));
        for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
          if (message._tag === "Ping") {
            ws.send(JSON.stringify({ _tag: "Pong" }));
          } else if (message._tag === "Exit" && "exit" in message) {
            const exit = message.exit;
            if (exit._tag === "Success") {
              finish(() => resolve(exit.value as T));
            } else {
              fail(JSON.stringify(exit.cause));
            }
          } else if (message._tag === "Defect" && "defect" in message) {
            fail(JSON.stringify(message.defect));
          }
        }
      };
      ws.onerror = () => fail("websocket error");
      ws.onclose = (event) => fail(`socket closed (${event.code}) before a reply`);
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { authenticated?: boolean } = {},
  ): Promise<T> {
    const response = await fetch(`${this.origin}${path}`, {
      method,
      headers: options.authenticated === false ? {} : { authorization: `Bearer ${this.token}` },
    });
    if (!response.ok) {
      throw new T3HttpError(response.status, `T3 ${method} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }
}
