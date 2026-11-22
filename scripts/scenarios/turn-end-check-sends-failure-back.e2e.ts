import { expect } from "e2e";

import { test, WEB } from "./t3.ts";

test(
  "A failing turn-end check sends its output back to the agent, then passes",
  WEB,
  async ({ t3, app, screen }) => {
    const project = await t3.project("demo", {}, [
      {
        id: "check",
        name: "Check",
        // Fails once, so the agent gets one fix turn and the check passes after it.
        command:
          "test -f .check-ok || { touch .check-ok; echo 'app.ts:3 lint: unused variable'; exit 1; }",
        icon: "test",
        runOnWorktreeCreate: false,
        runOnTurnEnd: true,
      },
    ]);
    const thread = await t3.thread({ project, title: "Done gate", messages: ["Start"] });
    await t3.open(thread);

    await expect(screen.getByText("Check failed")).toBeVisible();
    await expect(screen.getByText(/^Check passed in \d+s\.$/)).toBeVisible();
    await app.screenshot("after-fix-turn");
  },
);
