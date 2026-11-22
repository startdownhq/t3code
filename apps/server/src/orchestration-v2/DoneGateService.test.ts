import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationProjectShell,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  DONE_GATE_MAX_FIX_TURNS,
  doneGateFixMessageId,
  doneGateFixTurnsBefore,
} from "./DoneGate.ts";
import * as DoneGateService from "./DoneGateService.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const NOW = "2026-11-22T12:00:00.000Z";
const at = () => DateTime.makeUnsafe(NOW);
const threadId = ThreadId.make("gate-thread");
const projectId = ProjectId.make("project");
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = { instanceId, model: "claude-opus-5-5" };
const gateScript = {
  id: "check",
  name: "Check",
  command: "vp run check:changed",
  icon: "test",
  runOnWorktreeCreate: false,
  runOnTurnEnd: true,
} as const;

const thread: OrchestrationV2ThreadProjection["thread"] = {
  id: threadId,
  projectId,
  title: "Gate thread",
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: instanceId,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/workspace/worktree",
  activeProviderThreadId: null,
  lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdAt: at(),
  updatedAt: at(),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: at(),
  deletedAt: null,
};

function run(
  ordinal: number,
  messageId: string,
  status: OrchestrationV2Run["status"] = "completed",
) {
  return {
    id: RunId.make(`run-${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId: instanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(messageId),
    rootNodeId: NodeId.make(`node-${ordinal}`),
    activeAttemptId: null,
    status,
    requestedAt: at(),
    startedAt: at(),
    completedAt: at(),
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

const forkLineage = {
  rootThreadId: ThreadId.make("parent"),
  parentThreadId: ThreadId.make("parent"),
  relationshipToParent: "fork",
} as const;

const fixRun = (ordinal: number) =>
  run(ordinal, doneGateFixMessageId(threadId, RunId.make(`run-${ordinal - 1}`)));

describe("doneGateFixTurnsBefore", () => {
  it.each([
    { name: "a user turn", runs: [run(1, "message-1")], expected: 0 },
    { name: "one fix turn", runs: [run(1, "message-1"), fixRun(2)], expected: 1 },
    {
      name: "fix turns since the last user turn only",
      runs: [fixRun(1), run(2, "message-2"), fixRun(3), fixRun(4)],
      expected: 2,
    },
    {
      name: "a run cancelled before it started",
      runs: [run(1, "message-1"), { ...run(2, "message-2", "cancelled"), startedAt: null }],
      expected: 0,
      checked: "run-1",
    },
    {
      name: "a newer run the user stopped",
      runs: [run(1, "message-1"), run(2, "message-2", "cancelled")],
      expected: undefined,
      checked: "run-1",
    },
    {
      name: "a newer queued run",
      runs: [run(1, "message-1"), { ...run(2, "message-2", "queued"), startedAt: null }],
      expected: undefined,
      checked: "run-1",
    },
    {
      name: "an idle compaction",
      runs: [run(1, "idle-compact:gate-thread:run-0")],
      expected: undefined,
    },
  ])("counts $name", ({ runs, expected, checked }) => {
    const checkedRun = RunId.make(checked ?? runs.at(-1)!.id);
    expect(doneGateFixTurnsBefore(runs, checkedRun)).toBe(expected);
  });
});

interface Scenario {
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly thread?: Partial<OrchestrationV2ThreadProjection["thread"]>;
  readonly scripts?: OrchestrationProjectShell["scripts"];
  /** Runs after the check, when the gate rereads the thread. */
  readonly runsAfterCheck?: ReadonlyArray<OrchestrationV2Run>;
  readonly exitCode?: number | null | "never";
  readonly output?: ReadonlyArray<string>;
  /** After the first check ends, the run completes again, then another thread's run completes. */
  readonly repeatAfterCheck?: boolean;
  /** The parent thread's checkout, when the checked thread has one. */
  readonly parentWorktreePath?: string | null;
}

const runGate = (scenario: Scenario) =>
  Effect.gen(function* () {
    const checked = scenario.runs.at(-1)!;
    const dispatched: OrchestrationV2ServerCommand[] = [];
    const written: OrchestrationV2DomainEvent[] = [];
    const scriptRuns: ProjectSetupScriptRunner.ProjectSetupScriptRunnerInput[] = [];
    let reads = 0;
    const firstCheckDone = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const checkStarted = yield* Deferred.make<void>();
    const expectedChecks = scenario.repeatAfterCheck === true ? 2 : 1;
    let checksEnded = 0;
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name !== "DoneGateService.check") return;
          checksEnded++;
          Deferred.doneUnsafe(firstCheckDone, Effect.void);
          if (checksEnded === expectedChecks) Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    const project: OrchestrationProjectShell = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/workspace/project",
      defaultModelSelection: null,
      scripts: scenario.scripts ?? [gateScript],
      createdAt: NOW,
      updatedAt: NOW,
    };
    const exitCode = scenario.exitCode === undefined ? 0 : scenario.exitCode;
    const completed = (id: ThreadId) => ({
      id: EventId.make(`gate-completed-${id}`),
      type: "run.updated" as const,
      threadId: id,
      runId: checked.id,
      occurredAt: at(),
      payload: { ...checked, threadId: id },
    });
    const dependencies = Layer.mergeAll(
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.make(completed(threadId)).pipe(
          Stream.concat(
            scenario.repeatAfterCheck === true
              ? Stream.fromEffect(Deferred.await(firstCheckDone)).pipe(
                  Stream.flatMap(() =>
                    Stream.make(completed(threadId), completed(ThreadId.make("other-thread"))),
                  ),
                )
              : Stream.empty,
          ),
        ),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getThread: (id) =>
          Effect.succeed(
            id === threadId
              ? { ...thread, ...scenario.thread }
              : id === ThreadId.make("parent")
                ? { ...thread, id, worktreePath: scenario.parentWorktreePath ?? null }
                : { ...thread, id },
          ),
        getThreadRecords: (() =>
          Effect.sync(() => ({
            runs: reads++ === 0 ? scenario.runs : (scenario.runsAfterCheck ?? scenario.runs),
          }))) as never,
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        getShell: () => Effect.succeedSome(project),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      }),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.sync(() => {
            scriptRuns.push(input);
            const onOutputLine = input.observeCompletion?.onOutputLine;
            return {
              status: "started",
              scriptId: gateScript.id,
              scriptName: gateScript.name,
              scriptCommand: gateScript.command,
              terminalId: "turn-end-check-1",
              cwd: input.worktreePath,
              async: true,
              completion:
                exitCode === "never"
                  ? Deferred.succeed(checkStarted, undefined).pipe(Effect.andThen(Effect.never))
                  : Effect.forEach(
                      scenario.output ?? [],
                      (line) => onOutputLine?.(line) ?? Effect.void,
                    ).pipe(Effect.as({ exitCode, durationMs: 4_200 })),
            } as const;
          }),
      }),
      Layer.mock(EventSink.EventSinkV2)({
        write: (input) =>
          Effect.sync(() => {
            written.push(...input.events);
            return [];
          }),
      }),
      IdAllocator.layer,
    );
    const fiber = yield* Effect.gen(function* () {
      const service = yield* DoneGateService.make;
      yield* service.start();
      yield* Deferred.await(done);
    }).pipe(Effect.provide(dependencies), Effect.withTracer(tracer), Effect.forkChild);
    if (exitCode === "never") {
      yield* Deferred.await(checkStarted);
      yield* TestClock.adjust(Duration.minutes(16));
    }
    yield* Fiber.join(fiber);
    const notices = written.flatMap((event) =>
      event.type === "turn-item.updated" && event.payload.type === "system_notice"
        ? [
            {
              title: event.payload.title,
              level: event.payload.level,
              message: event.payload.message,
            },
          ]
        : [],
    );
    return { dispatched, notices, scriptRuns };
  });

describe("DoneGateService", () => {
  it.effect("sends a failing check back to the agent with its output", () =>
    Effect.gen(function* () {
      const result = yield* runGate({
        runs: [run(1, "message-1")],
        exitCode: 1,
        output: ["src/a.ts(3,1): error TS2304: Cannot find name 'x'."],
      });
      expect(result.scriptRuns).toMatchObject([
        { trigger: "turn-end", worktreePath: "/workspace/worktree", projectId },
      ]);
      expect(result.notices).toEqual([]);
      expect(result.dispatched).toHaveLength(1);
      const command = result.dispatched[0]!;
      expect(command).toMatchObject({
        type: "message.dispatch",
        commandId: `server:done-gate:${threadId}:run-1`,
        messageId: doneGateFixMessageId(threadId, RunId.make("run-1")),
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        notification: {
          source: { kind: "system" },
          outcome: "failed",
          summary: "Check failed",
          detail: "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
        },
      });
      expect(command.type === "message.dispatch" ? command.text : "").toContain(
        "failed with exit code 1",
      );
    }),
  );

  it.effect("leaves a notice when the check passes", () =>
    Effect.gen(function* () {
      const result = yield* runGate({ runs: [run(1, "message-1")], exitCode: 0 });
      expect(result.dispatched).toEqual([]);
      expect(result.notices).toEqual([
        { title: "Checks passed", level: "info", message: "Check passed in 4s." },
      ]);
    }),
  );

  it.effect("stops sending fix turns at the cap", () =>
    Effect.gen(function* () {
      const runs = [
        run(1, "message-1"),
        ...Array.from({ length: DONE_GATE_MAX_FIX_TURNS }, (_, index) => fixRun(index + 2)),
      ];
      const result = yield* runGate({ runs, exitCode: 2 });
      expect(result.dispatched).toEqual([]);
      expect(result.notices).toMatchObject([{ title: "Checks still failing", level: "warning" }]);
    }),
  );

  it.effect("runs a main-checkout thread's check in the project root", () =>
    Effect.gen(function* () {
      const result = yield* runGate({
        runs: [run(1, "message-1")],
        thread: { worktreePath: null },
      });
      expect(result.scriptRuns).toMatchObject([{ worktreePath: "/workspace/project" }]);
    }),
  );

  it.effect("checks a run once even when it completes again later", () =>
    Effect.gen(function* () {
      const result = yield* runGate({ runs: [run(1, "message-1")], repeatAfterCheck: true });
      expect(result.scriptRuns.map((input) => input.threadId)).toEqual([
        threadId,
        ThreadId.make("other-thread"),
      ]);
    }),
  );

  it.effect("checks a fork in its own worktree", () =>
    Effect.gen(function* () {
      const result = yield* runGate({
        runs: [run(1, "message-1")],
        thread: { lineage: { ...forkLineage } },
        parentWorktreePath: "/workspace/parent",
      });
      expect(result.scriptRuns).toMatchObject([{ worktreePath: "/workspace/worktree" }]);
    }),
  );

  it.effect("drops the result when the user moved on during the check", () =>
    Effect.gen(function* () {
      const result = yield* runGate({
        runs: [run(1, "message-1")],
        runsAfterCheck: [
          run(1, "message-1"),
          { ...run(2, "message-2", "running"), completedAt: null },
        ],
        exitCode: 1,
      });
      expect(result.dispatched).toEqual([]);
      expect(result.notices).toEqual([]);
    }),
  );

  it.effect("reports a check that never finishes", () =>
    Effect.gen(function* () {
      const result = yield* runGate({ runs: [run(1, "message-1")], exitCode: "never" });
      expect(result.dispatched).toEqual([]);
      expect(result.notices).toMatchObject([{ title: "Check timed out", level: "warning" }]);
    }),
  );

  it.effect("reports a check whose terminal exits before its exit code", () =>
    Effect.gen(function* () {
      const result = yield* runGate({ runs: [run(1, "message-1")], exitCode: null });
      expect(result.dispatched).toEqual([]);
      expect(result.notices).toMatchObject([{ title: "Check did not finish", level: "warning" }]);
    }),
  );

  it.effect.each([
    { name: "no turn-end script", scripts: [{ ...gateScript, runOnTurnEnd: false }] },
    { name: "an archived thread", thread: { archivedAt: at() } },
    { name: "a side chat", thread: { lineage: { ...forkLineage, sideChat: true } } },
    {
      name: "a fork sharing its parent's checkout",
      thread: { lineage: forkLineage },
      parentWorktreePath: "/workspace/worktree",
    },
    {
      name: "a provider-native subagent",
      thread: {
        creationSource: "provider",
        lineage: {
          rootThreadId: ThreadId.make("parent"),
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      },
    },
  ] as const)("skips $name", (scenario) =>
    Effect.gen(function* () {
      const result = yield* runGate({ runs: [run(1, "message-1")], exitCode: 1, ...scenario });
      expect(result.scriptRuns).toEqual([]);
      expect(result.dispatched).toEqual([]);
    }),
  );
});
