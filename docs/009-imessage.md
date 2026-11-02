# 009 iMessage

This document adds iMessage as a Source and a Mac as the place the agent runs and deploys to. It builds on [001 Domain model](001-domain.md), [002 Authorization](002-authorization.md), [006 Deployment](006-deployment.md) and the recipe in [008 Cookbook](008-cookbook.md), which the iMessage Source follows step by step.

## What runs where

| Part | Where | What it does |
| --- | --- | --- |
| `dsh-superagent` with `dsh-superagent/imessage-watch` | The agent's Mac, in the DeepSeek Harness profile | Polls `imsg-bridge pull`, turns messages into Triggers, replies through `imsg-bridge reply` |
| `imsg-bridge` (`bridge/`) | The same host, as the same user | In local mode, reads `~/Library/Messages/chat.db` and sends through Messages.app with Photon's [imessage-kit](https://github.com/photon-hq/imessage-kit). In cloud mode, reads the journal that `imsg-bridge serve` keeps from [Photon Spectrum](https://github.com/photon-hq/spectrum-ts). In advanced mode, calls Photon's [Advanced iMessage](https://github.com/photon-hq/advanced-imessage-ts) server over gRPC. In photon mode, calls Photon's [v2 API](https://photon.codes/docs/beta/photon.md) over HTTPS |
| CI (`.github/workflows/ci.yml`) | GitHub-hosted Ubuntu runners | The bundle's `pnpm check` and the bridge's `pnpm check` on every push and pull request |
| CD (`.github/workflows/deploy.yml`) | A self-hosted runner on that host, labelled `imsg-agent`: a Mac in local mode, any OS in the other modes | Deploys each commit of `main` that passed CI with `scripts/deploy-mac.sh` |

## Four modes

`imsg-bridge` reaches iMessage in one of four ways, chosen by `IMSG_BRIDGE_MODE`. The Source cannot tell them apart: each answers the same commands with the same JSON.

| | `local` (default) | `cloud` | `advanced` | `photon` |
| --- | --- | --- | --- | --- |
| iMessage line | The agent's own Apple ID, signed in to Messages | A line Photon allocates to your Spectrum project | A line on Photon's Advanced iMessage server, shared or dedicated | A line in your Photon v2 project, shared or dedicated |
| Host | A Mac that stays logged in | Any host with Node 22.18 or later, Linux included | Any host with Node 22.18 or later, Linux included | Any host with Node 22.18 or later, Linux included |
| Runs | Only the short commands | `imsg-bridge serve` beside the service, plus the short commands | Only the short commands; the server holds the line | Only the short commands; Photon holds the line |
| History for assessments | All of `chat.db` | What `serve` has seen since it started, kept 30 days (`IMSG_BRIDGE_KEEP_DAYS`) | The server's history and event log, including messages that arrived while the service was down | Photon's stored messages, including those that arrived while the service was down |
| Starting a conversation | Anyone the Apple ID can message | On a shared line, only someone who texted the line first (the bridge answers 410 otherwise) | Anyone the line can message, within Photon's limits for new contacts | On a shared line, only someone who texted the line first (410 otherwise); on a dedicated line, anyone |
| Cost and limits | None beyond Apple's | Photon's plan; the free tier caps messages per day | Photon's plan and its sending limits | Photon's plan |

In local mode the agent needs its own Apple ID signed in to Messages on that Mac. In cloud mode it needs a Spectrum project from [app.photon.codes](https://app.photon.codes). In advanced mode it needs the address of an Advanced iMessage server and a token it accepts, both from Photon. In photon mode it needs a Photon v2 project with an iMessage line, from [app.beta.photon.codes](https://app.beta.photon.codes), and a project API key. In every mode, people text the agent's line; its own messages are the agent's, and the Source never makes a Trigger of them.

## The mapping

| Concept | For iMessage |
| --- | --- |
| Trigger | One message, by its `guid`: `imessage:<guid>` |
| Thread | One chat. iMessage has no topics, so a follow-up in the same chat ("add the Safari test too") reaches the Ticket the chat already follows |
| Actor | The sender's handle: an E.164 phone number (`+15550102000`) or an Apple ID email in lower case |
| Addressed | Every direct message is `direct`; a group message is a `mention` when it contains one of the wake words (default `@agent`) |
| Channel address | The chat id, the message replied to, and `direct` for a direct chat |
| Receiving scope | Each listed group chat is a row; `other` holds unlisted groups; `direct` holds direct messages |

Direct messages are off by default because anyone can text an Apple ID. Turn them on in Sources settings after the allowed list under **Eval → On each Source → iMessage** names the people who may originate work.

## The bridge contract

`imsg-bridge` prints JSON on stdout. A failure prints `{"error":{"code","message"}}` on stderr and exits 1, which `Commands` reads as a `CliError` with that code.

| Command | Answer |
| --- | --- |
| `pull --json [--after <cursor>]` | `{"items": [...], "next": "<cursor>"}`, oldest first. Without `--after` it answers no items and a cursor at the newest row, so turning the Source on never replays the account's history |
| `reply --chat <id> --key <key> --text <text>` | `{"status": "sent"}`, once per key; `410` when the chat is not on the account |
| `thread --chat <id> --limit <n> --json [--before <time>]` | A page of the chat, oldest first, and `next` for the older page |
| `chats --json` | The account's chats for the settings form's chat picker |

An item has `id`, `rowId`, `chatId`, `chatKind` (`dm`, `group` or `unknown`), `chatName` for named groups, `sender` (empty on the agent's own messages), `fromMe`, `bot` (Focus auto-replies and system rows), `text`, `at` and `replyTo`.

The cursor is the last row taken and its time. Each pull looks five minutes behind that time for rows that land in `chat.db` late, takes only rows after the cursor's row, and stops before a row whose chat is not yet joined, so the next pull takes it. Tapbacks, membership changes and retracted messages move the cursor without becoming items.

In cloud mode, `imsg-bridge serve` holds the Spectrum connection: it appends every message it sees, people's and the agent's own, to `~/.imsg-bridge/journal.jsonl`, numbered by `rowId`, and reconnects with a backoff from 1 to 60 seconds when the stream drops. `pull`, `thread` and `chats` read that journal, so they work while `serve` reconnects. `reply` posts to `serve` on `127.0.0.1` (`IMSG_BRIDGE_PORT`, default 8790) with the token `serve` writes to `~/.imsg-bridge/serve.json`, readable only by its user; while `serve` is down, `reply` answers 503 and the Outbox retries. Spectrum's telemetry is off. A message that arrives while `serve` is down is not in the journal: Spectrum does not replay a stream, so keep `serve` running as a service.

Neither Messages.app nor Spectrum has an idempotency key, so the bridge keeps one: `~/.imsg-bridge/ledger.json` (or `$IMSG_BRIDGE_HOME`) records a key as pending before the send and as sent after it. A key left pending by a crash counts as sent when the chat (in cloud mode, the journal) already holds the agent's message with the same text, and is sent again otherwise. The Outbox's retries therefore post a reply at most once in the usual case and never lose it.

In advanced mode the server does this itself. `reply` turns the key into the send's `clientMessageId`, and the server answers a repeated one as a duplicate, which the bridge reports as `duplicate: true`, so no ledger is kept. `pull` reads the server's durable event log: its cursor is the last event sequence taken, so messages that arrive while the service is down come on the next pull. A first pull without a cursor reads the log to its head once, without answering any items, so turning the Source on never replays the line's history.

In photon mode, Photon does the same. `reply` sends with the key as the request's `idempotency-key`; Photon answers a repeated one with the message it already took and `Idempotent-Replayed: true`, reported as `duplicate: true`. `pull` lists the project's iMessage messages created since its cursor's time, looking five minutes further back because Photon's listing is eventually consistent; the cursor also carries the ids it took in that window, so nothing is answered twice. A first pull without a cursor starts at the present. Replies go out as the line's agent user, found by `GET /users`; `PHOTON_IMESSAGE_LINE` picks the line when the project has several. `thread` reads a dedicated line's chat by its resource; a shared line has no resource of the project's, so it reads the chat from the agent's perspective, which takes no time bounds, and applies `before` itself over the newest five pages.

## Install on the Mac

1. Sign the agent's Apple ID in to Messages, and send it one message from your phone to check it receives.
2. Give Full Disk Access to the terminal or service that runs DeepSeek Harness (System Settings → Privacy & Security → Full Disk Access), so the bridge can read `chat.db`. The first send asks for permission to control Messages; allow it.
3. Install as in [006 Deployment](006-deployment.md), then the bridge:

   ```sh
   (cd bridge && pnpm install --frozen-lockfile)
   bridge/bin/imsg-bridge chats --json   # lists the account's chats when the permissions are right
   ```

4. Make the bridge reachable from the service: set `IMSG_BRIDGE_CLI` to the absolute path of `bridge/bin/imsg-bridge` in the environment `scripts/dsh-superagent` starts DeepSeek Harness with, or link it onto its `PATH`.
5. Enable the plugin in the profile's `cordis.patch.yml`:

   ```yaml
   - id: dsh-superagent-imessage
     disabled: false
   ```

6. Restart. In **Settings → Sources → iMessage**, choose the group chats, the wake words and whether direct messages are received; under **Eval → On each Source → iMessage**, list the people who may originate work by phone number or email.

## Install in cloud mode

1. Create a Spectrum project at [app.photon.codes](https://app.photon.codes) and copy its project ID and secret.
2. Install as in [006 Deployment](006-deployment.md), then `(cd bridge && pnpm install --frozen-lockfile)`.
3. Run `serve` as a service under the same user as DeepSeek Harness (a launchd agent, a systemd user unit or a tmux window), with the credentials in its environment:

   ```sh
   IMSG_BRIDGE_MODE=cloud PHOTON_PROJECT_ID=… PHOTON_PROJECT_SECRET=… bridge/bin/imsg-bridge serve
   ```

4. Give the service `IMSG_BRIDGE_MODE=cloud` and `IMSG_BRIDGE_CLI` (the absolute path of `bridge/bin/imsg-bridge`), so its calls read the same journal. The credentials stay with `serve` only.
5. Text the line from your phone, then check that `IMSG_BRIDGE_MODE=cloud bridge/bin/imsg-bridge chats --json` lists the chat. Continue with steps 5 and 6 of the local install.

## Install in advanced mode

1. Get the address of an Advanced iMessage server and a token it accepts from Photon, and the line's number.
2. Install as in [006 Deployment](006-deployment.md), then `(cd bridge && pnpm install --frozen-lockfile)`.
3. Write `IMSG_BRIDGE_MODE=advanced`, `PHOTON_IMESSAGE_ADDRESS` and `PHOTON_IMESSAGE_TOKEN` to `~/.imsg-bridge/bridge.env` (see [Credentials](#credentials)), and give the service `IMSG_BRIDGE_CLI` (the absolute path of `bridge/bin/imsg-bridge`). Set `PHOTON_IMESSAGE_TLS=false` only for a server on the same machine during development.
4. Text the line from your phone, then check that `bridge/bin/imsg-bridge chats --json` lists the chat. Continue with steps 5 and 6 of the local install.

## Install in photon mode

1. In a Photon v2 project at [app.beta.photon.codes](https://app.beta.photon.codes), add an iMessage line and create a project API key (`pho_sk_…`). Note the project id (`pho_prj_…`).
2. Install as in [006 Deployment](006-deployment.md), then `(cd bridge && pnpm install --frozen-lockfile)`.
3. Write `IMSG_BRIDGE_MODE=photon`, `PHOTON_PROJECT_ID`, `PHOTON_API_KEY` and, when the project has more than one line, `PHOTON_IMESSAGE_LINE` (the line's number) to `~/.imsg-bridge/bridge.env` (see [Credentials](#credentials)), and give the service `IMSG_BRIDGE_CLI` (the absolute path of `bridge/bin/imsg-bridge`).
4. Text the line from your phone, then check that `bridge/bin/imsg-bridge chats --json` lists the chat. Continue with steps 5 and 6 of the local install.

## Credentials

DeepSeek Harness strips variables whose names contain KEY, SECRET, TOKEN or PASSWORD from the commands it runs, the bridge included, so a Photon key in the service's environment never reaches it. The bridge reads such variables from `~/.imsg-bridge/bridge.env` (`$IMSG_BRIDGE_HOME/bridge.env`) instead: `NAME=value` lines, `#` comments allowed, and a variable set in the environment wins. The file must be readable by its user only; the bridge refuses it otherwise. Write it without the secret reaching your shell history:

```sh
mkdir -p ~/.imsg-bridge && read -s "key?Photon API key: " && echo &&
  printf 'IMSG_BRIDGE_MODE=photon\nPHOTON_PROJECT_ID=pho_prj_…\nPHOTON_API_KEY=%s\n' "$key" > ~/.imsg-bridge/bridge.env &&
  chmod 600 ~/.imsg-bridge/bridge.env && unset key
```

## The deploy runner

1. Register a self-hosted runner on the host for this repository only, under the user that runs the service, with the label `imsg-agent` (GitHub → Settings → Actions → Runners → New self-hosted runner). Run it as a launch agent so it survives a logout.
2. Set the repository variables `DEPLOY_DIR` (the checkout the service runs from, not the runner's work directory) and `STATE_DIR` (the bundle's `stateDir`); optionally `DEPLOY_NOTIFY_CHAT`, an iMessage chat id that hears about each deploy, and `DSH_SUPERAGENT_PROFILE`.
3. Create the `production` environment. Add a required reviewer if each deploy should wait for a person.

Automatic deploys ship turned off: uncomment the `workflow_run` trigger in `.github/workflows/deploy.yml` once the runner is registered, or run the workflow by hand. With the trigger on, each successful CI run of a push to `main` deploys that commit: back up `orchestrator.sqlite`, check out, install, build, `scripts/dsh-superagent restart`. Exit 0 is a deploy. Exit 2 or 3 keeps the new commit and fails the job, because a person must act. Exit 1 stops the service, checks out the previous commit, restores the backup (a database migrated by the new version cannot be opened by the old one) and starts it again.

Keep the repository private while the runner is attached, or make sure no workflow other than `deploy.yml` targets the `imsg-agent` label: a self-hosted runner executes the code it is given as the operator's user, with that user's Messages account.

## Limits

- Replies are plain text: the Channel flattens Markdown, and native polls, Tapbacks and rich links are not sent. A person answers a question by replying in words.
- Local mode needs macOS and a logged-in user session; Messages does not run headless. The other modes remove that need but depend on Photon's service and its plan's limits.
- In cloud mode, assessments read only the history `serve` has journaled. In the other modes, inbound attachments are not read.
- A chat's Thread spans the whole chat, so two Tickets started in one chat share it. Eval and the Executors tell them apart as they do on any shared Thread.
