# StartDown fork of T3 Code

`startdownhq/t3code` is our fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code) (MIT). Upstream does
not take feature PRs from outside its team (see `CONTRIBUTING.md`), so harness features we want live here.

## Keeping up with upstream

- Remotes: `origin` = startdownhq/t3code, `upstream` = pingdotgg/t3code.
- Upstream ships several times a day. Sync at least weekly: `git fetch upstream && git merge upstream/main`, then
  `vp run check:changed`, then push. Merge, never rebase or force-push `main`: other engineers build on it.
- Keep our changes small and in their own files where possible, so merges stay cheap. Every fork-only change gets a
  line in the change log below.
- GitHub Actions: no workflow has run on the fork yet. If Actions get enabled, turn on `ci.yml` only; the release,
  deploy-relay, mobile-eas and publish-aur workflows publish upstream's products and must stay off.
- Bug fixes that are not StartDown-specific go upstream as an issue first (their rules), not as a fork patch.

## Where it runs

| Machine    | Today                                             | Target     |
| ---------- | ------------------------------------------------- | ---------- |
| Mac Mini   | upstream release 0.1.7 (`~/.t3/runtime/versions`) | fork build |
| jiv-server | fork build 0.1.12-startdown.1 (2026-11-22), `t3code.service` | fork build |

Both still run upstream binaries. Switching a machine to a fork build is a separate, tested step.

## Deploying a fork build (Linux)

1. Pick a version above upstream's latest stable, with our tag: `0.1.12-startdown.N`. It must not match
   `-(nightly|preview).YYYYMMDD.N`, or T3 treats it as another release track.
2. Build: `ssh jiblars@192.168.193.182 'bash -s -- <version>' < scripts/startdown/build-linux-runtime.sh`
   (about 25 minutes; ends with the upstream smoke test).
3. Switch, with the service stopped: back up `~/.t3/userdata`, the unit file and
   `~/.t3/runtime/service-state.json`; unpack the archive's folder to `~/.t3/runtime/versions/<version>`;
   write `<version>` (no newline) to `.install-complete` in it; set `activeVersion` in service-state.json;
   point the unit's `ExecStart` at the new `t3`; `systemctl --user daemon-reload`; start.
4. Check: `serverVersion` in `~/.t3/userdata/server-runtime.json`, then a real turn with
   `t3 thread start <dir> "Reply with exactly: ok" --provider claudeAgent --model <model> --wait --json`.

Traps:
- A distro Node (CachyOS `/usr/bin/node`) builds an executable that links system libraries; build in the
  container. `build-cli-archive.ts` also needs `dpkg-query` and `libatomic1`, which the container has.
- Without `.install-complete` the launcher refuses the runtime ("missing or incomplete").
- On start the server deletes runtimes it no longer uses, including the one you switched from. Keep the
  previous release archive in the backup folder (download it from the pingdotgg/t3code release).
- "Update everything" in any T3 client connected to the server installs upstream's release over ours.

## Roadmap (from Anthropic and SpaceX AI engineering guidance)

Ranked by value against what T3 Code already has (plan mode, worktrees, delegation, scheduled tasks and context
handoffs exist upstream).

1. **Done gate.** A `t3.json` script flag (say `runOnTurnEnd: true`) that runs the project's checks when an agent
   turn ends. On a non-zero exit the output goes back to the agent as the next turn, with a retry cap; the thread
   shows the command and its output as evidence. Upstream's nearest flag, `runOnSettle`, only runs cleanup when a
   thread settles (often days later) and never reports back to the agent. Sources: Claude Code best practices (give Claude a check it can
   run); Boris Cherny (verification loop = 2-3x quality); Lauren Tan (every correction becomes a check).
2. **Fresh-reviewer action.** One button sends the thread's diff and its stated goal to a read-only agent that never
   saw the conversation; findings come back into the thread. Sources: Claude Code best practices; Anthropic
   "Harness design for long-running application development" (separate evaluator).
3. **Long-run template.** Scaffold `feature_list.json` (all failing), `progress.md` and `init.sh`; each session
   starts by reading them and runs one feature to green. Source: Anthropic "Effective harnesses for long-running
   agents".
4. **Correction to rule.** When the user corrects an agent, offer to save it as a lint rule, hook or deny rule
   instead of prose. Track revert rate per project. Source: Lauren Tan, "All Code Is Slop (Except Mine)".
5. **Unattended-run checklist.** Before a thread runs without the user: a done-when, a check, a scope (worktree)
   and a turn or spend cap. Sources: Claude Code best practices; Anthropic "Building effective agents".

### Sources

- Claude Code best practices, https://code.claude.com/docs/en/best-practices (read 2026-11-22)
- Effective harnesses for long-running agents, Anthropic, 2025-11-26,
  https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- Harness design for long-running application development, Anthropic, 2026-03-24,
  https://www.anthropic.com/engineering/harness-design-long-running-apps
- Effective context engineering for AI agents, Anthropic, 2025-09-29,
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- Demystifying evals for AI agents, Anthropic, 2026-01-09,
  https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Boris Cherny workflow thread, 2026-01-02, via InfoQ:
  https://www.infoq.com/news/2026/01/claude-code-creator-workflow
- Lauren Tan (SpaceX AI, Grok Bot), AI Engineer CODE talk, 2026-11, via
  https://www.teamday.ai/ai/lauren-tan-spacexsi-grok-bot-11000-agent-prs-lint-rules (second-hand summary; the
  video itself was not read, and her PR counts differ between sources)

No official SpaceX tutorial on Claude was found; Tan's talk is the closest primary match and is model-agnostic.

## Fork change log

- 2026-11-22: forked; added this file.
- 2026-11-22: done gate (`runOnTurnEnd` project script, `DoneGateService`), merged in PR #1.
- 2026-11-22: jiv-server runs fork build 0.1.12-startdown.1; build script `scripts/startdown/build-linux-runtime.sh`.
