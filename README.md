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

`pnpm test` runs the unit project and needs nothing else running. Integration tests talk to a real
MongoDB, so they are a separate project:

```bash
pnpm dev:services      # start MongoDB and Redis first
pnpm test:integration
pnpm test:all          # both projects
```

Each integration test file creates a randomly named database and drops it afterwards, so your local
`nimbus` database is never touched.

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

Every variable is listed in `.env.example`.

Settings are read in exactly one place, `apps/api/src/config`. No other module reads `process.env`.
The whole environment is validated once at startup, and the process refuses to start if anything is
missing or malformed. Error messages name the setting and the reason but never print the value, so a
bad connection string cannot leak its password into a log.

Google, GitHub, SMTP, E2B, and the model providers may all be left blank in development, which is
what makes the local fake-adapter mode possible. In production they are required, and startup fails
if they are absent.

Node reads the `.env` file natively, so no extra library is involved:

```bash
node --env-file=.env apps/api/dist/index.js
```

## Local services

Docker Compose runs MongoDB and Redis locally. Qdrant is optional and only starts when asked for,
since semantic search is off by default.

```bash
pnpm dev:services            # start MongoDB and Redis, wait until genuinely ready
pnpm dev:services:semantic   # the same, plus Qdrant
pnpm dev:services:status     # what is running and whether it is healthy
pnpm dev:services:logs       # follow the logs
pnpm dev:services:down       # stop and remove containers, keep the data
pnpm dev:services:reset      # stop and also delete the data volumes
```

`pnpm dev:services` uses `--wait`, so it only returns once every health check passes. When it
finishes, the databases genuinely accept connections rather than merely having been started.

| Service | Version | Address                            |
| ------- | ------- | ---------------------------------- |
| MongoDB | 8.0.28  | `127.0.0.1:27017`                  |
| Redis   | 8.10.0  | `127.0.0.1:6379`                   |
| Qdrant  | 1.19.0  | `127.0.0.1:6333` HTTP, `6334` gRPC |

Every port is published to `127.0.0.1` only, never to `0.0.0.0`. The plain form `"27017:27017"`
binds every network interface, which would put a passwordless database on whatever network you are
connected to, and Docker opens the firewall for published ports. Neither database uses
authentication locally, so the loopback binding is the protection.

`pnpm dev:services:reset` deletes your local data on purpose. It is a separate command rather than a
flag so it cannot be run by accident.

## Data model

Five collections, defined in `apps/api/src/db/models`, each owning its own document type, MongoDB
`$jsonSchema` validator, indexes, and the mappers that convert a stored record into a wire response.

| Collection             | Holds                              | Constraint the database enforces                                   |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| `users`                | Accounts                           | Unique normalized email; unique public id                          |
| `github_installations` | Connected GitHub App installations | Unique GitHub installation id                                      |
| `sessions`             | One coding task each               | One active session per user; unique idempotency key per user       |
| `repo_indexes`         | Retrieval indexes                  | Unique per repository, commit, policy version, and embedding model |
| `audit_events`         | Security relevant history          | Append only, expiring, secrets redacted before storage             |

Two properties are enforced by the database rather than by application code, because a check followed
by a write has a gap that concurrent requests fall through:

- **One account per email.** Unique index on the normalized address, and the validator refuses an
  address containing uppercase so an unnormalized write cannot create a second account.
- **One active session per user.** A partial unique index on `userId`, applied only to non-terminal
  statuses. Finished sessions are unlimited. Proven by concurrent inserts in the integration suite.

MongoDB object IDs never leave the backend. Every record carries a non-guessable prefixed public id
such as `usr_V1StGXR8Z5jdHi6BmyT`, and outbound mappers are revalidated against the strict contract
schemas so an accidental spread cannot leak `_id`.

`ensureDatabaseSchema` applies validators and indexes and is idempotent, so it runs safely on every
start.

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
