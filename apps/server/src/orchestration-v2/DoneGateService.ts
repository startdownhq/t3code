import {
  CommandId,
  isProviderNativeSubagentThread,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { resolveProjectScripts, turnEndProjectScript } from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  DONE_GATE_MAX_FIX_TURNS,
  DONE_GATE_TAIL_LINES,
  doneGateFixMessageId,
  doneGateFixText,
  doneGateFixTurnsBefore,
} from "./DoneGate.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";

const CHECK_TIMEOUT = Duration.minutes(15);

/**
 * When an agent turn completes, runs the project's `runOnTurnEnd` script in the
 * thread's checkout. A failure goes back to the agent as a new turn, up to
 * `DONE_GATE_MAX_FIX_TURNS` in a row; a pass or a stop leaves a notice on the run.
 */
export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projectScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const eventSink = yield* EventSink.EventSinkV2;
  const ids = yield* IdAllocator.IdAllocatorV2;

  const notice = Effect.fn("DoneGateService.notice")(function* (
    threadId: ThreadId,
    runId: RunId,
    level: "info" | "warning",
    title: string,
    message: string,
  ) {
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "turn-item.updated",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: ids.derive.runSignalTurnItem({ runId, signal: "done-gate" }),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            // EventSink allocates the real position, after the run's existing items.
            ordinal: 0,
            status: "completed",
            title,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "system_notice",
            level,
            message,
          },
        },
      ],
    });
  });

  const latestFixTurns = (threadId: ThreadId, runId: RunId) =>
    projections
      // Headroom for runs cancelled before they started, which the count skips.
      .getThreadRecords(threadId, ["runs"], { latestRunLimit: DONE_GATE_MAX_FIX_TURNS * 3 })
      .pipe(Effect.map((records) => doneGateFixTurnsBefore(records.runs, runId)));

  const check = Effect.fn("DoneGateService.check")(
    function* (threadId: ThreadId, runId: RunId) {
      const thread = yield* projections.getThread(threadId);
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        isProviderNativeSubagentThread(thread)
      )
        return;
      const project = Option.getOrUndefined(yield* projectStore.getShell(thread.projectId));
      if (project === undefined) return;
      const scripts = resolveProjectScripts(yield* settings.getSettings, project);
      if (turnEndProjectScript(scripts) === null) return;
      const cwd = thread.worktreePath ?? project.workspaceRoot;
      // A side chat answers questions; its parent owns the checkout and the fixes.
      if (thread.lineage.sideChat === true) return;
      // The parent checks its own checkout; a fork or child sharing it would edit under the parent.
      if (thread.lineage.parentThreadId !== null) {
        const parent = yield* projections
          .getThread(thread.lineage.parentThreadId)
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          );
        if (parent !== null && (parent.worktreePath ?? project.workspaceRoot) === cwd) return;
      }
      const fixTurns = yield* latestFixTurns(threadId, runId);
      if (fixTurns === undefined) return;

      const tail: string[] = [];
      const run = yield* projectScripts.runForThread({
        threadId,
        projectId: project.id,
        worktreePath: cwd,
        trigger: "turn-end",
        project: { id: project.id, workspaceRoot: project.workspaceRoot, scripts },
        observeCompletion: {
          onOutputLine: (line) =>
            Effect.sync(() => {
              tail.push(line);
              if (tail.length > DONE_GATE_TAIL_LINES) tail.shift();
            }),
        },
      });
      if (run.status !== "started" || run.completion === undefined) return;
      const completion = yield* run.completion.pipe(Effect.timeoutOption(CHECK_TIMEOUT));
      // The user may have sent a message while the check ran; their turn gets its own check.
      if ((yield* latestFixTurns(threadId, runId)) === undefined) return;

      if (Option.isNone(completion)) {
        return yield* notice(
          threadId,
          runId,
          "warning",
          "Check timed out",
          `${run.scriptName} was still running after ${Duration.format(CHECK_TIMEOUT)}. Its terminal stays open.`,
        );
      }
      const { exitCode, durationMs } = completion.value;
      if (exitCode === null) {
        return yield* notice(
          threadId,
          runId,
          "warning",
          "Check did not finish",
          `${run.scriptName} stopped before reporting an exit code.`,
        );
      }
      if (exitCode === 0) {
        return yield* notice(
          threadId,
          runId,
          "info",
          "Checks passed",
          `${run.scriptName} passed in ${Math.max(1, Math.round(durationMs / 1000))}s.`,
        );
      }
      if (fixTurns >= DONE_GATE_MAX_FIX_TURNS) {
        return yield* notice(
          threadId,
          runId,
          "warning",
          "Checks still failing",
          `${run.scriptName} failed with exit code ${exitCode} after ${fixTurns} fix turns, so T3 stopped sending them. Its terminal shows the output.`,
        );
      }
      const output = tail.join("\n");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        // One fix turn per checked run, even across duplicate events.
        commandId: CommandId.make(`server:done-gate:${threadId}:${runId}`),
        messageId: doneGateFixMessageId(threadId, runId),
        threadId,
        text: doneGateFixText({
          name: run.scriptName,
          command: run.scriptCommand,
          exitCode,
          tail,
          attempt: fixTurns + 1,
        }),
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        notification: {
          source: { kind: "system" },
          outcome: "failed",
          summary: `${run.scriptName} failed`,
          ...(output.length === 0 ? {} : { detail: output }),
        },
        dispatchMode: { type: "queue_after_active" },
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("done gate skipped", { threadId, cause: Cause.pretty(cause) }),
        ),
      ),
  );

  const start = Effect.fn("DoneGateService.start")(function* () {
    // Keyed by thread: a newer completed run replaces a check still running for an older one.
    const checks = yield* FiberMap.make<ThreadId>();
    // The last run checked per thread. Completed runs are re-emitted (delegated completions),
    // and none of those may run the script again.
    const checked = new Map<ThreadId, RunId>();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) => {
        if (event.type !== "run.updated" || event.payload.status !== "completed")
          return Effect.void;
        const { threadId } = event;
        const runId = event.payload.id;
        if (checked.get(threadId) === runId) return Effect.void;
        checked.set(threadId, runId);
        return FiberMap.run(checks, threadId, check(threadId, runId));
      }),
    );
  });
  return { start };
});
