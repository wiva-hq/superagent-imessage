# Contributing

Bug reports, ideas and pull requests are welcome.

## Pull requests

Open them against `main`. Keep each one to one change, and run the checks first:

```sh
pnpm install && pnpm check
cd bridge && pnpm install && pnpm check
```

This repository is published from a private one, where the history is kept, so a pull request is not merged here.
Once it is accepted, a maintainer applies its changes there with you as the commit's author; the next public commit
names you as a co-author and lists your pull request, and the pull request is closed with a link to it.

Changes to the iMessage Source and `imsg-bridge` belong here. Changes to the rest of dsh-superagent are better sent to
[DeepSeek's prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) first, so this fork stays close to it.

## Tests and examples

Use example data: phone numbers in `+1555…`, emails at `example.com` or `example.org`, and made-up chat names. Never
put a real handle, chat id, token or Photon project secret in code, tests or an issue.

## Security

Report a vulnerability privately through **Security → Report a vulnerability** on this repository, not in an issue.
