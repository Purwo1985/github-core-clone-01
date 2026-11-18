# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Purwo1985/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Purwo1985/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node 22 process (standard library only, no git binary, no outside service): git smart HTTP (upload-pack protocol v2 and receive-pack v0, fast-forward only), REST v3 (repositories, contents, labels, issues, pull requests with squash merge), GraphQL (the documents the GitHub CLI and github-mcp-server send, plus introspection), and an MCP server (JSON-RPC 2.0 Streamable HTTP) with six tools — all served from an in-memory store.

## Run it

```sh
MAKEFUN_ENV_URL=http://localhost:8080 node --experimental-strip-types main.ts
```

Requires Node 22. `MAKEFUN_ENV_URL` is the trial environment the entry registers with; the entry binds an ephemeral port, registers it, answers `/healthz`, and exits when the environment reports the trial is done.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
