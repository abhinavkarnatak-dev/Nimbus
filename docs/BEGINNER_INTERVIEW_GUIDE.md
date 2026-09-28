# Nimbus: Beginner-to-Interview Guide

This guide explains the Nimbus codebase as it exists in the current working tree. It is meant for a developer who has just started learning web development, backend systems, GitHub Apps, and AI agents.

> Important accuracy note: the root `README.md` still says the product is under construction, and the working tree currently contains uncommitted reliability and UI work. Treat this guide as a map of the code that is present now, not as a promise that every production deployment is already configured and working.

## 1. The shortest correct explanation

Nimbus is a cloud coding agent.

A user signs in, connects a GitHub App, chooses a public repository, adds their own Gemini API key, and asks for a small coding change. Nimbus creates an isolated E2B sandbox, copies an exact GitHub commit into it, lets an AI model inspect and edit that copy through a small set of controlled tools, runs checks, exports a patch, validates the patch again in the trusted backend, creates a new GitHub commit and feature branch, and opens a pull request for the user to review.

Nimbus does **not** merge the pull request. It does **not** give GitHub credentials to the sandbox. It does **not** let the model directly call GitHub or freely run arbitrary shell commands.

The core idea is:

```text
AI proposes an action
        |
trusted backend validates it
        |
isolated sandbox performs allowed local work
        |
trusted backend validates the final patch
        |
trusted backend alone writes to GitHub
```

That separation is the most important design decision in the project.

## 2. What problem Nimbus solves

Normal coding assistants often run on a developer's laptop and inherit whatever the developer can access. That is convenient, but it creates risk: the agent may see local secrets, use broad Git credentials, run an unsafe command, or modify the wrong branch.

Nimbus chooses a more controlled cloud workflow:

1. The user grants access to a specific public repository through a GitHub App.
2. Nimbus pins one exact commit, so the starting code cannot silently change halfway through a run.
3. Untrusted code runs in a disposable sandbox with no credentials and no unrestricted internet.
4. The model can only request tools that Nimbus has registered.
5. Normal edits happen only inside the disposable copy.
6. A deterministic backend validates the final diff.
7. A separate trusted GitHub gateway creates the commit, branch, and pull request.
8. A human still reviews and merges.

Nimbus is therefore not just "send a prompt to Gemini." It is a complete workflow around a model: authentication, authorization, repository selection, isolation, tool execution, validation, event streaming, durability, and GitHub delivery.

## 3. Three terms beginners often mix up

### Model

The model is Gemini. It reads a prompt and returns structured text describing one next action, such as `read_file`, `search_code`, or `apply_patch`. It does not receive a real terminal or GitHub token.

### Agent

The agent is the backend control loop around the model. It builds prompts, asks the model for one action, validates the response, runs the chosen tool, records the result, and asks the model what to do next. In Nimbus this flow is represented as a LangGraph graph.

### Sandbox

The sandbox is an isolated machine used as a disposable workspace. It stores the copied repository files and runs approved local commands. It does not decide what to do. It does not hold the model logic, MongoDB access, Redis access, or GitHub credentials.

An easy analogy is:

- Model = the engineer suggesting the next move.
- Agent/backend = the supervisor checking and coordinating every move.
- Sandbox = the locked workshop where the move is performed.
- GitHub gateway = the authorized courier that delivers a checked result.

## 4. Repository layout

```text
v1/
|-- apps/
|   |-- web/                 React browser application
|   `-- api/                 Express API, worker, agent, GitHub and sandbox logic
|-- packages/
|   |-- contracts/           Shared Zod schemas and TypeScript types
|   |-- config/              Shared TypeScript configuration
|   `-- test-utils/          Test fixtures and database helpers
|-- docs/                    Architecture, security, threat model, this guide
|-- docker-compose.yml       Local MongoDB, Redis, MinIO and optional Qdrant
|-- docker-compose.prod.yml  Example production container shape
|-- package.json             Workspace scripts and common tool versions
`-- pnpm-workspace.yaml      pnpm monorepo package list
```

The browser and server share `packages/contracts`. This is important: both sides validate the same request, response, event, status, and tool shapes instead of maintaining two handwritten definitions that can drift.

## 5. Technology stack and why it exists

| Layer                    | Technology                                                      | What it does here                                                             | Why this choice                                                                            | Main tradeoff / alternative                                                                                                                            |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Language                 | TypeScript, strict mode                                         | Implements browser, API, agent and shared contracts                           | One language across the stack; strong editor and compile-time checks                       | Types do not validate network data at runtime; that is why Zod is also used. Python would have a larger AI ecosystem but weaker shared browser typing. |
| Monorepo                 | pnpm workspaces                                                 | Links web, API and contracts with one lockfile                                | Fast installs and strict dependency boundaries                                             | Adds workspace/config complexity. npm workspaces, Yarn, Nx or Turborepo are alternatives.                                                              |
| Browser                  | React 19 + Vite                                                 | Sign-in, GitHub setup, dashboard, live session UI                             | Small modern client and fast development build                                             | There is no full framework router or server rendering. Next.js is an alternative but unnecessary for this app's authenticated dashboard.               |
| API                      | Node.js 22 + Express 5                                          | HTTP routes, cookies, GitHub callbacks, uploads, worker wiring                | Direct and understandable middleware model                                                 | Express gives fewer conventions than NestJS/Fastify. The project must create its own structure.                                                        |
| Validation               | Zod                                                             | Validates all boundary payloads and derives TypeScript types                  | Runtime validation and static types come from one source                                   | Schemas add code and parsing cost, but prevent silent client/server drift.                                                                             |
| Agent graph              | LangGraph                                                       | Defines clone, scope, retrieve, reason, execute, review and complete nodes    | Makes states and transitions explicit                                                      | More concepts than a `while` loop. A custom loop would be simpler initially but harder to checkpoint, inspect, and extend.                             |
| LLM                      | Google Gemini, user-owned key                                   | Scope checks, next-action decisions, titles and image descriptions            | Structured output, long context, vision, and no server-wide model bill                     | Currently one provider creates vendor dependence. The provider seam exists so another provider can be added.                                           |
| Durable database         | MongoDB 8                                                       | Users, installations, sessions, events, provider keys, attachments and audits | Session/agent state is naturally document-shaped; useful atomic updates and indexes        | Relational joins and migrations are less explicit than PostgreSQL. PostgreSQL + JSONB is a strong alternative.                                         |
| Short-lived coordination | Redis 8                                                         | Login state, rate limits, idempotency, leases, cancellation and Pub/Sub       | Expiry and atomic Lua operations fit these jobs                                            | Another infrastructure service must be operated. Mongo alone would make leases and precise TTL behavior harder.                                        |
| Sandbox                  | E2B                                                             | Remote isolated workspace and command execution                               | Managed disposable environments behind a provider interface                                | External cost and dependency. Containers, Firecracker or Kubernetes jobs give more control but much more operational work.                             |
| GitHub integration       | GitHub App + Octokit                                            | Narrow repository access, commit/branch creation and PR creation              | Installation tokens can be short-lived and restricted to one repository and permission set | More setup and callback complexity than asking users for a personal access token, but much safer and easier to revoke.                                 |
| Live updates             | native `ws` WebSockets + Redis Pub/Sub + Mongo outbox           | Sends ordered progress to the browser and replays missed events               | Low-latency updates plus recovery after reconnects                                         | More complex than polling. Server-Sent Events are simpler for one-way updates but still need replay and authenticated long-lived connections.          |
| Object storage           | S3-compatible storage, MinIO locally                            | Stores uploaded attachment bytes                                              | Keeps large binary data out of MongoDB                                                     | Adds another service. Small text-only V1 could store bytes in Mongo, but it scales poorly.                                                             |
| Logs                     | Pino                                                            | Structured, redacted server logs                                              | Fast JSON logs that are easy to search                                                     | Less friendly raw output without a pretty-printer.                                                                                                     |
| Tests                    | Vitest and Supertest; Playwright is planned but not fully wired | Unit, integration and HTTP route testing                                      | Fast TypeScript-native test workflow                                                       | Real browser end-to-end testing still needs configuration and CI coverage.                                                                             |
| Optional retrieval       | Qdrant                                                          | Planned/feature-flagged semantic vector search                                | Can find conceptually related code                                                         | Indexing adds latency, memory and stale-index risk. V1 deliberately uses deterministic lexical retrieval first.                                        |

Nimbus is not universally "better" than every alternative. It is better for its stated safety goal: one small task, one allowed public repository, isolated execution, reviewable pull request, and no autonomous merge. A local agent is faster and more flexible for a trusted developer; Nimbus trades some flexibility for isolation, auditability, and narrow permissions.

## 6. The four trust zones

### 6.1 Browser: partially trusted input source

The React app displays data and sends user requests. It is never the final authority. A malicious user can change browser JavaScript or call the API directly, so the server repeats every important check.

Important files:

- `apps/web/src/App.tsx`: top-level route and setup gates.
- `apps/web/src/api/client.ts`: credentialed API requests and CSRF handling.
- `apps/web/src/screens/Dashboard.tsx`: task composer and `@repository` picker.
- `apps/web/src/screens/Session.tsx`: conversation and right-side inspector.

### 6.2 Trusted backend: authority and control plane

The API owns authentication, authorization, policy, durable state, model calls, sandbox control, final patch validation, GitHub tokens, push, PR creation and event ordering.

This is the security boundary. If the model or sandbox asks for something unsafe, backend code must refuse it.

### 6.3 Sandbox: untrusted execution zone

The sandbox may run repository code, which is untrusted. It receives repository files but no database credentials, session cookie, model key, GitHub token, or unrestricted internet.

### 6.4 External providers

- Google authenticates a user.
- GitHub owns repositories, installations, branches and pull requests.
- Gemini generates model responses using the user's stored API key.
- E2B hosts the disposable machine.
- S3-compatible storage holds attachment bytes.

Each provider is accessed by a small adapter so core logic can be tested with fakes.

## 7. Complete end-to-end flow

The following is the exact main path from opening Nimbus to receiving a pull request.

### Step 0: server startup

Entry and wiring:

- `apps/api/src/index.ts` loads configuration, creates the logger, starts the API, and handles shutdown signals.
- `apps/api/src/config/schema.ts` describes allowed environment variables.
- `apps/api/src/config/load.ts` builds one validated configuration object. Other modules do not read `process.env` directly.
- `apps/api/src/server.ts` constructs every real adapter and connects the whole application.

Startup happens in a deliberate order:

1. Validate configuration.
2. Connect to MongoDB.
3. Apply Mongo collection validators and indexes through `apps/api/src/db/bootstrap.ts`.
4. Connect to Redis.
5. Build mail, authentication, provider-key, GitHub, attachment, session, event, sandbox, push and PR services.
6. Recover any durable events that were saved but not published.
7. Start the session orchestrator and cleanup sweepers.
8. Create the HTTP server and WebSocket event hub.
9. Listen only after required dependencies are ready.

This avoids accepting work when the server cannot persist or coordinate it.

### Step 1: the browser decides which screen to show

`apps/web/src/App.tsx` is the top-level traffic controller.

`useSession` calls `GET /auth/me`. The result says who the user is, supplies a CSRF token, and says whether an active GitHub installation or coding session exists. Based on that state, `App.tsx` routes the user through:

```text
signed out -> sign in
signed in but no GitHub installation -> connect GitHub
GitHub connected but no model key -> add Gemini key
ready -> dashboard
active session -> session screen
```

This browser gate is for user experience only. The API separately enforces the same requirements.

### Step 2: Google sign-in

The UI link points to `GET /auth/google`.

Relevant files:

- `apps/api/src/http/routes/auth.ts`
- `apps/api/src/auth/google-service.ts`
- `apps/api/src/auth/google-identity.ts`
- `apps/api/src/auth/oauth-state.ts`
- `apps/api/src/auth/user-repository.ts`
- `apps/api/src/auth/session-service.ts`
- `apps/api/src/db/models/user.ts`

Detailed flow:

1. `GET /auth/google` calls `GoogleService.begin()`.
2. The service creates a random OAuth state, PKCE verifier/challenge, and separate browser-binding value.
3. Short-lived state is stored in Redis. The binding value is placed in an HTTP-only, SameSite cookie.
4. The API redirects the browser to Google's authorization page.
5. Google redirects to `GET /auth/google/callback?code=...&state=...`.
6. The API compares the returned state with the one-time Redis record and the binding cookie. Consuming it makes it replay-resistant.
7. The backend exchanges the code and PKCE verifier with Google.
8. It accepts only a verified Google email.
9. `findOrCreateUserByEmail` normalizes the email and either updates the existing account's providers/last-login time or inserts a new user.
10. A unique MongoDB email index prevents two concurrent callbacks from creating duplicate accounts.
11. `SessionService.start()` generates a random login session ID, stores only its keyed hash/record in Redis, derives a CSRF token, and sends the raw ID as an HTTP-only cookie.
12. The API redirects to the web route `/auth/callback?signin=success`.
13. The React app refreshes `/auth/me` and moves to the dashboard/setup flow.

Nimbus also supports passwordless email OTP through `POST /auth/otp/request` and `POST /auth/otp/verify`. The UI in `apps/web/src/screens/SignIn.tsx` exposes both methods. So the accurate statement is "Google OAuth or email code," not "Google OAuth only."

### Step 3: connect the GitHub App

This is often misunderstood because there are **three different GitHub concepts**:

1. **App installation**: the repository owner chooses which repositories the Nimbus App may access.
2. **Setup/OAuth callback**: Nimbus proves which signed-in GitHub user performed or can reach that installation, then connects it to the Nimbus user.
3. **Webhook**: GitHub later tells Nimbus about installation/repository changes. It is server-to-server and does not redirect the browser.

Relevant files:

- `apps/web/src/screens/Connect.tsx`
- `apps/web/src/github/useInstallation.ts`
- `apps/api/src/http/routes/github.ts`
- `apps/api/src/github/installation-service.ts`
- `apps/api/src/github/directory.ts`
- `apps/api/src/github/webhook-service.ts`
- `apps/api/src/github/webhook-events.ts`
- `apps/api/src/db/models/github-installation.ts`

Detailed setup flow:

1. The Connect screen calls `GET /github/connect`.
2. `InstallationService.beginConnect()` stores a one-time state record in Redis tied to the Nimbus `userId`.
3. It returns:
   - an installation URL such as `github.com/apps/<slug>/installations/new?state=...`, and
   - a GitHub OAuth authorization URL used to prove the installer identity.
4. The user installs the GitHub App and selects repository access on GitHub.
5. GitHub returns to `GET /github/setup/callback` with values such as `installation_id`, `setup_action`, `state`, and possibly `code` depending on the stage.
6. If installation returned without an OAuth code, Nimbus starts the identity authorization leg and comes back with the code.
7. The backend consumes the state once and verifies it belongs to the currently logged-in Nimbus user.
8. `OctokitGitHubDirectory.identifyInstaller()` exchanges the GitHub OAuth code for a short-lived user token, reads the authenticated GitHub user, and lists installations reachable by that user.
9. Nimbus refuses to connect an installation that the proved GitHub user cannot reach or that another Nimbus account already owns.
10. Using an App JWT, the backend reads authoritative installation details from GitHub.
11. It inserts or updates `github_installations` in MongoDB and marks older installations for that Nimbus account removed. V1 intentionally supports one active installation per user.
12. The API redirects the browser to `/github/callback?github=connected`.
13. `App.tsx` refreshes repository access, and `Connect.tsx` displays the result.

The setup callback causes the browser redirect. The webhook does not.

### Step 4: GitHub webhook processing and selected repositories

GitHub sends installation lifecycle and `installation_repositories` events to `POST /github/webhook`.

Flow:

1. `apps/api/src/app.ts` keeps the webhook body as raw bytes, because signatures must be checked against exactly what GitHub sent.
2. `GitHubWebhookService` verifies the HMAC signature using `GITHUB_WEBHOOK_SECRET`.
3. It validates the GitHub event name and delivery ID.
4. Redis idempotency ensures one GitHub delivery is not applied twice.
5. `decideWebhookIntent` converts the large external payload into a small internal intent: change installation status, update selected repositories, accept a permission event, or ignore it.
6. Installation status and the webhook's selected repository snapshot are written to `github_installations` in MongoDB.
7. An audit event is appended.

The stored field is:

```text
github_installations.selectedRepositories[]
  repositoryId
  owner
  name
```

However, the dashboard does not trust only that cached webhook snapshot. `GET /github/repositories` mints a metadata-only installation token and calls GitHub's `listReposAccessibleToInstallation`. It filters the result to valid **public** repositories and returns fresh repository summaries. This handles missed/delayed webhooks and provides fields such as default branch, URL, and updated time.

That is the answer to "where are selected repos stored?":

- A webhook-maintained selection snapshot is in MongoDB under the installation.
- The selectable dashboard list is refreshed from GitHub using the active installation.
- The exact chosen repository summary is then copied into the session document so that the run has a durable record of what it was started against.

### Step 5: add the user's Gemini key

Before a coding session can start, the account needs a usable model-provider key.

Relevant files:

- `apps/web/src/screens/Keys.tsx`
- `apps/api/src/http/routes/provider-keys.ts`
- `apps/api/src/llm/provider-keys.ts`
- `apps/api/src/llm/verify.ts`
- `apps/api/src/lib/secret-box.ts`
- `apps/api/src/db/models/provider-key.ts`

Flow:

1. The user enters a Gemini key.
2. The API validates its basic shape and makes a small live provider request to verify it.
3. The key is encrypted with AES-256-GCM.
4. Encryption key material is derived from `SESSION_SECRET`; authenticated additional data binds the ciphertext to the specific user and provider.
5. MongoDB stores the sealed value and a harmless hint, not plaintext.
6. At run time, `UserProviders` decrypts only the owning user's key and constructs that run's provider adapter.

The server does not have one shared Gemini key for all users. This keeps billing and provider access attached to each account, at the cost of more onboarding and secret-management work.

### Step 6: choose a repository with `@` and enter a task

`apps/web/src/screens/Dashboard.tsx` renders the composer.

`apps/web/src/sessions/mention.ts` handles repository mentions:

1. `activeMention()` notices a token beginning with `@` at the caret.
2. `matchRepositories()` filters the repository list by `owner/name`.
3. `insertMention()` inserts `@owner/repo` into the visible text.
4. `mentionedRepository()` resolves that token back to a `RepositorySummary`.
5. `withoutMentions()` removes repository mention tokens from the task text before it is sent as the actual instruction.

The browser sends this shape to `POST /sessions`:

```text
repositoryId       numeric GitHub repository ID
task               prompt without the @owner/repo token
attachmentIds      already uploaded attachment IDs
idempotencyKey     retry-safe unique request key
model              optional user-selected model
```

The `@` feature is only a convenient picker. Security does not depend on parsing the visible string. The server receives the numeric repository ID and checks it against a fresh GitHub-authorized list.

### Step 7: create the durable session

Route: `apps/api/src/http/routes/sessions.ts`

Business logic: `apps/api/src/sessions/service.ts`

Persistence: `apps/api/src/sessions/repository.ts` and `apps/api/src/db/models/session.ts`

The API performs these checks and writes:

1. Require a valid login cookie.
2. Require the CSRF header to match the login session.
3. Apply a Redis account rate limit.
4. Validate the request with `CreateSessionBodySchema` from `packages/contracts`.
5. Re-list repositories and ensure the requested repository ID is still accessible.
6. Ensure the account has a provider key and the chosen model is available through it.
7. Verify every attachment belongs to the user and has not been claimed by another session.
8. Optionally call the model to generate a short session title. Failure is non-fatal; task text becomes the fallback title.
9. Create a `sessions` Mongo document with status `queued`, the repository snapshot, original message, budgets, empty tool/check/file state, and no base commit yet.
10. A unique partial Mongo index guarantees one active session per user even if two requests arrive simultaneously.
11. A unique `(userId, idempotencyKey)` index makes a network retry return the original session instead of creating a duplicate.
12. Attachments are claimed by the new session.
13. The browser navigates to `/sessions/<sessionId>`.

At this moment no coding sandbox is necessarily running yet. The session is durable work waiting for a worker.

### Step 8: a worker claims the queued session

`apps/api/src/orchestrator/orchestrator.ts` is the background worker coordinator.

1. It periodically asks `MongoSessionRecords.findClaimable()` for queued or recoverable sessions.
2. It acquires a Redis lease for the session.
3. The lease prevents two API workers from running the same session.
4. A heartbeat renews the lease while work is active.
5. The session is durably marked as started before work begins.
6. `SessionRunner.run()` receives an `AbortSignal` and a liveness callback so cancellation, lease loss, or shutdown can stop the run before external writes.

Why both a Mongo status and Redis lease?

- Mongo status is durable product truth that survives restarts.
- Redis lease is short-lived coordination truth that automatically expires if a worker dies.

Using only a Mongo boolean such as `isRunning` could leave a permanent lock after a crash. Using only Redis would lose the durable history and recovery position.

### Step 9: preparation order — model first or sandbox first?

The exact answer is nuanced.

During HTTP session creation, Nimbus may make a small Gemini call to generate the session title. That is not the coding agent reasoning loop.

For the actual coding run, `LiveSessionWorkshop.prepare()` in `apps/api/src/orchestrator/live-workshop.ts` performs this order:

1. Load the user's active GitHub installation from MongoDB.
2. Mint a **read-only, one-repository** GitHub installation token.
3. Resolve the exact base commit SHA from the repository's default branch, or reuse a previously pinned SHA for a resumed run.
4. Persist that SHA to the session before doing work.
5. Load the user's available model providers and build the role-to-model plan.
6. Create/rent the sandbox using `buildSandboxSpec()`.
7. Build the sandbox tool registry, command runner, policy gate and action executor.
8. Rebuild fresh agent state from the durable session.
9. Build the model router and load attachments/review comments.
10. Start the LangGraph run.
11. The graph's first node copies the repository into the sandbox.
12. Only after cloning/profiling does the graph perform its scope model call and main action-selection calls.

So the clean interview answer is:

> Nimbus pins access and the exact commit first, creates the sandbox second, clones the repository third, and starts the main LLM agent reasoning after the workspace exists. A separate title-generation model call can happen earlier and image-description calls may happen during preparation.

### Step 10: how the repository gets into the sandbox

This implementation does **not** run `git clone` inside E2B.

Relevant files:

- `apps/api/src/agent/clone/github.ts`
- `apps/api/src/agent/clone/plan.ts`
- `apps/api/src/sandbox/e2b-provider.ts`

Detailed flow:

1. The trusted backend holds the read installation token in memory.
2. `GitHubRepositorySource` uses Octokit from the trusted backend to request the recursive Git tree for the pinned commit SHA.
3. `planClone()` skips symlinks, submodules, ignored/generated/secret-like paths, oversized files, and anything beyond file/byte budgets.
4. For each accepted file, the backend fetches its blob/content from GitHub.
5. Binary-looking or oversized contents are skipped.
6. The backend calls the sandbox provider's `writeFile(path, contents)` method.
7. The token is never put in a sandbox environment variable, config file, Git remote or command.
8. Once all allowed files are written, `sandbox.markBaseline()` creates a local synthetic Git baseline inside the sandbox. This baseline exists only to calculate a clean diff later.

This architecture answers "how does the sandbox know which repo?": it does not independently know or choose. The trusted backend reads the repository snapshot stored in the session, verifies the current installation, pins the commit, fetches allowed content, and writes that content into the sandbox.

Why not `git clone` inside the sandbox?

- `git clone` would require placing a GitHub credential inside the untrusted machine.
- Repository scripts or later commands might steal that credential.
- The sandbox would need network access to GitHub.
- A full clone may include history or files Nimbus does not need.

The tradeoff is speed: fetching many blobs through the API can be slower than Git's pack protocol, and large repositories may be rejected or only partially copied.

### Step 11: repository profiling and lexical retrieval

After cloning, the graph builds a deterministic repository profile in `apps/api/src/agent/profile/repository-profile.ts`:

- languages inferred from extensions;
- manifests such as `package.json`, `pyproject.toml`, `go.mod`, and `Cargo.toml`;
- source/test/package roots;
- detected frameworks;
- generated paths;
- known repository scripts that can become check IDs.

`apps/api/src/retrieval` then provides bounded lexical retrieval:

1. List the safe workspace tree.
2. Derive search terms from the task.
3. Search safe text files.
4. Rank matches deterministically.
5. Return small line windows, not the entire repository.
6. Wrap repository content in random delimiters and label it as untrusted data.

The main files are `retriever.ts`, `scan.ts`, `rank.ts`, `query.ts`, `excerpt.ts`, `tree.ts`, `policy.ts`, and `labeling.ts`.

Why lexical retrieval first?

- It starts immediately with no embedding index.
- It always reflects the files the agent just edited.
- Results and rankings are easier to reproduce and explain.
- It avoids sending every file to an embedding provider.

Semantic Qdrant retrieval is feature-flagged/planned because it may improve fuzzy concept search, but it adds cold-start time, storage, cost, filters, and stale-index problems.

### Step 12: the agent graph

`apps/api/src/agent/graph/graph.ts` defines these nodes:

```text
START
  -> clone
  -> scope
  -> retrieve
  -> reason <----+
       |         |
       v         |
     execute ----+
       |
       +-> review -> complete
       |
       `-> END on finish, pause, limit, cancellation or failure
```

Node responsibilities:

#### `clone`

Copies the pinned repository into the sandbox, builds its profile, discovers available sandbox tools, and calculates workspace revision 0.

#### `scope`

`apps/api/src/agent/nodes/scope.ts` checks whether the request is actionable. Very thin tasks are rejected by deterministic rules; otherwise a lightweight model returns strict structured JSON. Repository questions are accepted without an unnecessary clarification.

#### `retrieve`

`apps/api/src/agent/nodes/retrieve.ts` gathers relevant repository snippets plus bounded attachment/image descriptions.

#### `reason`

`apps/api/src/agent/nodes/reason.ts` compiles the current task, repository profile, current evidence, previous tool failures, recent conversation, eligible tools and exact tool schemas. Gemini must return one next action as JSON.

It is intentionally one action at a time. After every result, the model gets new evidence and chooses again. This is slower than generating a giant plan once, but it corrects course based on actual file contents and command results.

#### `execute`

The backend validates the tool name and arguments, checks phase eligibility, computes a stable action hash, applies deterministic policy, possibly requests exact user approval, runs the tool, bounds/redacts its output, records evidence and updates the workspace revision.

#### `review`

The graph exports and validates the patch, then `apps/api/src/agent/review/review.ts` checks that policy accepted it, required acceptance criteria are satisfied, required checks belong to the final workspace revision, and no required check has an unresolved failure.

#### `complete`

The graph applies the final completion gate and returns a prepared patch to `SessionRunner`. It does not push from inside the graph.

### Step 13: how the LLM calls tools

The model never invokes a JavaScript function directly.

The flow is:

1. `ToolRegistry.describe()` produces the currently eligible tool names, descriptions and JSON schemas.
2. `compilePhasePrompt()` inserts them into a structured prompt.
3. `SessionRouter.completeStructured()` calls Gemini with a response schema.
4. Gemini returns an object like:

```json
{
  "intent": "Read the login handler before changing it.",
  "tool": "read_file",
  "toolArguments": {
    "path": "src/auth/login.ts",
    "startLine": 1,
    "lineCount": 160
  }
}
```

5. Zod validates the returned JSON.
6. The registry refuses unknown tools, extra/malformed arguments, and tools not allowed in the current phase.
7. `PolicyGate.authorize()` classifies the exact action.
8. `ActionExecutor.execute()` runs only an allowed action and reports start/output/completion events.
9. The bounded observation is appended to agent history and becomes evidence for the next model call.

The built-in tools in `apps/api/src/agent/registry/tools.ts` are:

- `list_tree`
- `search_code`
- `read_file`
- `create_file`
- `apply_patch`
- `run_command`
- `run_checks`
- `git_status`
- `prepare_commit`
- `message_user`
- `finish_task`
- `wait_for_user`

There is deliberately no `push`, `merge`, `open_pr`, `read_secret`, arbitrary network request, or unrestricted shell tool in the model registry.

### Step 14: how files are created and edited

Relevant files:

- `apps/api/src/agent/tools/file-tools.ts`
- `apps/api/src/agent/tools/patch.ts`
- `apps/api/src/agent/tools/policy-paths.ts`
- `apps/api/src/agent/policy/rules.ts`
- `apps/api/src/agent/policy/policy.ts`

`create_file` writes a new text file but fails rather than overwriting an existing file.

`apply_patch` accepts a unified diff. Nimbus parses it, normalizes paths, checks size/count limits, rejects traversal and other invalid targets, verifies context against existing content, and applies it to sandbox files.

Policy outcomes are:

- **allowed**: ordinary bounded edits and safe reads can run.
- **approval required**: dependency files, protected paths, deletions, renames, large diffs, lifecycle scripts and uncovered actions pause for a person.
- **denied**: impossible/unsafe paths, forbidden commands and actions that cannot be safely approved never run.

Approval is bound to an action hash containing the tool, exact arguments and workspace revision. Approving one dependency change does not grant a general permission for later different changes.

### Step 15: how commands and verification work

`run_command` receives an argument array, not a shell string. For example:

```text
["git", "log", "-n", "5"]
```

The sandbox adapter safely constructs the command. Pipes, redirection, command substitution and command chaining are not accepted as shell features.

`apps/api/src/agent/commands/policy.ts` and `catalogue.ts` classify programs, subcommands and dangerous flags. Unknown programs, shells, on-demand package execution, and many code-string flags are denied. Some dependency installation modes require approval because package lifecycle scripts can execute arbitrary code.

`run_checks` is stronger than `run_command`:

1. The backend profiles known package scripts.
2. It creates a trusted check ID.
3. The model may select that ID, but cannot replace its executable/arguments.
4. The backend maps the ID to a command such as `pnpm run test` in a known directory.
5. The result is classified as passed, failed, blocked, unavailable, timed out, cancelled or errored.
6. The check is attached to the current workspace tree hash.

If no repository check is available, language-specific syntax checks are possible for supported files. Delivery is gated on recorded check state, not on a model sentence claiming that tests passed.

### Step 16: live chat and right-side dashboard updates

There are two kinds of state:

1. **Durable snapshot state** in the `sessions` Mongo document: status, messages, files, checks, progress, PR and failure.
2. **Ordered event stream** in `session_events`: tool start/output/completion, phase updates, file/check updates, questions, approvals and delivery milestones.

Backend path:

1. Reporters in `apps/api/src/orchestrator/reporter.ts` write durable progress first.
2. `LiveEventPublisher` in `apps/api/src/events/publisher.ts` appends a typed event to MongoDB.
3. `MongoEventStore.append()` atomically increments the session's `lastEventSequence` and stores the event envelope.
4. The publisher sends the envelope through Redis Pub/Sub.
5. Every API instance's `EventHub` receives it and offers it only to sockets subscribed to that session.
6. Socket authentication uses the normal login cookie, exact allowed origin, and an ownership check.

Browser path:

1. `apps/web/src/sessions/useLiveSession.ts` first calls `GET /sessions/:id` for the authoritative snapshot and `lastEventSequence`.
2. It opens a WebSocket to `/events`.
3. It sends `session.subscribe` with that exact sequence.
4. The backend replays later events from Mongo, then sends live events.
5. `apps/web/src/events/stream.ts` orders events, ignores duplicates, and temporarily holds out-of-order events.
6. `apps/web/src/sessions/live.ts` reduces each typed event into React view state.
7. `Session.tsx` renders messages and composer state.
8. `Panels.tsx` renders Overview, Progress, Changes, Checks, Shell and Pull Request tabs.

Why snapshot first, then events?

If the browser only listened live, it would miss everything that happened before it connected. If it only polled snapshots, command output and fine-grained progress would feel slow and may never be represented. Snapshot + replayable events gives both a complete starting point and live detail.

Why Mongo event outbox plus Redis Pub/Sub?

Redis Pub/Sub is fast but does not retain missed messages. Mongo retains ordered events, so reconnects and server restarts can replay them. Redis is the live transport; Mongo is the recovery source.

### Step 17: preparing and validating the final patch

When work appears complete:

1. The sandbox exports a unified diff against its synthetic baseline.
2. `apps/api/src/agent/graph/patch.ts` calls the independent patch validator.
3. `apps/api/src/patch/validator.ts` parses the diff and checks:
   - base commit match;
   - maximum bytes, files and changed lines;
   - absolute paths and `..` traversal;
   - `.git` changes;
   - nested repositories and submodules;
   - symlink, binary and mode changes;
   - protected paths;
   - deletion/rename approval categories;
   - likely secrets and high-entropy strings.
4. Diffs displayed to the user are bounded and secret-redacted.
5. The independent review checks the final workspace revision and verification evidence.
6. `SessionRunner` performs another deterministic delivery gate. A model cannot override a failed recorded check.

The patch is data crossing from an untrusted execution zone back into a trusted zone, so it must be treated like an uploaded file, not trusted merely because Nimbus created it.

### Step 18: how the real commit and branch are created

This is another important correction: the meaningful GitHub commit is **not** made in the sandbox.

The sandbox's local baseline commit only helps produce a diff. The durable commit is created later by `TrustedPushGateway` in `apps/api/src/push/gateway.ts`.

Flow:

1. `SessionRunner` checks cancellation/liveness immediately before pushing.
2. The backend mints a short-lived token scoped to exactly one installation, one repository and `contents: write`.
3. The gateway verifies that patch validation allowed delivery and used the same base SHA.
4. It chooses a `nimbus/...` feature branch name, or reuses the existing PR branch for a follow-up.
5. Through GitHub's Git Data API it reads the base commit/tree and the original contents of changed files.
6. It reapplies the validated patch in trusted code. If it no longer applies, delivery stops.
7. It creates Git blobs for new contents.
8. It creates a Git tree based on the base tree.
9. It creates a Git commit with the pinned base commit as parent.
10. It creates the new branch ref or safely updates the existing Nimbus branch with `force: false`.
11. It never writes to the repository's default branch.
12. It revokes the token in `finally`; if revocation fails, the token still expires naturally.

Idempotency checks compare existing branch/tree state so a retry can return `already_pushed` instead of creating uncontrolled duplicates.

### Step 19: pull request creation

Relevant files:

- `apps/api/src/pull-request/gateway.ts`
- `apps/api/src/pull-request/octokit-client.ts`
- `apps/api/src/pull-request/body.ts`

Flow:

1. Check liveness again after branch push and before PR creation.
2. Mint a separate short-lived one-repository token with pull-request permission.
3. Search for an existing PR from that branch. If one exists, return it; this makes retries idempotent and lets follow-ups update the same PR.
4. Otherwise create a PR targeting the repository's default branch.
5. The PR body includes the user's task, Nimbus summary, branch, base SHA, changed files/line counts, check results and a clear AI/human-review notice.
6. If creation races with another attempt, search again for the winner before failing.
7. Revoke the token.
8. Persist the PR result and final session outcome.
9. Emit `pr.created`, add a final agent chat message, and send notification email when appropriate.

The user reviews and merges on GitHub. Nimbus never merges, approves, closes, or force-pushes.

### Step 20: sandbox teardown

`runAgent()` in `apps/api/src/agent/graph/run.ts` has a `finally` block that terminates the sandbox whether the run completes, fails, pauses, or is cancelled.

The read token is also revoked in the workshop's `finish()` callback. This cleanup happens independently of the push and PR tokens, which are minted only at delivery time.

If a run pauses for clarification or approval, its sandbox is destroyed. On resume Nimbus creates a new sandbox from the same verified base state and durable conversation/progress. It does not pretend the previous disposable filesystem still exists.

## 8. Session, run and delivery state

Nimbus separates three questions:

- **Session status**: what should the UI show now?
- **Run status**: how did the most recent turn end?
- **Delivery status**: what reached GitHub?

Main visible state path:

```text
ready -> queued -> provisioning -> indexing -> working
                                                |
                         +----------------------+----------------+
                         |                      |                |
                  awaiting_user             validating       completed
                         |                      |
                         +-> working            +-> pushing -> pr_created

cancelled can end any active state; failures can happen at any stage.
```

An informational question can finish as `completed` with no patch. A code-change turn can finish with `pr_created`. The conversation can later receive another user message and reopen for a follow-up.

For a follow-up on an existing PR:

1. The new user message is added to the same session.
2. The session reopens and uses the last delivered PR head SHA as its new base.
3. Nimbus reads current PR review/discussion comments when available.
4. It makes a new commit on the same branch.
5. The existing PR is found and returned instead of opening a duplicate.

## 9. Durable data: what is stored where

### MongoDB: long-lived truth

Current collections are declared in `apps/api/src/db/collections.ts`:

| Collection             | Stores                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `users`                | Normalized account identity and authentication providers                                         |
| `github_installations` | Nimbus owner, GitHub installation, status and selected repository snapshot                       |
| `sessions`             | Task, repository snapshot, messages, status, progress, files, checks, approvals, PR and failures |
| `session_events`       | Ordered, expiring event outbox used for replay                                                   |
| `attachments`          | Attachment ownership, type, size, storage key and processing metadata                            |
| `repo_indexes`         | Retrieval index metadata for optional indexing work                                              |
| `audit_events`         | Security-relevant actions and outcomes                                                           |
| `checkpoints`          | LangGraph checkpoint-compatible records; not used as the main recovery mechanism                 |
| `provider_keys`        | Per-user encrypted model-provider keys and hints                                                 |

Mongo schemas reject unexpected fields, define required fields, and create important unique/partial indexes. Public prefixed IDs such as `usr_...` and `ses_...` leave the backend instead of Mongo ObjectIds.

### Redis: short-lived and coordination state

Redis stores things that should expire automatically or require atomic coordination:

- login sessions;
- Google OAuth state and browser binding;
- GitHub setup nonces;
- OTPs and attempt limits;
- rate-limit buckets;
- worker/session leases;
- cancellation Pub/Sub;
- live event Pub/Sub;
- webhook delivery idempotency;
- external-write idempotency where applicable.

Lua scripts are used when an operation must read/check/write atomically.

### S3-compatible storage

Attachment bytes live in S3/R2/MinIO rather than Mongo. Mongo holds metadata and ownership. This makes it possible to expire unclaimed uploads and avoids growing session documents with binary data.

### Sandbox storage

Sandbox files are temporary and are not a source of truth. Only exported, validated, and delivered material is durable.

## 10. Why the agent and sandbox are separate

This question is likely in an interview.

If the entire agent ran inside the sandbox, it would need model credentials, database access, GitHub access and durable state access. Any malicious repository command could then steal those privileges.

Keeping the agent controller in the trusted backend means:

- the sandbox receives no GitHub or Gemini key;
- policy runs outside the environment being controlled;
- the backend can stop/retry/observe the run even if repository code crashes;
- model output is validated before execution;
- tool results can be bounded and redacted before returning to the model/browser;
- final GitHub writes use a separately validated patch;
- multiple sandbox providers can implement the same interface;
- durable state survives disposal of the machine.

The tradeoff is more round trips and more adapter code. A single-process local agent is simpler and faster, but its security boundary is much weaker.

## 11. Authentication and authorization details

### Authentication: who are you?

- Google OAuth/PKCE or email OTP proves account identity.
- An HTTP-only cookie holds a random session ID.
- Redis holds the expiring server-side login record.
- Idle and absolute lifetimes limit stolen-cookie usefulness.

### CSRF: did this browser intentionally send the write?

Authenticated writes require a CSRF token derived from server key material and the login session. A hostile website cannot read it and therefore cannot silently start/cancel sessions or disconnect GitHub using the user's cookie.

### Authorization: may this user access this object?

Routes query by both `userId` and public object ID. WebSocket subscription checks session ownership. Attachment claiming checks ownership. Repository choice is revalidated against GitHub. An installation cannot be attached to two Nimbus accounts.

### GitHub permission narrowing

`apps/api/src/github/token-provider.ts` mints different installation tokens for different jobs:

- listing: metadata read;
- clone: contents read for one repository;
- push: contents write for one repository;
- PR: contents/pull-request write for one repository.

The provider checks that GitHub did not return broader permissions than requested.

## 12. Failure, cancellation and recovery

### Cancellation

1. The user calls `POST /sessions/:id/cancel`.
2. Mongo records cancellation.
3. Redis broadcasts it.
4. The worker's `AbortController` stops the graph/command where possible.
5. `SessionRunner` checks liveness before branch push and again before PR creation.

There is an unavoidable distributed-systems edge: cancellation can race with an external GitHub call that has already started. Reconciliation and idempotency reduce damage, but no application can atomically commit one transaction across MongoDB and GitHub.

### Worker crash or lease loss

- The Redis lease expires.
- Another worker may claim a session left in a mid-run status.
- Retry/recovery count is bounded so a broken session cannot loop forever.
- Step budget never resets backwards.
- The new attempt recreates the sandbox from the pinned commit and durable session state.
- A worker that loses its lease writes no outcome.

### Why graph checkpoints are not the main recovery system

A LangGraph checkpoint could say "patch applied," but the E2B filesystem holding that patch may already be gone. Restoring only the graph state would create a lie. Nimbus therefore recovers at the session level and rebuilds a fresh workspace.

### Event loss

Durable state is written before the event. If event publication fails, the snapshot is still correct and the Mongo outbox can replay. Publishing first would let the UI display a transition the database never committed.

## 13. Important design tradeoffs

### GitHub App vs personal access token

GitHub App wins because permissions are repository-scoped, tokens expire, installations can be revoked, and the app identity is separate from a person's permanent credential. Setup is more complex.

### API-based copy vs `git clone`

API copy keeps credentials and network out of the sandbox and allows file filtering. `git clone` is faster for large/history-heavy repositories. Nimbus chooses isolation over clone performance.

### Backend Git Data commit vs `git commit && git push` in sandbox

The backend can reapply and inspect the exact patch with a narrow token. Sandbox Git would be simpler but requires credentials inside untrusted execution and makes final policy easier to bypass.

### Structured model output vs parsing prose

Strict JSON schema reduces ambiguity and makes invalid actions rejectable. It can make model calls more constrained and provider-dependent. Prose parsing is flexible but unsafe and brittle.

### One-action loop vs one large plan

One action at a time is slower and costs more model calls, but each decision uses real observations. A large plan is cheaper but becomes stale as soon as a file or command result differs from expectation.

### WebSockets vs polling

WebSockets give fast tool output and progress. Polling is operationally simpler but wasteful and less responsive. Nimbus keeps polling only as a small terminal-state reconciliation fallback.

### MongoDB vs PostgreSQL

Mongo fits a large evolving session document and atomic document updates. PostgreSQL would provide stronger relational constraints and rich reporting. Either could work; this is a product-shape decision, not a universal win.

### Redis leases vs database locks

Redis TTLs make crash recovery natural. Database advisory locks could remove one service, especially with PostgreSQL, but would couple worker liveness to the durable database and need careful connection handling.

### BYOK model keys vs platform key

BYOK removes centralized model spend and lets usage belong to the user. It adds friction, support burden and encrypted-secret responsibility. A paid SaaS would likely offer both platform billing and BYOK.

### Public repositories only

This narrows data/privacy risk for V1. It does not make code trustworthy: public repositories can still contain prompt injection, malicious scripts and accidental secrets. Private repository support would require stronger privacy, retention, deletion, support and compliance work.

## 14. File-by-file interview map

### Browser entry, routing and API

| File/folder                          | Responsibility                                            |
| ------------------------------------ | --------------------------------------------------------- |
| `apps/web/src/main.tsx`              | React entry point                                         |
| `apps/web/src/App.tsx`               | Auth/setup/key/session gating and route-level composition |
| `apps/web/src/app/routes.ts`         | Route parsing and paths                                   |
| `apps/web/src/api/client.ts`         | HTTP requests, cookies, CSRF and response validation      |
| `apps/web/src/session/useSession.ts` | Current login context                                     |

### Onboarding

| File/folder                                   | Responsibility                                          |
| --------------------------------------------- | ------------------------------------------------------- |
| `apps/web/src/screens/SignIn.tsx`             | Google and OTP sign-in UI                               |
| `apps/api/src/http/routes/auth.ts`            | Auth HTTP endpoints and redirects                       |
| `apps/api/src/auth/google-service.ts`         | Google OAuth business flow                              |
| `apps/api/src/auth/oauth-state.ts`            | One-use OAuth state, PKCE and browser binding           |
| `apps/api/src/auth/session-service.ts`        | Login session issue/load/end and CSRF context           |
| `apps/web/src/screens/Connect.tsx`            | GitHub installation/setup UI                            |
| `apps/api/src/http/routes/github.ts`          | GitHub connect, callback, webhook and repository routes |
| `apps/api/src/github/installation-service.ts` | Installation ownership and persistence                  |
| `apps/api/src/github/webhook-service.ts`      | Signed idempotent webhook application                   |
| `apps/api/src/github/token-provider.ts`       | Short-lived narrowed installation tokens                |
| `apps/web/src/screens/Keys.tsx`               | Provider-key UI                                         |
| `apps/api/src/llm/provider-keys.ts`           | Verify, encrypt, save, list and remove keys             |

### Task/session creation

| File/folder                            | Responsibility                                         |
| -------------------------------------- | ------------------------------------------------------ |
| `apps/web/src/screens/Dashboard.tsx`   | Composer, model picker, attachments and start request  |
| `apps/web/src/sessions/mention.ts`     | `@owner/repo` parsing and insertion                    |
| `apps/api/src/http/routes/sessions.ts` | Session HTTP endpoints                                 |
| `apps/api/src/sessions/service.ts`     | Session business rules                                 |
| `apps/api/src/sessions/repository.ts`  | Atomic Mongo session transitions                       |
| `apps/api/src/db/models/session.ts`    | Durable session shape, mapping, validators and indexes |
| `apps/api/src/sessions/title.ts`       | Non-fatal model-generated title                        |

### Worker and sandbox

| File/folder                                  | Responsibility                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------ |
| `apps/api/src/orchestrator/orchestrator.ts`  | Polling, leases, concurrency, recovery and shutdown                            |
| `apps/api/src/orchestrator/runner.ts`        | Whole run outcome, live messages, patch delivery and final status              |
| `apps/api/src/orchestrator/live-workshop.ts` | Assemble one live run's installation, token, commit, models, sandbox and tools |
| `apps/api/src/sandbox/provider.ts`           | Sandbox interface and common validation                                        |
| `apps/api/src/sandbox/spec.ts`               | Safe sandbox limits/environment                                                |
| `apps/api/src/sandbox/e2b-provider.ts`       | E2B implementation, workspace and lifecycle                                    |
| `apps/api/src/sandbox/fake-provider.ts`      | Deterministic test/development sandbox                                         |
| `apps/api/src/agent/clone/github.ts`         | Trusted GitHub-to-sandbox file copy                                            |

### Agent intelligence and tools

| File/folder                               | Responsibility                                          |
| ----------------------------------------- | ------------------------------------------------------- |
| `apps/api/src/agent/graph/graph.ts`       | LangGraph nodes and edges                               |
| `apps/api/src/agent/graph/run.ts`         | Graph invocation and guaranteed teardown                |
| `apps/api/src/agent/nodes/scope.ts`       | Task clarity decision                                   |
| `apps/api/src/agent/nodes/retrieve.ts`    | Build initial repository context                        |
| `apps/api/src/agent/nodes/reason.ts`      | Ask model for exactly one structured next action        |
| `apps/api/src/agent/prompt/compiler.ts`   | Stable bounded prompt assembly                          |
| `apps/api/src/agent/registry/registry.ts` | Tool discovery, validation and phase eligibility        |
| `apps/api/src/agent/registry/tools.ts`    | Built-in tool definitions                               |
| `apps/api/src/agent/execute/executor.ts`  | Policy-check and perform an action                      |
| `apps/api/src/agent/policy/*`             | Deterministic action classification and exact approvals |
| `apps/api/src/agent/commands/*`           | Command allowlist, execution and output handling        |
| `apps/api/src/retrieval/*`                | Safe lexical repository search and ranking              |
| `apps/api/src/agent/state/*`              | Typed state, budgets and sanitization                   |

### Verification and delivery

| File/folder                                        | Responsibility                                                  |
| -------------------------------------------------- | --------------------------------------------------------------- |
| `apps/api/src/agent/profile/repository-profile.ts` | Framework/language/manifest/check discovery                     |
| `apps/api/src/agent/verification/planner.ts`       | Map trusted check IDs to commands and classify results          |
| `apps/api/src/agent/review/review.ts`              | Independent final evidence/revision review                      |
| `apps/api/src/agent/graph/patch.ts`                | Export and validate final patch                                 |
| `apps/api/src/patch/*`                             | Diff parsing, path/secret/limit checks and findings             |
| `apps/api/src/push/gateway.ts`                     | Reapply patch, make blobs/tree/commit/branch through GitHub API |
| `apps/api/src/pull-request/gateway.ts`             | Idempotently find or open PR                                    |
| `apps/api/src/pull-request/body.ts`                | Human-readable PR description                                   |

### Live experience

| File/folder                               | Responsibility                                          |
| ----------------------------------------- | ------------------------------------------------------- |
| `apps/api/src/events/store.ts`            | Durable ordered event outbox and replay                 |
| `apps/api/src/events/publisher.ts`        | Mongo append then Redis publication                     |
| `apps/api/src/events/hub.ts`              | Authenticated WebSocket server and subscriptions        |
| `apps/api/src/orchestrator/reporter.ts`   | Turn agent actions into durable/live progress           |
| `apps/web/src/sessions/useLiveSession.ts` | Load snapshot, connect socket, reconcile terminal state |
| `apps/web/src/events/socket.ts`           | Subscribe, reconnect and backoff                        |
| `apps/web/src/events/stream.ts`           | Sequence, deduplicate and buffer events                 |
| `apps/web/src/sessions/live.ts`           | Reduce events into screen state                         |
| `apps/web/src/screens/Session.tsx`        | Conversation and inspector shell                        |
| `apps/web/src/sessions/Panels.tsx`        | Overview, progress, diff, checks, shell and PR panels   |

### Shared safety and operations

| File/folder                | Responsibility                                               |
| -------------------------- | ------------------------------------------------------------ |
| `packages/contracts/src/*` | Every wire schema, ID, status, event, tool and shared limit  |
| `apps/api/src/config/*`    | Single validated environment/configuration boundary          |
| `apps/api/src/logging/*`   | Request context, structured logs and redaction               |
| `apps/api/src/redis/*`     | Typed expiring stores, leases, limits, nonce and idempotency |
| `apps/api/src/db/*`        | Mongo connection, schema bootstrap, models and indexes       |
| `docs/security.md`         | Control-by-control security design                           |
| `docs/threat-model.md`     | Assets, actors, threats, mitigations and accepted risks      |
| `docs/architecture.md`     | Compact architecture overview                                |

## 15. What is especially strong about this design

1. **Credentials never enter the sandbox.** This is stronger than merely telling the model not to reveal them.
2. **Policy is code, not a prompt.** Prompt rules help behavior, but deterministic code has final authority.
3. **GitHub writes happen after patch validation.** A compromised command runner still does not automatically receive write credentials.
4. **Commit pinning makes the run reproducible.** Retrieval, checks and patch validation refer to one immutable base.
5. **Checks are revision-bound.** A passing test before a later edit cannot validate the later tree.
6. **The model selects check IDs, not arbitrary verification commands.** The backend owns what counts as a check.
7. **Events are sequenced and replayable.** The live UI is not just best-effort animation.
8. **External writes are designed for retries.** Existing branch/tree/PR state is reconciled.
9. **One active session is a database invariant.** It cannot be bypassed by racing browser requests.
10. **All network boundaries use shared strict contracts.** Unknown fields and invalid enums are rejected.

## 16. Limitations and honest criticism

An interview answer should include weaknesses, not claim perfection.

1. **The project is still under construction.** Documentation and deployment examples can lag current code. For example, production Compose environment names should be checked against `config/schema.ts` before real deployment.
2. **Large repositories are a problem.** Recursive GitHub tree/API blob copying has file/byte caps and can be slow.
3. **Only public repositories are offered.** That reduces privacy scope but limits usefulness.
4. **Only Gemini is currently active.** The abstraction exists, but provider diversity is not real until another adapter is operated and tested.
5. **No unrestricted internet in the sandbox.** This is safer, but dependency installation and integration tests may be impossible or need carefully approved egress.
6. **Verification planning is still narrow.** It mainly recognizes known package scripts plus language fallbacks; complex monorepos may need dependency-aware test selection.
7. **Lexical retrieval can miss semantic relationships.** Semantic search is not yet the default answer.
8. **Distributed cancellation cannot be perfectly atomic with GitHub.** There can be a branch without a PR if cancellation lands between those writes.
9. **A malicious repository can still consume time/resources.** Isolation reduces impact; it does not make arbitrary code safe or useful.
10. **BYOK creates onboarding friction.** Beginners must create and trust Nimbus with an encrypted model key.
11. **Single active installation/session simplifies safety but limits power users.** Multi-repository tasks are intentionally out of scope.
12. **The browser has a manual PR-state feature.** Marking a PR merged/closed in the UI is local Nimbus state, not necessarily authoritative GitHub reconciliation.

## 17. Common wrong explanations, corrected

| Wrong explanation                                         | Correct explanation                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "The GitHub webhook redirects the user to the dashboard." | The setup callback redirects the browser. Webhooks are later signed server-to-server updates.                                                                    |
| "The sandbox clones the repo with a GitHub token."        | The trusted backend fetches safe files with Octokit and writes them into the sandbox; the token never enters the sandbox.                                        |
| "The model runs tools."                                   | The model proposes one structured tool action. Registry, policy and executor code decide whether and how it runs.                                                |
| "The model commits and pushes."                           | The sandbox only produces a diff. The trusted backend reapplies it and creates the real GitHub blob/tree/commit/ref.                                             |
| "The model says tests passed, so Nimbus opens a PR."      | Recorded, revision-bound check results and deterministic delivery gates decide.                                                                                  |
| "Selected repos only live in the frontend."               | GitHub is authoritative, a webhook snapshot is stored in Mongo, fresh accessible repos are listed from GitHub, and the selected repo is copied into the session. |
| "LangGraph checkpoint restores the old machine."          | Main recovery rebuilds a fresh sandbox from durable session state and pinned Git state because the old filesystem is disposable.                                 |
| "Google is the only sign-in method."                      | Both Google OAuth and passwordless email OTP exist.                                                                                                              |

## 18. Interview questions and strong short answers

### What is Nimbus?

Nimbus is a multi-tenant cloud coding agent that works on one authorized public GitHub repository inside a credential-free isolated sandbox, validates its output, and opens a review-only pull request through a trusted backend.

### Why use a GitHub App?

It provides installable repository-level authorization and short-lived scoped tokens. That is safer and easier to revoke than storing broad personal access tokens.

### Why does the server list repositories again when a session starts?

Frontend data may be stale or forged. Re-listing from GitHub proves the installation can still access that repository at the moment the session is created.

### What comes first: LLM or sandbox?

For the coding loop, the backend pins the commit and model plan, creates the sandbox, clones the repository, and then runs scope/action model calls. A small title model call can happen earlier.

### How does the repo enter E2B without credentials?

The backend uses a read-scoped installation token to fetch a pinned tree and safe text blobs through GitHub APIs, then writes them through the E2B file API. The token stays in backend memory.

### How are model tool calls made safe?

The model returns strict JSON for one registered tool. Zod validates it, the registry checks eligibility, deterministic policy classifies it, exact approvals are hash-bound, and only then does an executor call the sandbox adapter.

### Why are the agent and sandbox separate?

The controller needs secrets and durable state; repository code is untrusted. Separating them prevents sandbox code from inheriting model, database and GitHub credentials and lets policy live outside the environment it controls.

### How is a PR created?

After checks and patch validation, the trusted backend mints a narrow write token, reapplies the diff to the pinned GitHub base, creates blobs/tree/commit and a non-default branch through GitHub's Git Data API, then mints PR permission and idempotently opens or finds the PR.

### How are live updates reliable?

Durable progress and sequenced events are stored in Mongo first, Redis Pub/Sub fans them out live, WebSockets deliver them to authorized subscribers, and reconnecting clients replay events after their last sequence.

### How does Nimbus avoid duplicate work?

Session creation uses idempotency keys and unique indexes, workers use Redis leases, webhook deliveries use Redis idempotency, push reconciles existing branch/tree state, and PR creation checks for an existing branch PR.

### How does it recover after a worker crash?

The lease expires, another worker claims the durable mid-run session, recovery count is bounded, and a new sandbox is created from pinned Git state plus durable conversation/progress. It does not rely on the dead machine's filesystem.

### Why MongoDB and Redis together?

MongoDB stores durable product truth and ordered history. Redis handles precise expiry, rate limits, one-time state, leases, cancellation and low-latency Pub/Sub.

### What stops prompt injection from repository files?

Repository content is treated as untrusted quoted data, wrapped in collision-resistant delimiters, and never grants tools or permission. More importantly, tool eligibility and policy are enforced in code outside the model.

### What would you improve next?

A strong roadmap would include scalable archive/pack-based credential-free cloning, authoritative GitHub PR-state sync, deeper monorepo test selection, measured semantic retrieval, stronger production observability, another model provider, private-repository privacy controls, and deployment configuration cleanup.

## 19. A two-minute interview explanation

Nimbus is a TypeScript monorepo with a React/Vite frontend and an Express backend. Users sign in through Google OAuth or an email code, connect a GitHub App installation, choose a public repository, add their Gemini key, and start one coding session.

The browser sends only the repository ID and task. The backend revalidates GitHub access, creates a durable queued session in MongoDB, and a background worker claims it using a Redis lease. The worker pins the default branch's exact commit, mints a read-only one-repository GitHub token, creates an E2B sandbox, and copies safe repository files into it through GitHub and E2B APIs. The token never enters the sandbox.

The coding agent is a LangGraph loop in the trusted backend. It profiles and searches the repo, asks Gemini for one strict JSON action at a time, validates the tool and arguments, applies deterministic policy, and executes only registered operations in the sandbox. Edits produce new workspace revisions, and verification checks are bound to the final revision.

When the change is ready, the sandbox exports only a patch. Trusted backend code checks paths, limits, secrets, base commit, approval requirements and recorded check results. Then a separate GitHub gateway reapplies the patch to the pinned base and creates blobs, a tree, a commit and a `nimbus/...` branch through GitHub's Git Data API. Another narrow token opens or finds the pull request. Nimbus never merges.

Live progress uses MongoDB as an ordered event outbox, Redis Pub/Sub for fan-out, and authenticated WebSockets for the UI. The client first loads a snapshot and then subscribes from its last sequence, so reconnects can replay missed events. The design's main strength is separation: the model proposes, trusted code decides, the sandbox executes without credentials, and only validated output reaches GitHub.

## 20. Best reading order for a beginner

Read in this order and keep the application flow in mind:

1. `README.md` — product behavior and operational overview.
2. `docs/architecture.md` — trust zones and primary flow.
3. `apps/web/src/App.tsx` — every user-facing gate.
4. `apps/web/src/screens/Dashboard.tsx` — where a task starts.
5. `apps/api/src/http/routes/sessions.ts` — HTTP boundary.
6. `apps/api/src/sessions/service.ts` — durable session creation rules.
7. `apps/api/src/orchestrator/orchestrator.ts` — how a worker owns work.
8. `apps/api/src/orchestrator/live-workshop.ts` — how one run is assembled.
9. `apps/api/src/agent/graph/graph.ts` — the agent lifecycle.
10. `apps/api/src/agent/nodes/reason.ts` and `registry/tools.ts` — model-to-tool contract.
11. `apps/api/src/orchestrator/runner.ts` — outcomes and delivery.
12. `apps/api/src/push/gateway.ts` — real commit creation.
13. `apps/api/src/events/*` and `apps/web/src/sessions/live.ts` — live updates.
14. `docs/security.md` and `docs/threat-model.md` — why the controls exist.

When reading any module, ask four questions:

1. What untrusted input enters here?
2. What is validated before it is used?
3. What durable state changes?
4. What happens if this operation is retried or the process crashes halfway through?

Those four questions cover most FDE/SDE/AI-engineering interview discussion around this project.

## 21. Deep technology decisions: what, why, where, how, tradeoffs and alternatives

This section goes deeper than “we used tool X.” In an interview, naming a library is not enough. A good answer explains the problem it solves, what part of the system owns it, what it does not solve, and what would make you replace it.

### 21.1 LangGraph

#### What is it?

LangGraph is a library for representing an AI workflow as a graph of stateful steps. A normal function often looks like `input -> output`. An agent is more like:

```text
understand -> choose action -> run action -> inspect result
                         ^                    |
                         |____________________|
```

The loop may stop, retry, ask for approval or take a different path. A graph makes those transitions explicit.

#### Where is it used?

- `apps/api/src/agent/graph/graph.ts` builds the workflow.
- `apps/api/src/agent/graph/run.ts` starts a graph run.
- `apps/api/src/agent/graph/limits.ts` defines graph limits.
- `apps/api/src/agent/nodes/*` contains steps such as scoping, reasoning, execution and review.
- `apps/api/src/agent/state/*` defines the state carried between those steps.

The broad path is:

```text
clone -> scope -> retrieve -> reason -> execute -> review
                                  ^         |
                                  |_________|
                                           |
                                        complete
```

The exact branch depends on the model's proposed action, tool result, remaining budget, approval state and whether verification has passed.

#### How does it work here?

The graph state is a typed object. It contains the task, repository profile, gathered evidence, plan, tool history, files read and changed, checks, failures, budgets and workspace revision. A node receives that state, performs one bounded responsibility and returns an update. The graph decides the next node from code-defined rules.

The language model does not dynamically invent graph nodes. It proposes a registered action. Nimbus parses and validates that action, executes it through trusted code, adds the observation to state and loops back to reasoning.

This separation matters:

- LangGraph controls the reasoning workflow.
- The tool registry controls which capabilities exist.
- Policy code controls whether an action is allowed.
- The sandbox performs repository operations.
- The orchestrator owns worker scheduling, leases and recovery.

LangGraph is therefore not Nimbus's job queue and not its distributed lock system.

#### Why use it?

- The workflow has loops and conditional branches.
- State shared by all nodes has a clear schema.
- Adding a review, approval or recovery branch is easier than growing one giant `while` loop.
- Individual nodes can be tested with fake state and fake dependencies.
- The graph is readable during interviews and debugging.

#### Tradeoffs

- A graph adds concepts and library-specific APIs that a beginner must learn.
- State can become a giant “everything object” if boundaries are not maintained.
- Debugging a transition is less direct than stepping through a short function.
- A graph run is still in-process. If the process and sandbox disappear, LangGraph alone cannot reconstruct the filesystem.
- Checkpointing graph state is not the same as checkpointing the actual repository workspace.
- Too many tiny nodes produce ceremony; too few nodes recreate a giant function.

#### Alternatives and why they were not used

| Alternative                     | Good at                                  | Why Nimbus did not choose it for V1                                                                                                                               |
| ------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hand-written loop/state machine | Small, linear agents with few branches   | Initially simpler, but reasoning, tool execution, review, approval and completion transitions become hard to inspect and test as the agent grows.                 |
| XState                          | UI and application finite-state machines | Strong option, but less focused on LLM/tool workflows and agent state composition. It could still work.                                                           |
| BullMQ                          | Redis-backed background jobs and retries | Good replacement for parts of the worker queue, but it does not describe the inner reasoning loop.                                                                |
| Temporal/Durable Functions      | Durable, replayable business workflows   | Much stronger distributed durability, but adds infrastructure and deterministic-workflow rules. It still cannot magically recover a destroyed sandbox filesystem. |
| A provider agent SDK/API        | Managed model and tool loop              | Reduces custom harness code, but changes provider ownership, billing, tool interfaces and some security boundaries.                                               |

The honest conclusion is not “LangGraph is always better.” It is better here because the inner run is a branching agent loop. Temporal could later own the outer durable workflow while LangGraph continues to own reasoning.

### 21.2 Redis

#### What is it?

Redis is an in-memory data store with fast atomic operations and expiration. Nimbus uses it for short-lived coordination, not as the permanent database.

#### Where is it used?

- `apps/api/src/redis/client.ts` creates the client.
- `apps/api/src/redis/keys.ts` standardizes key names.
- `apps/api/src/redis/lease.ts` owns worker leases and heartbeats.
- `apps/api/src/redis/idempotency.ts` rejects duplicate work.
- `apps/api/src/redis/rate-limit.ts` implements request limits.
- `apps/api/src/redis/nonce.ts` stores one-time values.
- `apps/api/src/redis/scripts.ts` contains atomic Lua operations.
- `apps/api/src/events/*` uses Redis Pub/Sub for live event fan-out.
- Authentication and OAuth code use it for sessions, temporary OAuth state and one-time codes.

#### What does it store?

Examples include:

- Browser login sessions with expiration.
- Google/GitHub OAuth state, PKCE material and replay protection.
- OTP challenges.
- Rate-limit counters.
- “Worker X owns session Y until time T” leases.
- Heartbeat/liveness information.
- Cancellation signals.
- Webhook and request idempotency markers.
- Live Pub/Sub notifications.

Durable user, installation, session, message and event history belongs in MongoDB. If Redis is flushed, Nimbus may lose temporary sessions or coordination, but it should not lose the durable record of what happened.

#### Why use it?

- Key expiration is precise and automatic.
- Commands are fast and atomic.
- Lua scripts can check-and-update several values as one operation.
- Pub/Sub can notify all API instances with low latency.
- It works across multiple backend processes, unlike an in-memory JavaScript map.

#### Tradeoffs

- It is another service to operate, secure, back up where appropriate and monitor.
- Pub/Sub is not durable: an offline subscriber misses a notification. Nimbus handles this by keeping the real event in MongoDB and replaying it later.
- Incorrect TTLs can log users out early or leave locks alive too long.
- A Redis outage affects login, rate limits, leases and live updates even though durable data remains.
- Redis Cluster adds key-slot and operational complexity.

#### Alternatives

- **MongoDB only:** fewer services, but TTL cleanup is not exact enough for a tight lease protocol, and atomic lock/heartbeat patterns are more awkward. Fine for a very small prototype.
- **PostgreSQL advisory locks:** strong when PostgreSQL is already the source of truth. Locks are tied to database connections and do not directly replace expiring auth state or Pub/Sub.
- **In-memory maps:** easiest locally, but fail on restart and cannot coordinate two API instances.
- **Kafka/NATS:** excellent event streaming, replay and high throughput. They do not naturally replace short-lived key/value state and are excessive for V1's scale.
- **BullMQ:** useful for a richer Redis-backed job queue; it may replace the custom polling/claim layer later, but Redis would still exist underneath it.

### 21.3 E2B

#### What is E2B?

E2B provides on-demand isolated Linux sandboxes through an SDK. Nimbus can create a fresh environment, write files, run commands, read results and destroy the environment without running untrusted repository commands inside the API server.

E2B documents each sandbox as an isolated Firecracker microVM with its own kernel and says sandbox data is destroyed when the sandbox ends. See [E2B sandbox documentation](https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox) and [E2B security](https://e2b.dev/security).

#### Where is it used?

- `apps/api/src/sandbox/provider.ts` defines Nimbus's provider-neutral sandbox interface.
- `apps/api/src/sandbox/factory.ts` selects the fake or E2B implementation.
- `apps/api/src/sandbox/e2b-client.ts` defines the E2B client boundary.
- `apps/api/src/sandbox/e2b-live-client.ts` calls the real E2B SDK.
- `apps/api/src/sandbox/e2b-provider.ts` enforces Nimbus workspace, command and export rules.
- `apps/api/src/sandbox/e2b-fake-client.ts` supports deterministic tests.

#### Exact flow

1. The orchestrator claims a queued session.
2. The backend resolves the selected repository and pins a commit SHA.
3. It asks the sandbox provider to create an isolated environment.
4. The trusted backend reads the repository tree/blobs from GitHub and writes allowed files through E2B's file API.
5. The agent invokes Nimbus tools.
6. Tool executors translate approved operations into E2B file or command calls.
7. Command output is bounded and returned as an observation.
8. At completion, Nimbus exports a bounded patch rather than trusting the sandbox with GitHub credentials.
9. The sandbox is killed; a sweeper handles abandoned environments.

The E2B API key remains in backend memory. GitHub and Gemini keys are not placed in the sandbox. Internet access is disabled by Nimbus's sandbox configuration for normal runs.

#### Why E2B?

- Stronger isolation than executing code in the API process.
- No need for this team to build a microVM control plane immediately.
- A clear SDK for creation, file access, commands and destruction.
- One disposable environment per coding task.
- The provider interface keeps most of the agent unaware of E2B details.

#### Tradeoffs

- Cost per sandbox and startup time.
- Vendor dependency and service availability.
- Data residency/compliance questions because repository content enters a third-party environment.
- Provider quotas can cap concurrency.
- Debugging remote environments is harder than local Docker.
- A sandbox crash loses uncommitted filesystem state unless Nimbus has exported a checkpoint.

#### Could Docker containers be used instead?

Yes. `SandboxProvider` exists precisely so another implementation can be added. A `DockerSandboxProvider` could:

1. Start one container per session from a pinned, immutable image.
2. Give it a unique writable workspace volume.
3. Copy repository files into that workspace.
4. Execute commands with CPU, memory, PID, time and output limits.
5. Export a patch.
6. Force-stop and remove the container and volume.

But simply calling `docker run` is not a production security design. Repository code is attacker-controlled. A safer version needs:

- A non-root user and preferably rootless Docker.
- No Docker socket inside the container.
- No host directory containing source, credentials or configuration mounted into it.
- A read-only root filesystem with one isolated writable workspace.
- Dropped Linux capabilities, `no-new-privileges` and a strict seccomp/AppArmor/SELinux profile.
- Network disabled by default, or a controlled egress proxy with an allowlist.
- CPU, memory, process, disk, command-time and output limits.
- Per-session names, cleanup on every exit and an orphan sweeper.
- gVisor, Kata Containers or Firecracker if stronger isolation is required.

Normal containers share the host kernel. A kernel/container-runtime escape can have a larger blast radius than one microVM per task. For a local prototype, Docker is cheaper and easier. For hostile multi-tenant workloads, E2B outsources a large and difficult security/operations problem. Kubernetes Jobs improve scheduling but do not automatically create a strong hostile-code boundary; they still need the controls above.

### 21.4 GitHub App

#### What is it?

A GitHub App is an integration installed on an account or organization. The owner chooses which repositories the app may access. Nimbus signs an app JWT, exchanges it for a short-lived installation token and requests only the permissions needed for a phase.

#### Where is it used?

- `apps/api/src/http/routes/github.ts` exposes setup, callback and repository endpoints.
- `apps/api/src/github/app-jwt.ts` signs the app JWT.
- `apps/api/src/github/token-provider.ts` creates installation tokens.
- `apps/api/src/github/installation-service.ts` validates and stores installation metadata.
- `apps/api/src/github/repositories.ts` lists accessible repositories.
- `apps/api/src/github/webhook-service.ts` processes signed webhook deliveries.
- `apps/api/src/db/models/github-installation.ts` stores installation records, not a permanent installation access token.

#### Why a GitHub App rather than a PAT?

| Concern              | GitHub App                                     | Personal access token                                                                |
| -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------ |
| Identity             | The product/bot acts as itself                 | Actions are tied to a human token                                                    |
| Lifetime             | Installation tokens are short-lived            | PATs are often long-lived until rotated/revoked                                      |
| Repository scope     | Owner selects repositories during installation | Classic PATs can be broad; fine-grained PATs improve this but are still user-managed |
| Permissions          | Fine-grained app permissions                   | Depends on PAT type and user choices                                                 |
| Revocation           | Uninstall/suspend centrally                    | User must find and revoke/rotate token                                               |
| Events               | First-class signed webhooks                    | No equivalent installation lifecycle by itself                                       |
| Organization control | Admin can approve/manage the app               | PAT policies and approval differ by organization                                     |

Nimbus is a multi-user service acting repeatedly in repositories, so an app matches the product identity and repository-installation lifecycle better.

#### Tradeoffs and when a PAT is reasonable

A GitHub App is harder to build. It needs manifest/settings, private-key protection, JWT creation, installation callbacks, webhooks, permission checks and multiple token scopes. A PAT is faster for a personal CLI, a hackathon demo or a self-hosted single-user tool. Fine-grained PATs are much safer than classic PATs.

Nimbus avoids PATs because it would otherwise retain a long-lived user credential, make rotation/support the user's burden, blur bot versus human actions and lose the clean install/uninstall webhook model. The app is not universally superior; it is superior for this SaaS trust model.

#### Important callback/webhook distinction

The setup callback and webhook are not the same request:

- The **setup callback** is a browser redirect after installation. Nimbus binds the returned installation to the logged-in browser and then redirects to the dashboard.
- A **webhook** is a server-to-server signed event about installation/repository changes. It may arrive before, during or after the browser redirect. Nimbus treats it as independently retryable and idempotent.

The selected repositories are ultimately resolved from the installation through GitHub and represented by installation/repository metadata. Nimbus does not trust a repository name typed by the browser.

### 21.5 WebSockets

#### What are they?

A WebSocket upgrades one HTTP connection into a persistent two-way channel. Either side can send a message without opening a new request.

#### Where are they used?

- `apps/api/src/events/*` stores, publishes, authorizes and serves session events.
- `apps/api/src/server.ts` wires the WebSocket server into HTTP.
- `apps/web/src/sessions/live.ts` connects, subscribes, tracks sequence numbers and reconnects.
- `apps/web/src/screens/Session.tsx` turns those events into chat and right-panel state.

#### Exact live-update flow

1. A worker reports progress through the event reporter.
2. Nimbus first persists a sequenced event in MongoDB.
3. It publishes a lightweight notification through Redis Pub/Sub.
4. Every interested API instance learns that a new event exists.
5. The authorized WebSocket server pushes it to subscribed clients.
6. The browser applies the event to local state.
7. If disconnected, the browser reconnects with its last sequence.
8. The server replays later events from MongoDB, then resumes live delivery.

This means WebSocket/Redis provides speed, while MongoDB provides correctness and replay.

#### Why WebSockets instead of polling?

Polling repeatedly asks “anything new?” It is easy to build but introduces a latency/load tradeoff. Poll every 10 seconds and the UI feels slow; poll every 500 ms and thousands of idle clients create unnecessary requests and database reads. Streaming tool output also becomes awkward.

Polling remains a good fallback for very small products, corporate proxies that block upgrades or screens where updates are rare.

#### Why WebSockets instead of SSE?

Server-Sent Events are an excellent alternative. SSE is one-way server-to-browser streaming over normal HTTP, has simple text framing and native reconnection semantics. Because current task creation, chat messages and approvals can be ordinary HTTP requests, Nimbus could use SSE today.

WebSockets were chosen because the client already needs dynamic subscribe/unsubscribe messages, may watch different sessions, and can later send steering/approval messages over the same channel. It also handles arbitrary message shapes cleanly.

The tradeoff is that WebSockets are operationally harder: long-lived connections, proxy timeouts, heartbeats, backpressure, reconnect logic, authentication refresh and multi-instance fan-out all need care. If Nimbus stays mostly server-to-client, SSE may actually be the simpler future choice. “WebSockets are always better” would be a poor interview answer.

### 21.6 Octokit

#### What is it?

Octokit is GitHub's JavaScript/TypeScript SDK. It wraps GitHub REST endpoints, request authentication, errors and response types.

#### Where is it used?

- `apps/api/src/push/octokit-git-data.ts` calls Git Data APIs for blobs, trees, commits and references.
- `apps/api/src/pull-request/octokit-client.ts` creates/finds pull requests.
- GitHub token and directory modules create scoped clients for repository reads and installation operations.

#### How is a commit made without `git push`?

1. Nimbus obtains the pinned base commit and its tree.
2. It validates the sandbox patch.
3. It creates Git blobs for changed file contents.
4. It creates a new tree pointing at those blobs and retaining unchanged entries.
5. It creates a Git commit whose parent is the pinned base.
6. It creates or reconciles a non-default `nimbus/...` branch reference.
7. It opens or finds the pull request.

Those are GitHub API operations made by trusted backend code. Octokit is not a Git executable, an agent framework or an authentication strategy; it is the typed HTTP client used after Nimbus has obtained the right installation token.

#### Alternatives

- **Raw `fetch`:** fewer dependencies but much more repeated URL, auth, pagination, error and typing code.
- **`simple-git`/Git CLI:** natural for local clone/commit/push, but the environment would need Git credentials and a complete repository clone. That weakens Nimbus's credential-free sandbox boundary.
- **libgit2 bindings:** powerful but adds native dependency complexity and still needs authenticated transport.
- **GitHub GraphQL API:** excellent for querying connected metadata, but REST Git Data endpoints map more directly to blob/tree/commit/ref mutations.

### 21.7 Agent orchestration

#### What does “orchestration” mean?

The agent graph decides the next reasoning step inside one run. Orchestration decides which run is allowed to execute, on which worker, for how long and what happens after a crash.

#### Where is it used?

- `apps/api/src/orchestrator/orchestrator.ts` polls/claims work and enforces concurrency.
- `apps/api/src/orchestrator/claim.ts` owns session claims.
- `apps/api/src/orchestrator/liveness.ts` checks that the lease is still owned.
- `apps/api/src/orchestrator/cancellation.ts` handles cancellation.
- `apps/api/src/orchestrator/live-workshop.ts` assembles real dependencies for a run.
- `apps/api/src/orchestrator/runner.ts` runs the session and delivers its outcome.
- `apps/api/src/orchestrator/recovery.test.ts` and related tests cover failure behavior.
- `apps/api/src/orchestrator/limits.ts` currently sets a global concurrency of `2`, a 45-second lease and a 15-second heartbeat.

#### Exact flow

1. A session is durably created as queued in MongoDB.
2. An orchestrator process finds claimable work.
3. It obtains a Redis lease for the session.
4. It changes durable state to running and starts heartbeats.
5. It assembles repository, provider, sandbox, agent, reporter and GitHub gateways.
6. The runner executes the agent.
7. Before dangerous external writes, liveness code verifies the worker still owns the lease.
8. Progress is written as durable events.
9. Success/failure/cancellation is stored, cleanup runs and the lease is released.
10. If the process dies, the lease expires. A later worker may recover the durable session, within a bounded recovery count.

#### Tradeoffs and alternatives

The custom orchestrator is small, explicit and closely matches Nimbus's domain. It avoids introducing another platform. The cost is that Nimbus owns distributed-systems correctness: fairness, duplicate claims, heartbeats, poison jobs, backoff, crash recovery, deployments and observability.

- **BullMQ:** easier Redis job queues, retries and worker concurrency; less custom code. It still needs session-domain state, idempotent side effects and sandbox recovery.
- **Temporal:** durable timers, retries, workflow history and signals; ideal as complexity grows. It is a major operational and programming-model commitment.
- **Kubernetes Jobs:** strong scheduling and resource isolation; weak as the sole product workflow engine because messages, approvals and retries still need durable application state.
- **Cloud queues such as SQS/Pub/Sub:** reliable delivery and scale; visibility timeouts and at-least-once delivery still require idempotent business logic.

## 22. How testing actually works

“The AI tested it” does not mean the AI opened every screen like a human. Most software tests call code directly under controlled conditions.

### 22.1 Test tools and layout

Nimbus uses **Vitest** as the test runner. `vitest.config.ts` defines two projects:

- `unit`: tests under `apps/*/src` and `packages/*/src`.
- `integration`: tests under `apps/*/test/integration`, run sequentially with a 30-second timeout.

Useful commands from `package.json` are:

```text
pnpm test              unit tests
pnpm test:integration  integration tests
pnpm test:all          both groups
pnpm typecheck         TypeScript validation
pnpm lint              code-quality rules
pnpm build             production compilation
```

The repository also declares `pnpm test:e2e` as `playwright test`, but the current root dependencies/configuration do not show a fully wired Playwright browser suite. Do not claim that real browser end-to-end login is comprehensively tested until that suite is installed, configured and running in CI.

### 22.2 What is a fake and why use one?

A fake implements the same interface as a real dependency but behaves predictably in memory. For example, a fake Google provider can say “this authorization code belongs to verified@example.com” without visiting Google.

Fakes make tests fast, repeatable and safe. They can force rare failures such as expired OAuth state, a lost lease or a GitHub conflict. Their weakness is that they may not perfectly match the real vendor. That is why a mature system uses a testing pyramid:

```text
many unit tests -> fewer integration tests -> a small number of real end-to-end tests
```

### 22.3 How login is tested

`apps/api/test/integration/google.test.ts` uses a fake Google identity provider with real Nimbus service and storage logic. It tests cases such as:

- OAuth state and PKCE binding.
- Callback code exchange.
- Creating a user or linking an existing user.
- Refusing reused state.
- Refusing a callback from the wrong browser session.
- Refusing an unverified email.
- Writing audit records.

HTTP route tests use **Supertest**. Supertest sends HTTP-like requests directly into the Express app without needing a browser or fixed network port. Tests inspect status, JSON, redirects, cookies and CSRF behavior.

What this proves: Nimbus's code handles valid/invalid callbacks correctly. What it does not prove: Google's real login page still looks/behaves the same, browser popup/cookie settings work in every browser, or production redirect URLs are configured correctly. A Playwright test against a test identity environment or a manual smoke test is needed for that.

### 22.4 How GitHub is tested

GitHub tests use fake directory/token providers and signed sample webhook payloads. They check repository filtering, permissions, installation ownership, token caching, webhook signature validation, replay/idempotency and lifecycle updates.

Push and PR tests replace Octokit with a fake client. They verify the sequence of blobs, tree, commit, branch and PR operations, including retries and conflicts, without creating real public pull requests.

`apps/api/test/manual/github-write-live.ts` is a deliberately manual live check. With explicit test credentials it can exercise the real GitHub API. Keeping that separate prevents normal unit tests from changing a real repository.

### 22.5 How sessions and workers are tested

`apps/api/src/sessions/service.test.ts` tests session creation rules with in-memory records. `apps/api/test/integration/sessions.test.ts` and `session.test.ts` use real MongoDB/Redis test infrastructure.

`packages/test-utils` creates a randomized Mongo database and selects an isolated Redis logical database. Tests clean those resources afterward, so two suites do not reuse normal development data.

Session tests verify:

- Authentication/ownership.
- Idempotent creation.
- Repository and provider prerequisites.
- The one-active-session-per-user conflict.
- Message/follow-up behavior.
- State transitions and durable records.

Orchestrator tests start fake workshops/runners around real or in-memory coordination. They deliberately simulate:

- Two workers trying to claim the same session.
- Heartbeats and lease loss.
- Cancellation.
- A crash followed by recovery.
- Maximum concurrency.
- Duplicate push/PR delivery.
- Waiting/approval timeout cleanup.

The AI “runs a session” in a test by constructing the same runner with fake model, sandbox and GitHub adapters. The fake model returns a predetermined tool call, the fake sandbox records files/commands, and assertions verify the outcome. No paid model call or cloud sandbox is necessary.

### 22.6 How live updates are tested

`apps/api/test/integration/event-stream.test.ts` starts a real local HTTP/WebSocket server on a random port and uses real Mongo/Redis test stores. It checks:

- Cookie/origin authentication.
- Session ownership.
- Invalid client messages.
- Ordered event sequences.
- Replay after a given sequence.
- Live delivery through Redis.
- Concurrent event writes.

This is more realistic than a pure unit test, but it still runs on one machine. Production load tests should add thousands of connections, forced disconnects, Redis failover, slow consumers and multi-instance deployment.

### 22.7 How E2B and Gemini are tested

Most tests use `e2b-fake-client.ts` and HTTP stubs for Gemini. They verify command boundaries, timeouts, file rules, request format, model JSON parsing, retries, truncation and error mapping.

Manual scripts such as `apps/api/test/manual/e2b-live.ts`, `llm-live.ts` and `agent-live.ts` can call real paid services when credentials are intentionally supplied. They are not normal automated tests because they cost money, can be flaky and depend on external quotas.

### 22.8 What should be added

1. Install/configure Playwright and run a real browser journey: sign in, connect a test GitHub App installation, choose a test repo, submit a task, watch events and see a PR.
2. Use test-only Google/GitHub accounts and repositories—never personal production accounts.
3. Add contract tests against recorded/sanitized vendor responses.
4. Run a small scheduled live smoke suite for E2B/Gemini/GitHub.
5. Add load/chaos tests for leases, WebSockets and recovery.
6. Make CI publish test, coverage, lint, typecheck and build results.

## 23. Parallel sessions and multi-agent work

### 23.1 What the current limit really is

Nimbus does not globally run only one session. `apps/api/src/orchestrator/limits.ts` permits two concurrent runs for the whole worker process by default. However, MongoDB has a partial unique index named `session_one_active_per_user`, and `SessionService` calls `findActive(userId)` and returns `ACTIVE_SESSION_EXISTS`. Therefore one user can have only one active session, while two different users can run at the same time.

This was a V1 safety/product decision. It caps E2B/model spend, avoids confusing UI state and reduces concurrency bugs while the session lifecycle is being proven.

### 23.2 Letting one user run several independent tasks

This is not just deleting one `if` statement. A safe design would:

1. Replace the unique per-user active index with normal indexes for querying active sessions.
2. Remove the `findActive` hard rejection.
3. Add explicit quotas such as `maxActivePerUser`, `maxActivePerOrganization` and a global capacity limit.
4. Use an atomic admission counter/transaction so two simultaneous requests cannot exceed the quota.
5. Change API/UI fields such as one `activeSessionId` into an active-session list/count.
6. Let the dashboard composer start another task and show a queue/capacity state.
7. Keep a completely separate sandbox, lease, event sequence, budget and cancellation key per session.
8. Schedule fairly so one user cannot fill every worker slot. A round-robin or weighted queue by user/organization is better than pure oldest-first at scale.
9. Enforce provider, GitHub installation and E2B concurrency/rate limits.
10. Track cost and give the user per-session/global cancellation.

Independent tasks on different branches are straightforward. Two sessions changing the same repository/base can both finish, but their PRs may conflict. Nimbus should warn about overlapping files and always use unique branches.

### 23.3 Devin-style subagents inside one task

Parallel sessions are not the same as several agents collaborating on one task. A multi-agent design needs a coordinator:

```text
user task
   |
planner/coordinator
   |---- research agent
   |---- implementation agent A
   |---- implementation agent B
   |---- test/review agent
   |
merge/conflict resolver -> final verifier -> one PR
```

Required pieces include:

- A task DAG: dependencies and which jobs may run in parallel.
- Separate sandboxes or Git worktrees so agents do not overwrite each other.
- Explicit ownership of files/modules where possible.
- Artifact exchange through patches and structured summaries, not shared mutable chat alone.
- A merge stage that applies patches in order and resolves conflicts.
- A final test/review pass on the combined workspace.
- Parent and child budgets, cancellation propagation and trace IDs.
- A rule that only one trusted publisher creates the final branch/PR.

More agents do not automatically improve quality. They multiply model cost, duplicated exploration, merge conflicts and nondeterminism. Start with parallel read-only research/check agents, measure improvement with evals, then allow parallel writers on disjoint files.

## 24. Gemini API key: exact trust and data flow

### 24.1 Do we store the key?

Yes. Nimbus V1 stores it encrypted, not plaintext.

The flow is:

1. The browser sends the key over HTTPS to the provider-key endpoint.
2. `apps/api/src/llm/provider-keys.ts` validates the shape and performs a live provider verification.
3. `apps/api/src/lib/secret-box.ts` encrypts it with AES-256-GCM.
4. The encryption key is derived on the server from `SESSION_SECRET`; associated data binds the ciphertext to the user and provider.
5. `apps/api/src/db/models/provider-key.ts` stores ciphertext, IV, authentication tag, a safe display hint and timestamps.
6. The raw key is not returned to the browser after saving.

### 24.2 Can Nimbus access it?

Yes. The backend must decrypt it to call Gemini. A stolen database without the server secret should not reveal the key, but a malicious server operator or an attacker controlling both the application and its encryption secret can decrypt it.

That makes this **encrypted at rest**, not end-to-end encrypted and not zero-knowledge. Claiming “we cannot access your key” would be false for the present architecture.

### 24.3 How is the key passed to the model?

When a worker starts a user's session:

1. The provider-key service loads the encrypted record.
2. It calls `SecretBox.open(...)` inside the trusted backend.
3. `UserProviders` constructs a `GeminiTextProvider` with the key in process memory.
4. `apps/api/src/llm/gemini-text.ts` sends an HTTPS POST to Gemini's `.../models/{model}:generateContent` endpoint.
5. The key is placed in the `x-goog-api-key` HTTP header.
6. The prompt contains task/repository context; the key itself is not inserted into the prompt.
7. The key is not sent to the browser again, written into the repository or placed in E2B.

The Gemini provider necessarily receives task/repository prompt data. Privacy documentation should state what may be sent and users should avoid attaching secrets.

### 24.4 How can a user trust Nimbus more?

Trust should come from controls and honest limits, not a sentence saying “trust us.” Improvements include:

- Tell users to create a separate Gemini project/key for Nimbus, not reuse a personal master key.
- Ask for the smallest provider permissions available and let users set spend/rate quotas.
- Show a key fingerprint, last-used time and one-click revoke/delete.
- Never log request headers or decrypted secrets; automatically redact key-shaped strings.
- Move encryption keys from a general app secret to KMS/HSM envelope encryption.
- Restrict decryption to a small isolated key service with RBAC and audited access.
- Rotate data-encryption keys without asking every user for a new provider key.
- Offer “do not save”: keep a key only in memory for one run. The tradeoff is that crash recovery/background runs require it again.
- Offer a user-controlled model proxy so Nimbus receives a temporary scoped token rather than the master provider key.
- Publish retention, incident-response and data-processing policies; commission security review.

Calling Gemini directly from the browser would hide the key from Nimbus's database but expose it to browser extensions/XSS and make server-side budgets, structured output, retries, auditing and background execution much harder. It is a possible local-only architecture, not a free security win.

### 24.5 Why not provide a central model list and bill by usage?

That is a strong product direction. Nimbus would hold organization-owned provider credentials, expose approved model choices and charge users based on measured usage.

It requires:

1. Provider contracts and production quotas.
2. A model catalog with capabilities, context limits and price versions.
3. Exact token/cost collection for every request.
4. An append-only usage ledger, not only mutable counters.
5. User/team budgets, hard limits and alerts.
6. Prepaid credits or subscriptions and a payment provider.
7. Reconciliation between Nimbus records and provider invoices.
8. Protection against abuse, stolen cards, free-trial farming and denial-of-wallet attacks.
9. Decisions about markup, refunds, failed requests, taxes, chargebacks and regional availability.
10. Privacy terms because Nimbus is now the direct model customer/data processor.

BYOK was likely chosen for V1 because it transfers model cost/quota to the user and avoids building a billing platform before validating the coding agent. Its downsides are poor onboarding, user distrust and inconsistent provider quotas. A mature product could support both: platform credits by default and BYOK for enterprise control.

## 25. Is Nimbus just a chatbot?

No, although it uses a chat interface.

A chatbot normally receives text and returns text. Nimbus can inspect a repository, select tools, read/write files, run commands, observe results, revise its plan, request approval, verify a change and produce a real GitHub pull request. The model is part of a loop connected to controlled actions. That is why it is called an agent.

It is also not an autonomous employee. Its autonomy is bounded by registered tools, policy, budgets, sandbox limits, approvals and the rule that a human reviews the PR.

### 25.1 Context management

The model cannot receive the entire repository and entire history on every call. Nimbus builds a bounded working context from:

- The current user task and acceptance criteria.
- A recent slice of the conversation stored in MongoDB.
- Repository profile and relevant retrieved files/snippets.
- The current typed plan.
- Recent tool calls and observations.
- Files read/changed and the current workspace revision.
- Test/check results and failures.
- Pending approvals.
- Remaining token, tool-call, time and cost budgets.
- Text/image descriptions extracted from attachments.

`apps/api/src/agent/prompt/*`, state modules, retrieval modules and reasoning nodes assemble this context. Large command/file output is truncated and repository content is treated as untrusted evidence, not as instructions with authority.

This is short-term task context. It lets the agent remember what happened earlier in the current session and make the next choice.

### 25.2 Does it have long-term memory?

Not in the personal-assistant sense. Durable sessions/messages exist, and a follow-up can use its conversation and PR context, but Nimbus does not currently build a cross-session memory such as “this user prefers pnpm” or “this team's release convention is X” and retrieve it for unrelated future tasks.

A safe future memory system should have:

- Explicit user/team opt-in.
- Scopes: session, repository, organization and personal.
- Provenance: where each memory came from and when.
- Confidence/expiry so old assumptions do not live forever.
- User view/edit/delete controls and retention rules.
- Secret and sensitive-data filters.
- Retrieval thresholds so irrelevant memories do not pollute prompts.
- A distinction between verified repository facts and model-generated guesses.

Memory can improve personalization and reduce repeated explanation, but stale or poisoned memory can silently make every later run worse.

## 26. Future scope

### 26.1 Evals

Tests ask whether deterministic software behaves as coded. Evals ask whether the AI system actually solves useful tasks well.

Build a versioned benchmark of pinned repositories and tasks such as bug fixes, small features, refactors and ambiguous requests. Do not score only exact patch text because several patches can be correct. Score:

- Required tests/acceptance behavior.
- Build/typecheck/lint results.
- Patch validity and unnecessary change size.
- Correct clarification when requirements are missing.
- Unsafe tool attempts, secret leakage and policy violations.
- PR description quality.
- Tokens, cost, latency, retries and tool calls.
- Success after model/provider/sandbox changes.

Add adversarial cases: prompt injection in source files, huge output, malicious package scripts, symlink/path attacks, flaky tests and contradictory instructions. Pin repo SHA, sandbox image, model version and configuration so regressions can be compared. Use automated graders where possible and human review for subjective code quality. Run evals before releases and canary new models on a small percentage of safe tasks.

### 26.2 Observability

Nimbus already has structured logs, request IDs, audit records, durable session events and model usage reports. Production observability should connect them into one trace per session:

```text
HTTP request -> queued -> claimed -> sandbox create -> clone
-> model call -> tool call -> check -> patch -> GitHub commit -> PR
```

Use OpenTelemetry traces plus metrics/dashboards for queue time, sandbox startup, clone time, model latency, token/cost, tool errors, check pass rate, lease loss, recoveries, WebSocket lag and PR success. Add SLOs and alerts. Every span should carry session/run IDs, but prompts, source code, keys and headers must be redacted by default. Observability without privacy controls becomes another data leak.

### 26.3 Connecting an OpenAI/Codex capability

Do not design this as “ask for the user's ChatGPT password/token.” A normal ChatGPT/Codex subscription is not automatically an API credential or transferable billing identity for a third-party SaaS.

Practical options are:

1. **OpenAI API BYOK:** let the user save an OpenAI API project key through the same protected provider-key path as Gemini. This uses the user's API project billing, not their ChatGPT subscription. The official API quickstart uses API keys for SDK/server authentication: [OpenAI API quickstart](https://developers.openai.com/api/docs/quickstart).
2. **Nimbus-managed OpenAI billing:** Nimbus uses its own API project and charges credits, using the centralized billing design above.
3. **OpenAI Agents API/Codex harness:** integrate the managed coding harness as another execution provider. OpenAI describes it as managing durable sessions, orchestration, context compaction and recovery while the application supplies tools and environment. It has API/model/sandbox billing: [Agents API overview](https://developers.openai.com/api/docs/guides/agents-api/overview). This would overlap with Nimbus's LangGraph/orchestrator and should be offered as an architectural provider, not casually layered inside every run.
4. **Enterprise workload identity federation:** in a managed ChatGPT workspace, an administrator can map a trusted workload to a ChatGPT user/service account. OpenAI documents this as an admin-enabled beta for trusted workloads, not a general consumer “Sign in with Codex” OAuth button: [Workload identity federation](https://developers.openai.com/api/docs/guides/workload-identity-federation).
5. **User-hosted local bridge:** a user runs Codex/another coding worker on their own machine and Nimbus sends signed jobs through a narrow bridge. Credentials stay local, but availability, networking, attestation, updates and support become much harder.

Before implementing, verify the current official OpenAI product/auth documentation. Do not scrape browser cookies or collect consumer session tokens.

### 26.4 Recommended roadmap order

1. Finish browser E2E tests and production telemetry.
2. Add evals so future improvements can be measured.
3. Add multi-session quotas/fair scheduling.
4. Add platform billing or another model provider behind the existing provider interface.
5. Add parallel read-only/reviewer agents, then carefully add parallel writers.
6. Add opt-in repository/team memory with deletion and provenance.
7. Evaluate Temporal/BullMQ and a second sandbox provider only when measured scale/reliability justifies the complexity.

The main engineering lesson is that every “smart” feature increases ordinary systems responsibilities. Parallel agents need scheduling and merging. Memory needs privacy and deletion. Central billing needs fraud and ledgers. More model providers need evals. Production AI engineering is mostly about making those boundaries reliable, observable and honest.
