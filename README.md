# ai-commit

`ai-commit` is the TypeScript / Effect port of the original Go-based
`git-agent`, built with an Effect CLI structure and supporting both Git and
Jujutsu (`jj`) repositories.

## Demo

![CLI demo](./docs/sceen-recording.gif)

## Acknowledgements

Credit goes to the original author of the Go implementation at
[`GitAgentHQ/git-agent-cli`](https://github.com/GitAgentHQ/git-agent-cli).
This project is an independent TypeScript / Effect re-port of that work. It is
not affiliated with, maintained by, or endorsed by GitAgentHQ.

## Install

```bash
npx @effect-x/ai-commit --help
```

```bash
DESCRIPTION
  AI-first Git/JJ CLI for atomic commits and generated messages.

USAGE
  ai-commit <subcommand> [flags]

GLOBAL FLAGS
  --help, -h              Show help information
  --version               Show version information
  --completions choice    Print shell completion script
  --log-level choice      Sets the minimum log level

SUBCOMMANDS
  commit     Generate and create commit(s) with AI-generated messages.
  config     Manage ai-commit configuration.
  init       Initialize ai-commit in the current repository.
  version    Print the ai-commit version.
```

## Goals

- keep `init`, `commit`, `config`, and `version`
- re-port orchestration from the original Go services into Effect services
- support both `git` and `jj`
- keep OpenAI-compatible provider support

## Development

```bash
bun install
bun run check
```

## Commands

```bash
ai-commit version
ai-commit config show --cwd .
ai-commit init --scope --gitignore
ai-commit commit --intent "split auth fix"
```
