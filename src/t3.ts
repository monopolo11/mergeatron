import { Context, Data, Effect, Layer, Option, Redacted } from "effect";
import { identity } from "effect/Function";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";
import { join } from "node:path";
import { AppConfig } from "./config.ts";
import { execOk, type CommandError } from "./exec.ts";
import { logger } from "./log.ts";
import { memoSuccess } from "./memo.ts";
import type { ModelSelection } from "./rules.ts";
import type { RuntimeMode } from "./shared.ts";

const log = logger("t3");

/**
 * Minimal client for a T3 Code environment speaking orchestration protocol 2
 * (T3 0.0.46 and later).
 *
 * Reads go over HTTP (`packages/contracts/src/environmentHttp.ts`). Writes go
 * over the WebSocket RPC (`packages/contracts/src/orchestrationV2.ts`):
 * `orchestration.launchThread` creates the thread, fetches the base branch,
 * creates the worktree, runs the project's setup script and sends the first
 * message. The token needs the `orchestration:operate` scope.
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
  /** Skills a user can start from a prompt, written as `$name` (T3 dispatches them per provider). */
  skills: T3Skill[];
};

/** A provider skill, trimmed from `ServerProviderSkill` to what the prompt editor shows. */
export type T3Skill = {
  name: string;
  displayName: string | null;
  description: string | null;
  /** Where it was installed: `user`, `project`, `system`… */
  scope: string | null;
  path: string;
};

type ServerConfig = {
  providers: Array<{
    instanceId: string;
    driver: string;
    displayName?: string;
    enabled: boolean;
    status: string;
    models: Array<{ slug: string; name: string; isDefault?: boolean; isLegacy?: boolean }>;
    skills?: Array<{
      name: string;
      displayName?: string;
      description?: string;
      shortDescription?: string;
      scope?: string;
      path: string;
      enabled: boolean;
      userInvocable?: boolean;
    }>;
  }>;
};

export type T3Environment = {
  environmentId: string;
  label: string;
  serverVersion: string;
};

/** `OrchestrationV2RunStatus`: every message the agent answers is one run. */
export type T3RunStatus =
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

/**
 * The slice of a thread projection needed to tell when the agent is done and
 * what it said. Background work (subagents, background shells) can outlive
 * the run that started it: it shows as live `subagents` or provider
 * `pendingBackgroundTasks`, and T3 starts a new run when it reports back, so
 * a completed run alone does not mean the thread is done.
 */
export type T3Thread = {
  /** The thread's own record; `pullRequests` are the PRs linked to it, by the orchestrator or by the agent. Older threads have none. */
  thread: { pullRequests?: T3PullRequest[] };
  runs: Array<{ id: string; ordinal: number; status: T3RunStatus; startedAt: string | null; completedAt: string | null }>;
  /** A recent window (bounded snapshot) that always holds the latest run's messages. */
  messages: Array<{ id: string; runId: string | null; role: "user" | "assistant" | "system"; text: string; updatedAt: string }>;
  /** Same window as `messages`; a failed run records its reason as an `error` item. */
  turnItems: Array<{ runId: string | null; type: string; ordinal: number; failure?: { message: string } }>;
  /**
   * `provider_native`: the agent's own subagents (Claude Code's Task tool), logged under its session.
   * `app_owned`: tasks delegated through T3, each running in `childThreadId`, a thread of its own.
   */
  subagents: Array<{ origin: "provider_native" | "app_owned"; childThreadId: string | null; status: string; completionDelivery?: { state: string }; updatedAt: string }>;
  /** The agent's own conversations; for Claude Code, `nativeThreadRef.nativeId` is its session id (the name of its log file). */
  providerThreads: Array<{ pendingBackgroundTasks?: unknown[]; nativeThreadRef?: { driver: string; nativeId: string } | null; updatedAt: string }>;
};

/** A PR linked to a thread, trimmed from T3's thread pull request. `snapshot` is T3's last GitHub sync of it, null until the first. */
export type T3PullRequest = {
  repository: string;
  number: number;
  url: string;
  linkedAt: string;
  snapshot: { title: string; state: "open" | "closed" | "merged"; isDraft: boolean } | null;
};

export type StartThreadInput = {
  project: Pick<T3Project, "id" | "workspaceRoot">;
  title: string;
  prompt: string;
  modelSelection: ModelSelection;
  runtimeMode: RuntimeMode;
  /** Branch the thread starts from (PR head, or the default branch). */
  baseBranch: string | null;
  /** Ask T3 to create a worktree from `origin/<baseBranch>` (T3 names its branch); otherwise run in the checkout. */
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
/** T3 answers 426 on the socket and 400 on orchestration reads without it (`packages/contracts/src/environment.ts`). */
const PROTOCOL = "2";

export type T3Shape = {
  readonly origin: string;
  /** Public descriptor; cached because the environment id never changes while the server runs. */
  readonly environment: Effect.Effect<T3Environment, T3HttpError>;
  readonly projects: () => Effect.Effect<T3Project[], T3HttpError>;
  /** Provider instances with their model lists, from `server.getConfig`. Cached briefly: the config payload is large. */
  readonly providers: () => Effect.Effect<T3Provider[], T3Error>;
  /** Runs and background work of a thread, with only its recent messages (bounded snapshot). */
  readonly thread: (threadId: string) => Effect.Effect<T3Thread, T3HttpError>;
  /** Creates the thread (and worktree, when asked), sends the prompt, links the PR. */
  readonly startThread: (input: StartThreadInput) => Effect.Effect<StartedThread, T3Error>;
  /**
   * The default branch of a project's checkout: where `origin/HEAD` points,
   * without `origin/`. T3's API does not say, so it is read with git, for
   * worktrees of items that name no branch (Linear and Sentry issues).
   */
  readonly defaultBranch: (project: Pick<T3Project, "workspaceRoot">) => Effect.Effect<string, CommandError>;
};

/** Builds the client for one origin and token. Needs an `HttpClient`, a `WebSocketConstructor` and a `ChildProcessSpawner` (for git). */
export const makeT3 = Effect.fn("T3.make")(function* (origin: string, token: string) {
  const client = yield* HttpClient.HttpClient;
  const sockets = yield* Socket.WebSocketConstructor;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const decoder = new TextDecoder();

  const request = <T>(method: "GET" | "POST", path: string, options: { authenticated?: boolean } = {}): Effect.Effect<T, T3HttpError> =>
    Effect.gen(function* () {
      const response = yield* client.execute(
        HttpClientRequest.make(method)(`${origin}${path}`).pipe(
          HttpClientRequest.setHeader("x-t3-orchestration-protocol", PROTOCOL),
          options.authenticated === false ? identity : HttpClientRequest.bearerToken(token),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        const body = yield* response.text;
        return yield* Effect.fail(new T3HttpError({ status: response.status, message: `T3 ${method} ${path} failed: ${response.status} ${body}` }));
      }
      return (yield* response.json) as T;
    }).pipe(Effect.catchTag("HttpClientError", (error) => Effect.fail(new T3HttpError({ status: 0, message: `T3 ${method} ${path} failed: ${error.message}` }))));

  /**
   * One RPC request per socket. The socket stays open until the server
   * replies: closing early would cancel the request.
   */
  const rpc = <T>(tag: string, payload: Record<string, unknown>): Effect.Effect<T, T3Error> =>
    Effect.gen(function* () {
      const { ticket } = yield* request<{ ticket: string }>("POST", "/api/auth/websocket-ticket");
      const url = new URL("/ws", origin);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("wsTicket", ticket);
      url.searchParams.set("orchestrationProtocol", PROTOCOL);
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
        // Disabled skills do not run, and `userInvocable: false` ones reject a user's pick.
        skills: (provider.skills ?? [])
          .filter((skill) => skill.enabled && skill.userInvocable !== false)
          .map((skill) => ({
            name: skill.name,
            displayName: skill.displayName ?? null,
            description: skill.shortDescription ?? skill.description ?? null,
            scope: skill.scope ?? null,
            path: skill.path,
          })),
      })),
    ),
    PROVIDERS_CACHE,
  );

  const dispatch = (command: Record<string, unknown>) => rpc<{ sequence: number }>("orchestration.dispatchCommand", command);

  /**
   * Returns once T3 accepted the launch; the worktree and setup script are
   * prepared in the background, and a failure there fails the thread's run.
   */
  const startThread = Effect.fn("t3.startThread")(function* (input: StartThreadInput) {
    const worktree = input.worktree && input.baseBranch !== null;
    yield* Effect.annotateCurrentSpan({ project: input.project.id, worktree });

    const { threadId } = yield* rpc<{ threadId: string }>("orchestration.launchThread", {
      commandId: crypto.randomUUID(),
      projectId: input.project.id,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: worktree
        ? { type: "worktree", baseRef: input.baseBranch, startFromOrigin: true }
        : { type: "root", ...(input.baseBranch ? { branch: input.baseBranch } : {}) },
      initialMessage: { text: input.prompt, attachments: [] },
    });
    yield* Effect.annotateCurrentSpan({ thread: threadId });

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
      Effect.map(request<{ projects: T3Project[] }>("GET", "/api/projects"), (snapshot) =>
        snapshot.projects.filter((project) => project.deletedAt === null),
      ),
    providers: () => providers,
    thread: (threadId) =>
      Effect.map(
        request<{ projection: T3Thread }>("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`),
        (snapshot) => snapshot.projection,
      ),
    startThread,
    defaultBranch: (project) =>
      execOk("git", ["-C", project.workspaceRoot, "symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).pipe(
        Effect.map((output) => output.stdout.trim().replace(/^origin\//, "")),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      ),
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

/**
 * A thread and, with `delegated`, the threads of the tasks it delegated
 * through T3 (`app_owned` subagents, each in a child thread), at any depth,
 * parents first. The agent's own subagents (`provider_native`) are not
 * followed: they belong to the parent's provider session. A delegated thread
 * deleted in T3 is skipped; any other failure fails the walk.
 */
export const threadTree = Effect.fn("t3.threadTree")(function* (threadId: string, delegated: boolean) {
  const t3 = yield* T3;
  const visited = new Set<string>();
  const threads: T3Thread[] = [];
  const visit = (id: string): Effect.Effect<void, T3HttpError> =>
    Effect.gen(function* () {
      if (visited.has(id)) return;
      visited.add(id);
      const thread = yield* t3.thread(id);
      threads.push(thread);
      if (!delegated) return;
      const children = thread.subagents.flatMap((task) => (task.origin === "app_owned" && task.childThreadId ? [task.childThreadId] : []));
      yield* Effect.forEach(children, (child) => visit(child).pipe(Effect.catchIf((error) => error.status === 404, () => Effect.void)), { discard: true });
    });
  yield* visit(threadId);
  return threads;
});
