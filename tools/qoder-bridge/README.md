# Qoder Auto usage bridge

Optional local bridge that teaches [Token Monitor](https://github.com/Javis603/token-monitor) to account for Qoder's **Auto** turns, which newer Qoder builds commit without a `message.usage` object.

This folder is tooling, not part of the Electron app runtime. Nothing here runs unless `npm run install-bridge` is invoked explicitly.

## What it fixes

Qoder Auto transcripts contain assistant content, `requestTokenAnchor` and `responseGroupId`, but no token counters. A parser that requires `message.usage` therefore drops every completed Auto turn and leaves only the live turn; DAY looks empty, the session has no cache hit, and its credits are missing.

The bridge now:

- estimates output from content blocks and keeps synthetic assistant notes out;
- reconstructs prompt context from the transcript and anchors it to Qoder's own `chat_session_context_usage` snapshot and `compactUsage` objects;
- estimates the prompt-cache read from the previous context within the cache window;
- reads exact per-turn billing from `chat_session_messages.turn_credits` in Qoder's `main.sqlite` and distributes it over the turn's requests;
- falls back to a conservative token/credit estimate for a turn Qoder has not billed yet, and marks it as estimated;
- marks estimated sessions in Token Monitor's session strip and spend card, so an estimate never looks like a measured counter.

## Install

Requirements: Token Monitor 0.93.x installed, Node.js 22 (for `node:sqlite`), and a Windows Qoder installation.

```powershell
cd tools/qoder-bridge
npm install
npm run install-bridge
```

Close Token Monitor before installing. The installer extracts the pristine `app.asar` backup, applies the bridge patches, repacks atomically, copies the bridge into the tokscale loader, and leaves the original archive in `resources/qoder-bridge-backup`. Start Token Monitor afterwards; enable Qoder under Settings → tools if it is not ticked.

## Verify

```powershell
npm test
```

The tests cover output estimation, context calibration, cache splitting, exact-vs-estimated credit precedence, and graph merging.

## Data and privacy

Usage is read from `%USERPROFILE%\.qoder\projects\**\*.jsonl` and Qoder's local SQLite databases (`chat_session_messages`, `chat_session_context_usage`, `chat_model_preferences`). The bridge does not read cookies or tokens for usage accounting. Credits are converted to USD using the plan Qoder reports in its own quota snapshot.

## Limits

Auto mode still does not expose per-request token counters. Input, cache and output are estimates; cost is exact only when Qoder has written `turn_credits` for that turn. The UI marks both cases explicitly. Uncommitted turns can change slightly as context grows.
