import { Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { identity } from "effect/Function";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";
import { join } from "node:path";
import { AppConfig } from "./config.ts";
import { logger } from "./log.ts";
import { memoSuccess } from "./memo.ts";
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

export type StartedThread = { threadId: string; threadUrl: string };

/** Effect RPC JSON envelopes we care about (effect/rpc/RpcMessage). */
type RpcExit =
  | { _tag: "Success"; value: unknown }
  | { _tag: "Failure"; cause: unknown };
type RpcMessage =
  | { _tag: "Ping" }
  | { _tag: "Exit"; requestId: string; exit: RpcExit }
  | { _tag: "Defect"; defect: unknown }
  | { _tag: string };

/** Non-2xx reply from T3's HTTP API, or no reply at all (`status` 0); `status` lets callers tell "gone" (404) from "flaky". */
export class T3HttpError extends Data.TaggedError("T3HttpError")<{ readonly status: number; readonly message: string }> {}
/** The WebSocket RPC did not answer with a success: a failure exit, a defect, a dropped socket or a timeout. */
export class T3RpcError extends Data.TaggedError("T3RpcError")<{ readonly message: string }> {}
export type T3Error = T3HttpError | T3RpcError;

const DISPATCH_TIMEOUT = "10 minutes";
const PROVIDERS_CACHE = "30 seconds";
const DEFAULT_ORIGIN = "http://127.0.0.1:3773";

export type T3Shape = {
  readonly origin: string;
  /** Public descriptor; cached because the environment id never changes while the server runs. */
  readonly environment: Effect.Effect<T3Environment, T3HttpError>;
  readonly projects: () => Effect.Effect<T3Project[], T3HttpError>;
  /** Provider instances with their model lists, from `server.getConfig`. Cached briefly: the config payload is large. */
  readonly providers: () => Effect.Effect<T3Provider[], T3Error>;
  /** Latest turn of a thread with only that turn's messages (`turnLimit=1`). */
  readonly thread: (threadId: string) => Effect.Effect<T3ThreadTurn, T3HttpError>;
  /** Creates the thread (and worktree, when asked), sends the prompt, links the PR. */
  readonly startThread: (input: StartThreadInput) => Effect.Effect<StartedThread, T3Error>;
};

/** Builds the client for one origin and token. Needs an `HttpClient` and a `WebSocketConstructor`. */
export const makeT3 = Effect.fn("T3.make")(function* (origin: string, token: string) {
  const client = yield* HttpClient.HttpClient;
  const sockets = yield* Socket.WebSocketConstructor;
  const decoder = new TextDecoder();

  const request = <T>(method: "GET" | "POST", path: string, options: { authenticated?: boolean } = {}): Effect.Effect<T, T3HttpError> =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.make(method)(`${origin}${path}`).pipe(options.authenticated === false ? identity : HttpClientRequest.bearerToken(token)),
      );
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text;
        return yield* Effect.fail(new T3HttpError({ status: response.status, message: `T3 ${method} ${path} failed: ${response.status} ${body}` }));
      }
      return (yield* response.json) as T;
    }).pipe(Effect.catchTag("HttpClientError", (error) => Effect.fail(new T3HttpError({ status: 0, message: `T3 ${method} ${path} failed: ${error.message}` }))));

  /**
   * One RPC request per socket. The socket stays open until the server
   * replies: closing early would cancel an in-flight worktree bootstrap.
   */
  const rpc = <T>(tag: string, payload: Record<string, unknown>): Effect.Effect<T, T3Error> =>
    Effect.gen(function* () {
      const { ticket } = yield* request<{ ticket: string }>("POST", "/api/auth/websocket-ticket");
      const url = new URL("/ws", origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      const what = tag === "orchestration.dispatchCommand" ? `dispatch ${String(payload.type)}` : tag;
      const fail = (message: string) => new T3RpcError({ message: `T3 ${what} failed: ${message}` });

      const socket = yield* Socket.makeWebSocket(url.toString()).pipe(Effect.provideService(Socket.WebSocketConstructor, sockets));
      const exchange = Effect.gen(function* () {
        const writer = yield* socket.writer;
        const reader = yield* socket.reader;
        yield* writer.write(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
        for (;;) {
          const frames = yield* reader.pull;
          for (const frame of frames) {
            const decoded = yield* Effect.try({
              try: () => JSON.parse(typeof frame === "string" ? frame : decoder.decode(frame)) as RpcMessage | RpcMessage[],
              catch: () => fail("unreadable reply"),
            });
            for (const message of Array.isArray(decoded) ? decoded : [decoded]) {
              if (message._tag === "Ping") {
                yield* writer.write(JSON.stringify({ _tag: "Pong" }));
              } else if (message._tag === "Exit" && "exit" in message) {
                if (message.exit._tag === "Success") return message.exit.value as T;
                return yield* Effect.fail(fail(JSON.stringify(message.exit.cause)));
              } else if (message._tag === "Defect" && "defect" in message) {
                return yield* Effect.fail(fail(JSON.stringify(message.defect)));
              }
            }
          }
        }
      });
      return yield* exchange.pipe(
        Effect.scoped,
        Effect.timeout(DISPATCH_TIMEOUT),
        Effect.catchTags({
          SocketError: (error) => Effect.fail(fail(error.message)),
          TimeoutError: () => Effect.fail(fail(`no reply after ${DISPATCH_TIMEOUT}`)),
        }),
      );
    }).pipe(Effect.withSpan("t3.rpc", { attributes: { tag } }));

  const environment = yield* memoSuccess(request<T3Environment>("GET", "/.well-known/t3/environment", { authenticated: false }));

  const providers = yield* memoSuccess(
    Effect.map(rpc<ServerConfig>("server.getConfig", {}), (config): T3Provider[] =>
      config.providers.map((provider) => ({
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
      })),
    ),
    PROVIDERS_CACHE,
  );

  const dispatch = (command: Record<string, unknown>) => rpc<{ sequence: number }>("orchestration.dispatchCommand", command);

  const startThread = Effect.fn("t3.startThread")(function* (input: StartThreadInput) {
    const threadId = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const prepareWorktree = input.worktree && input.baseBranch !== null;
    yield* Effect.annotateCurrentSpan({ project: input.project.id, thread: threadId, worktree: prepareWorktree });

    yield* dispatch({
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
      yield* dispatch({
        type: "thread.pull-request.link",
        commandId: crypto.randomUUID(),
        threadId,
        host: "github.com",
        repository: input.pullRequest.repository,
        number: input.pullRequest.number,
        url: input.pullRequest.url,
        source: "manual",
      }).pipe(Effect.catch((error) => log.warn("pull request link failed", { thread: threadId, error: error.message })));
    }

    const { environmentId } = yield* environment;
    return { threadId, threadUrl: `${origin}/${environmentId}/${threadId}` };
  });

  const shape: T3Shape = {
    origin,
    environment,
    projects: () =>
      Effect.map(request<{ projects: T3Project[] }>("GET", "/api/orchestration/snapshot"), (snapshot) =>
        snapshot.projects.filter((project) => project.deletedAt === null),
      ),
    providers: () => providers,
    thread: (threadId) =>
      Effect.map(request<{ thread: T3ThreadTurn }>("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}?turnLimit=1`), (snapshot) => snapshot.thread),
    startThread,
  };
  return shape;
});

/** `T3_ORIGIN`, else the origin the running desktop/server wrote to server-runtime.json, else T3's default port. */
const resolveOrigin = (config: Context.Service.Shape<typeof AppConfig>) =>
  Option.match(config.t3Origin, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.tryPromise(async () => {
        const runtime = Bun.file(join(config.t3Home, "userdata", "server-runtime.json"));
        if (!(await runtime.exists())) return null;
        const state = (await runtime.json()) as { origin?: string };
        return state.origin ?? null;
      }).pipe(
        Effect.orElseSucceed(() => null),
        Effect.map((origin) => origin ?? DEFAULT_ORIGIN),
      ),
  });

export class T3 extends Context.Service<T3, T3Shape>()("T3") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const config = yield* AppConfig;
      return yield* makeT3(yield* resolveOrigin(config), Redacted.value(config.t3Token));
    }),
  );
}
