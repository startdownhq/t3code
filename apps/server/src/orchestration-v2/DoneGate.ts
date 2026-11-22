import { MessageId, type OrchestrationV2Run, type RunId, type ThreadId } from "@t3tools/contracts";

/** Fix turns the gate sends in a row before it stops and leaves the failure to the user. */
export const DONE_GATE_MAX_FIX_TURNS = 3;
/** Output lines sent back to the agent. */
export const DONE_GATE_TAIL_LINES = 60;

const FIX_MESSAGE_PREFIX = "done-gate:";

export const doneGateFixMessageId = (threadId: ThreadId, runId: RunId) =>
  MessageId.make(`${FIX_MESSAGE_PREFIX}${threadId}:${runId}`);

/**
 * Fix turns the gate already sent back to back, ending at `runId`. Undefined when
 * `runId` is no longer the thread's latest run, or when it was not an agent turn
 * the gate should check (an idle `/compact`).
 */
export function doneGateFixTurnsBefore(
  runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "startedAt" | "userMessageId">
  >,
  runId: RunId,
): number | undefined {
  const ordered = runs
    // A run cancelled before it started never ran; one the user stopped still moved the thread on.
    .filter((run) => run.status !== "cancelled" || run.startedAt !== null)
    .toSorted((left, right) => right.ordinal - left.ordinal);
  const latest = ordered[0];
  if (latest?.id !== runId || latest.status !== "completed") return undefined;
  if (latest.userMessageId.startsWith("idle-compact:")) return undefined;
  let count = 0;
  for (const run of ordered) {
    if (!run.userMessageId.startsWith(FIX_MESSAGE_PREFIX)) break;
    count++;
  }
  return count;
}

export function doneGateFixText(input: {
  readonly name: string;
  readonly command: string;
  readonly exitCode: number;
  readonly tail: ReadonlyArray<string>;
  readonly attempt: number;
}): string {
  const output = input.tail.length === 0 ? "(no output)" : input.tail.join("\n");
  return [
    `The project check "${input.name}" (\`${input.command}\`) failed with exit code ${input.exitCode} after your last turn.`,
    `Fix the cause, then end your turn; the check runs again (fix ${input.attempt} of ${DONE_GATE_MAX_FIX_TURNS}).`,
    "",
    "Last output:",
    "```",
    output,
    "```",
  ].join("\n");
}
