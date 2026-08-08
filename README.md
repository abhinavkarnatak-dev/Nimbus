# Nimbus

Nimbus is a cloud coding agent. An authenticated user connects a GitHub App installation, selects
one public repository, describes a small coding task, and watches Nimbus work inside an isolated
cloud sandbox. Nimbus opens a pull request for human review.

**Nimbus never merges pull requests, never force-pushes, and never writes to a repository's default
branch.** The sandbox that runs model-proposed commands holds no credentials of any kind; every
write to GitHub happens in the trusted backend after deterministic validation.

> **Status: under construction.** The build follows a fixed feature-by-feature order. Sections
> marked _(not yet implemented)_ describe planned behavior and are not available yet.

## Prerequisites

| Tool           | Version           | Notes                                        |
| -------------- | ----------------- | -------------------------------------------- |
| Node.js        | >= 22.12          | Developed on 22.16                           |
| pnpm           | >= 10.12          | `corepack enable` or `npm i -g pnpm`         |
| Docker Desktop | >= 28 (Compose 2) | For MongoDB, Redis, and optional Qdrant      |
| Git            | >= 2.40           | Required for the trusted patch/push pipeline |

## Quick start

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

## Workspace layout

```text
apps/
  api/                 Trusted backend: auth, GitHub gateway, agent orchestration, WebSockets
  web/                 Browser client: auth, repository selection, live session view
packages/
  contracts/           Zod schemas and inferred types shared across every boundary
  config/              Shared TypeScript configuration
  test-utils/          Fixtures, fake adapters, and test harnesses
docs/                  Architecture, security, threat model, deployment, operations
scripts/               Developer and operational scripts
```

### TypeScript project layout

Each Node package carries two TypeScript configurations:

- `tsconfig.json` is the default project. It type-checks sources **and** tests and emits nothing.
  The editor, ESLint's type-aware rules, and `pnpm typecheck` all use it.
- `tsconfig.build.json` is the composite emit project. Sources only, so test files never reach
  `dist/`.

`apps/web` has no build project because Vite produces the browser bundle; it is type-checked in
place.

## Environment configuration

Copy `.env.example` to `.env` and fill it in. `.env` is git-ignored and must never be committed.

Generate strong secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Every variable is listed in `.env.example`. _(Validation and fail-fast startup arrive in feature
004; nothing reads these values yet.)_

## Local services _(not yet implemented)_

`pnpm dev:services` will start MongoDB, Redis, and optional Qdrant through Docker Compose, bound to
loopback only.

## Local fake-adapter mode _(not yet implemented)_

Nimbus is designed to run its entire browser journey, from OTP login through GitHub connection,
agent work, approvals, checks, and a pull request, against fake adapters that need no paid
credentials.

## External service setup _(not yet implemented)_

Google OAuth, the GitHub App, E2B, Groq, Gemini, SMTP, and optional Qdrant each require
configuration before the corresponding real adapter can be used. Exact steps, GitHub App
permissions, callback URLs, and webhook events will be documented as those features land.

## Architecture and trust boundaries

The design is organized around one question: where can a credential exist?

| Zone | Contents                                | Holds credentials          |
| ---- | --------------------------------------- | -------------------------- |
| Z0   | User's browser                          | Opaque session cookie only |
| Z1   | Nimbus API, orchestrator, gateways      | Yes, all of them           |
| Z2   | MongoDB, Redis, optional Qdrant         | Reached only from Z1       |
| Z3   | Sandbox                                 | No, never                  |
| Z4   | GitHub, Groq, Gemini, SMTP              | Reached only from Z1       |
| Z5   | Repository content and user attachments | Untrusted data             |

The sandbox runs commands proposed by a language model against source code written by strangers, so
it is treated as hostile. It receives no GitHub token, no database URI, no model provider key, and
no session secret. It can only ever hand back a patch, which the trusted backend validates before
that patch becomes a branch.

Two consequences follow, and they are the load-bearing parts of the design:

- **Only deterministic code authorizes an effect.** A model can propose any action. Policy is
  application code that runs before execution, and no string produced by a model or a repository
  reaches it as an instruction.
- **Every write to GitHub happens in Z1.** The backend re-verifies ownership, base commit, paths,
  protected files, size limits, and secret scanning, then mints a repository-scoped token just in
  time and discards it afterward.

The full design is in [`docs/architecture.md`](./docs/architecture.md), the control catalogue in
[`docs/security.md`](./docs/security.md), and the adversary analysis, protected paths, and accepted
residual risks in [`docs/threat-model.md`](./docs/threat-model.md).

## Data sent to model providers _(not yet implemented)_

Nimbus will document precisely which repository snippets and images are sent to which provider, and
guarantees that secrets, environment values, and tokens are never included.

## Deployment _(not yet implemented)_

Nimbus runs long-lived WebSockets and durable workers. A host that sleeps or terminates workers is
unsuitable without an external durable worker; this will be documented rather than worked around
with keep-awake pings.

## Known limitations

- V1 supports one repository per session, public repositories only, and one active session per
  user.
- Semantic retrieval is optional and off by default behind `ENABLE_SEMANTIC_SEARCH`.
- The build is in progress. Many sections above describe planned rather than delivered behavior.
