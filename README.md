# git-agent-cli

Effect v4 rewrite of `git-agent`, using an Effect CLI structure and supporting
both Git and Jujutsu (`jj`) repositories.

## Goals

- keep `init`, `commit`, `config`, and `version`
- port orchestration from Go services to Effect services
- support both `git` and `jj`
- keep OpenAI-compatible provider support

## Development

```bash
bun install
bun run check
```

## Commands

```bash
git-agent version
git-agent config show --cwd .
git-agent init --scope --gitignore
git-agent commit --intent "split auth fix"
```
