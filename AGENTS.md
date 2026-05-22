## Project Introduction

`ai-commit` is a Bun-based TypeScript CLI repository for AI-assisted commits.

# Information

- Run commands from the repo root.
- The package manager used is `bun`.
- Primary runtime targets are `bun` for scripts and `node >= 24` for the built CLI.
- Avoid `index.ts` barrel files;

## Structure

- `.ai-commit/`: project-specific support files
- `src/`: main source files
- `tests/`: automated tests
- `docs/`: project documentation

## Working Loop

1. Identify the target area.
2. Follow local patterns in that directory.
3. Run focused checks/tests for the target.

## TypeScript Preflight Rule

- Before any TypeScript planning, multi-file edit, refactor, or architecture question, load the `architecture-preflight` skill first. Re-run it after substantial changes to verify alignment.
- Trigger on: definitions, types, signatures, exports, services, layers, schemas, wiring, module boundaries, or broad source reading.
- Posture: inspect declarations/signatures first, then narrow to implementation files only as needed.

## Quick Commands

```bash
bun run check
bun run build
bun run test
bun run generate:schemas
```

# Learning from reference repositories

- Check local project support material first when you need examples, prior art, or implementation guidance.
- Prefer repository documentation and nearby source patterns over browsing generated build output or digging through `node_modules/`, unless you specifically need implementation-level confirmation.

## Engineering Principles

- **Proactive Progress**: Don't wait for instructions. Identify blockers, propose solutions, and push work forward autonomously.
- **Robust & Scalable**: Prefer solutions that work reliably and can grow. Avoid fragile hacks that break under load.
- **Globally Optimal**: Consider the whole system, not just the immediate fix. Trade-offs should be conscious and documented.
- **Verify Reality**: Test assumptions. A working demo beats a perfect plan.
- **Ship & Iterate**: Perfect is the enemy of done. Get to working state, then improve.
