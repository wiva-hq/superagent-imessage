<p align="center">
  <img src="design/brand/superagent-imessage-mark.svg" width="72" height="72" alt="superagent-imessage">
</p>

<h1 align="center">superagent-imessage</h1>

<p align="center">
  <b>Text in iMessage to control your repository.</b><br>
  <sub>Ask a coding agent for work in iMessage; it answers in the same chat, with a pull request.</sub>
</p>

<p align="center">
  <a href="https://github.com/deepseek-ai/dsh-superagent-prototype"><img alt="Built on: dsh-superagent" src="https://img.shields.io/badge/built%20on-dsh--superagent-4d6bfe?style=flat-square"></a>
  <a href="https://photon.codes/spectrum"><img alt="iMessage: Photon" src="https://img.shields.io/badge/iMessage-Photon-34c759?style=flat-square"></a>
  <img alt="Hosts: macOS and Linux" src="https://img.shields.io/badge/hosts-macOS%20·%20Linux-52525b?style=flat-square">
  <img alt="Status: experimental" src="https://img.shields.io/badge/status-0.1.0%20experimental-f59e0b?style=flat-square">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-2563eb?style=flat-square"></a>
</p>

<p align="center">
  <a href="SETUP.md"><b>Setup</b></a> &nbsp;·&nbsp;
  <a href="docs/009-imessage.md">iMessage</a> &nbsp;·&nbsp;
  <a href="docs/000-philosophy.md">Philosophy</a> &nbsp;·&nbsp;
  <a href="https://github.com/wiva-hq/superagent-imessage/issues/new">Report an issue</a>
</p>

> **Experimental.** A Wiva experiment, not an official DeepSeek project and not affiliated with DeepSeek. It builds on a research prototype whose DeepSeek Harness dependencies are alpha releases. The iMessage code was written with Claude Code and reviewed by the Wiva team. Review it before you run it.

---

## Why superagent-imessage

<table>
  <tr>
    <td width="33%" valign="top"><b>💬 Text, don't tab</b><br><sub>A direct message, or <code>@agent</code> in a group chat. Follow-ups in the same chat reach the same work.</sub></td>
    <td width="33%" valign="top"><b>🙋 AI proposes; people choose</b><br><sub>The agent answers with a pull request for a person to review. Work nobody asked for starts in a mode that only records it.</sub></td>
    <td width="33%" valign="top"><b>🔒 Only who you allow</b><br><sub>Anyone can text an Apple ID, so direct messages start off and only listed phone numbers and emails may ask for work.</sub></td>
  </tr>
  <tr>
    <td valign="top"><b>💻 Mac or no Mac</b><br><sub>Your own Apple ID in Messages on a Mac, or a Photon Spectrum line on any Linux host.</sub></td>
    <td valign="top"><b>✉️ One reply, never two</b><br><sub>The bridge keeps a ledger, so retries post a reply at most once and never lose it.</sub></td>
    <td valign="top"><b>🔁 Deploys itself</b><br><sub>A deploy script backs up the database, restarts, and rolls back when the new version won't start.</sub></td>
  </tr>
</table>

## Built on

This repository adds about a thousand lines. Everything that makes it an agent comes from two open-source projects, both MIT:

| | What it gives this project | Without it |
|---|---|---|
| **[dsh-superagent](https://github.com/deepseek-ai/dsh-superagent-prototype)** by DeepSeek, on **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)** | The whole agent: Sources, the Policy that decides who may ask, Tickets, worker sessions that write code and open pull requests, the Outbox that retries replies, the web panel, the prompts and the guided setup. iMessage plugs in as one more Source, next to GitHub and Feishu. | An agent runtime, authorization and execution to build from scratch |
| **[imessage-kit](https://github.com/photon-hq/imessage-kit)** by Photon | Reads `chat.db` and sends through Messages.app on a Mac, with typed messages and chats | Parsing Apple's private database and scripting Messages by hand |
| **[Spectrum](https://photon.codes/spectrum)** by Photon | An iMessage line in the cloud, so the agent runs on Linux with no Mac to keep logged in | No way to run iMessage off a Mac |

## How it works

```mermaid
flowchart LR
  Y["You · iMessage"] --> L
  subgraph host["Your Mac, or a Linux host"]
    L["imsg-bridge"] --> S["iMessage Source"] --> A["dsh-superagent<br>Policy · Ticket · Worker"]
    A -- "reply" --> L
  end
  L <-. "cloud mode" .-> P["Photon Spectrum"]
  A -- "pull request" --> G["GitHub"]
```

**`imsg-bridge`** reads and sends iMessage: on a Mac through Messages, or anywhere through a Spectrum line that
`imsg-bridge serve` keeps open. The **iMessage Source** turns each message into a Trigger; **dsh-superagent** checks it
against the allowed list, opens a Ticket, works on it in its own session, and replies in the chat.

## Get started

**1 · Set up dsh-superagent** with your coding agent: ask it to *read SETUP.md in this repository and set up
dsh-superagent with me*. It asks one question at a time, then installs and configures everything.

**2 · Install the bridge** and choose a mode ([details](docs/009-imessage.md)):

```sh
(cd bridge && pnpm install --frozen-lockfile)
bridge/bin/imsg-bridge chats --json                                   # local: lists your Mac's chats
IMSG_BRIDGE_MODE=cloud PHOTON_PROJECT_ID=… PHOTON_PROJECT_SECRET=… \
  bridge/bin/imsg-bridge serve                                        # cloud: keeps the Spectrum line open
```

**3 · Turn on the Source.** Enable `dsh-superagent-imessage` in the profile, then in **Settings → Sources → iMessage**
pick the chats, and under **Eval → On each Source → iMessage** list who may ask.

Every build is on [Releases](https://github.com/wiva-hq/superagent-imessage/releases).

## Security, in short

The agent acts only for the people you list, direct messages start off, and it answers with pull requests, not
merges. It runs as your user with your Messages account, so keep the host to yourself, and keep any self-hosted
deploy runner on a private repository. In cloud mode, messages pass through Photon. Read
[002 Authorization](docs/002-authorization.md) and the deploy notes in [009 iMessage](docs/009-imessage.md).

## Documentation

Read the numbered documents in order; each builds only on the ones before it.

[000 Philosophy](docs/000-philosophy.md) · [001 Domain model](docs/001-domain.md) · [002 Authorization](docs/002-authorization.md) ·
[003 Execution](docs/003-execution.md) · [004 Prompts](docs/004-prompts.md) · [005 Panel](docs/005-panel.md) ·
[006 Deployment](docs/006-deployment.md) · [007 Architecture](docs/007-architecture.md) · [008 Cookbook](docs/008-cookbook.md) ·
[009 iMessage](docs/009-imessage.md)

## Development

```sh
pnpm install && pnpm check             # the bundle: typecheck, tests, build
cd bridge && pnpm install && pnpm check  # imsg-bridge: typecheck, tests
```

| | |
|---|---|
| [`src/sources/imessage*.ts`](src/sources) | The iMessage Source, built by the recipe in [008 Cookbook](docs/008-cookbook.md) |
| [`bridge/`](bridge) | `imsg-bridge`: local mode with imessage-kit, cloud mode with Spectrum |
| [`src/`](src) | dsh-superagent from DeepSeek: Sources, Policy, Tickets, execution, the panel |
| [`prompts/`](prompts) | The agent's prompts |
| [`scripts/`](scripts) | `dsh-superagent` (start, stop, status) and `deploy-mac.sh` |

Bug reports, ideas and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for how a pull request
lands, with you credited as a co-author.

---

<p align="center"><sub>
  <a href="LICENSE">MIT License</a> · made by <a href="https://wiva.io"><img src="design/brand/superagent-imessage-mark.svg" width="11" height="11" alt=""> <b>Wiva, Inc.</b></a> · built on <a href="https://github.com/deepseek-ai/dsh-superagent-prototype">dsh-superagent</a> by DeepSeek and iMessage SDKs by <a href="https://photon.codes">Photon</a>
</sub></p>
