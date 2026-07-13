# skill-switch Plugin Guide

## Boundary

This directory owns the OpenClaw skill-switch host plugin, skill selection
commands, session skill state, and video-to-prompt gateway RPC handlers.

It does not own video-to-prompt runtime internals except through stable process,
file, and RPC contracts.

## Start Here

- `README.md` for plugin behavior.
- `docs/architecture/codemap.md` for local code navigation.
- `docs/adr/README.md` for plugin-owned decisions.
- `docs/features/README.md` for feature-specific docs.
- `docs/features/skill-switch-plugin/README.md` for skill selection, prompt injection, and `arkclawSkillSelect.*`.
- `docs/features/cua-command/README.md` for `/cua` command behavior.
- `docs/features/observability/README.md` for logs, state files, and troubleshooting.
- `package.json` for scripts.
- `src/` for implementation.
- `src/video-to-prompt/README.md` for gateway-specific notes.
- `docs/features/video-to-prompt/specs/` for public protocol docs.
- `runtime/agents/video-to-prompt/scripts/` for pack/install/test scripts.

## Common Commands

```bash
npm install
npm run build
npm run typecheck
npm test
```

For video-to-prompt protocol changes, pair this validation with
`runtime/agents/video-to-prompt` build/typecheck/test and consider the spec
test script.

## Change Notes

- Gateway and CLI errors must use the strict error envelope.
- Keep RPC schemas and docs aligned.
- Prompt injection policy is configured under `config.injection.lowPrioritySkills`
  (default `["XUA-auto"]`). Low-priority skills are available skill entries,
  not exclusive overrides; missing skills must degrade to no skill injection.
- CI is not the authority for local unit-test validity; run the relevant local
  command before handing off changes.
- Security boundary changes need negative tests for invalid inputs, path
  traversal, symlink, illegal env, timeout, and execution rejection cases when
  applicable.
- If a gateway file reaches five or more RPCs, follow the register-chain split
  rule in root `AGENTS.md`.

## References

- Root rules: `AGENTS.md`
- Testing guide: `docs/TESTING.md`
- Testing matrix: `docs/testing-matrix.md`
- Cross-project error envelope pattern: `docs/experience/patterns/error-envelope.md`
- Repo map: `docs/architecture/repo-map.md`
- Local codemap: `plugins/skill-switch/docs/architecture/codemap.md`
- Local experience: `plugins/skill-switch/docs/experience/`
