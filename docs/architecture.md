# Nimbus V1 Architecture

## 1. What Nimbus does

An authenticated user connects a GitHub App installation, selects one public repository, and
describes a small coding task. Nimbus provisions an isolated cloud sandbox, clones the repository
anonymously at an immutable commit, and lets a language model propose one action at a time. Every
proposed action is authorized by deterministic application code before it executes. When the work
is done, the sandbox exports a patch with no credentials attached, the trusted backend validates
that patch, pushes a new branch, and opens a pull request for human review.

Nimbus never merges, approves, closes, or force-pushes a pull request, and never writes to a
repository's default branch.

## 2. Trust zones

The architecture is organized around a single question: where can a credential exist?

| Zone | Contents                             | Trust                    | Holds credentials                    |
| ---- | ------------------------------------ | ------------------------ | ------------------------------------ |
| Z0   | User's browser                       | Untrusted                | Opaque session cookie only           |
| Z1   | Nimbus API, orchestrator, gateways   | Trusted                  | Yes, all of them                     |
| Z2   | MongoDB, Redis, optional Qdrant      | Trusted, private network | Credentials to reach them live in Z1 |
| Z3   | E2B sandbox                          | Untrusted execution      | No, never                            |
| Z4   | GitHub, Groq, Gemini, SMTP           | External                 | Reached only from Z1                 |
| Z5   | Repository content, user attachments | Untrusted data           | Not applicable                       |

Z3 is the important one. The sandbox runs commands proposed by a language model against source code
written by strangers. Treating it as hostile is the design's foundation, not a precaution. It
receives no GitHub token, no database URI, no Redis URL, no SMTP password, no model provider key,
and no application session secret. If the sandbox is fully compromised, the attacker gets a
throwaway container holding a public repository that was already public.

## 3. Components

### apps/web

React single page application. Holds no bearer token. Authenticates with an opaque `HttpOnly`
cookie, calls the HTTP API for state changes, and receives live session updates over an
authenticated Socket.IO connection. Renders all model output, tool output, diffs, and repository
text as untrusted data.

### apps/api

The only component that holds secrets. Internally divided into:

- **HTTP API**: authentication, GitHub connection, session lifecycle, attachments.
- **Socket gateway**: authenticated handshake, per session rooms, sequenced events, replay on
  reconnect.
- **Agent orchestrator**: a LangGraph graph that advances one session at a time under a lease, with
  the session's status, step and activity written down as it goes so a worker that dies can be
  recovered from and counted.
- **Policy engine**: deterministic pre-execution authorization. Not a model. Not overridable by
  model output.
- **GitHub gateway**: App JWT creation, just in time installation tokens, patch validation, branch
  push, pull request creation.
- **Sandbox controller**: provisioning, bounded command execution, cancellation, teardown, orphan
  sweeping.
- **Provider adapters**: Groq for text, Gemini for image understanding, Nodemailer for mail, E2B for
  sandboxes. Each sits behind an interface with a fake implementation for local use and tests.

### Datastores

- **MongoDB** holds durable state: users, installations, sessions, repository index metadata, audit
  events, and the sequenced event log that makes reconnect replay possible.
- **Redis** holds only ephemeral, expiring state: hashed one time passwords, rate limit counters,
  OAuth and setup nonces, session advance leases, and idempotency keys.
- **Qdrant** is optional and off by default behind `ENABLE_SEMANTIC_SEARCH`.

## 4. Primary data flow

```text
Browser                Trusted backend              Sandbox              GitHub
   |                          |                        |                    |
   |-- start session -------->|                        |                    |
   |                          |-- provision ---------->|                    |
   |                          |-- clone public repo -->|                    |
   |                          |   (anonymous, no token)|                    |
   |                          |                        |                    |
   |                          |<-- retrieval context --|                    |
   |                          |                        |                    |
   |                     [model proposes one action]   |                    |
   |                          |                        |                    |
   |                   [deterministic policy check]    |                    |
   |<-- approval required ----|                        |                    |
   |-- approve (exact hash) ->|                        |                    |
   |                          |-- execute action ----->|                    |
   |<-- redacted events ------|<-- bounded output -----|                    |
   |                          |                        |                    |
   |                          |<-- patch, no creds ----|                    |
   |                     [validate patch in backend]   |                    |
   |                          |-- mint scoped token ------------------------>|
   |                          |-- push nimbus/<id> branch ----------------->|
   |                          |-- create pull request --------------------->|
   |<-- pr.created -----------|                        |                    |
   |                          |-- terminate ---------->|                    |
```

The two arrows that never exist: the sandbox never talks to GitHub, and the sandbox never talks to
the datastores.

## 5. Session state machine

```text
queued -> provisioning -> indexing -> working
                                        |
                    +-------------------+-------------------+
                    |                   |                   |
              awaiting_user        validating           failed
                    |                   |
                    +--> working        +--> pushing -> pr_created

cancelled is reachable from any non-terminal state.
Terminal states: pr_created, failed, cancelled.
```

Status is persisted durably before any event is emitted. A crash between the write and the emit
loses an event, which replay recovers. The reverse order would let the UI show a state the server
never reached.

## 6. Concurrency and durability

- One active session per user, enforced atomically on the server with a lease, not in the UI.
- Only one worker advances a session at a time, guarded by a Redis lease with renewal.
- Every external effect is idempotent: branch creation, push, pull request creation, and email.
- Taking a session writes `working` before any work begins, and each finished action writes the step
  and what the run is doing, so the session document is true while a run is happening rather than only
  after it ends. Without that, a worker that dies leaves a session that reads as freshly queued and is
  retried forever.
- While waiting for a clarification or approval the sandbox is torn down, and resuming rebuilds it from
  the verified remote state. The question, the answer, and the steps already spent are carried across.
  The files a previous attempt read or changed are deliberately not carried across, because they lived
  in a machine that no longer exists and claiming otherwise would make the agent skip work.
- Recovery is bounded. A session found in one of the statuses a run passes through was left behind by a
  worker, and each such pickup is counted. Past the ceiling the session fails, is announced, and is
  posted, rather than being retried by every worker forever. A session waiting for a person is not a
  recovery however many times it is answered.
- The step count never goes backwards, so a short second attempt cannot erase what a long first attempt
  spent, and four crashes cannot cost four full budgets.
- `MongoCheckpointSaver` implements the LangGraph checkpoint interface and is deliberately not wired
  in. A graph checkpoint refers to a sandbox filesystem, and the sandbox does not survive the worker,
  so resuming the graph would hand the agent an empty machine while its state said a patch had already
  been applied. Recovery is therefore explicit at the session level rather than implicit in the graph.
- A local commit inside a sandbox is not durable. Only material exported to the backend counts.
- Session events carry a monotonically increasing sequence number so a reconnecting client can ask
  for everything after `lastEventSequence`.

## 7. Retrieval

V1 ships lexical retrieval only: repository tree summary, path search, bounded ripgrep style
content search, and targeted file reads. Generated directories, vendor code, build output,
environment files, key material, and oversized or minified files are excluded by a documented
indexing policy.

Semantic retrieval through Qdrant stays behind `ENABLE_SEMANTIC_SEARCH` until benchmarks for cold
start memory, index time, and query quality pass. Every stored point carries immutable repository
id, commit SHA, path, chunk range, and policy version, and every query carries server owned filters
on those fields. Lexical V1 is never blocked on it.

Ranking weights each query term by how few of the scanned files contain it, so a word present
everywhere contributes nothing, and saturates each term's contribution so that matching several terms
beats matching one term loudly. File name and directory matches are separate signals, test files are
weighted down unless the task is about tests, and ties break on path so the same query is answered in
the same order every time. There is no persistent index: every query is a fresh bounded pass over the
workspace, because the agent edits files while it works.

All retrieved repository content is treated as quoted, untrusted data. It cannot change the system
prompt, the policy, the user's task, or the tool constraints. Each block is delimited by a marker
carrying a random value generated per bundle and verified absent from the content, so repository text
cannot close its own block and issue instructions outside it, and content that attempts to give
instructions is reported by code, path, and line without being quoted.

## 8. Model routing

Groq serves text and Gemini serves image understanding, both behind adapters with timeouts,
cancellation, retry with backoff, response schema validation, usage accounting, and safe error
mapping. An image is converted to a bounded textual description by the vision provider; the session
then continues on the selected text model. A session is never wholesale rerouted to a different
provider merely because it contains an image. Token and monetary budgets are tracked per session
and exhaustion stops the session safely rather than silently degrading it.

## 9. Shared contracts and versioning

`packages/contracts` is the single definition of every payload that crosses a boundary. Schemas are
written once in Zod and TypeScript types are inferred from them, so a validated value and its static
type cannot drift apart.

`CONTRACTS_VERSION` is a semantic version. The rules:

- **Major** changes when an existing payload shape changes incompatibly: a field is removed or
  renamed, a type narrows, an enum member is removed, or a required field is added.
- **Minor** changes when something purely additive appears: a new optional field, a new event type,
  a new error code, a new enum member on a field the client already treats as open.
- **Patch** changes when documentation or internal refinement changes nothing on the wire.

Separately, `CONTRACTS_WIRE_VERSION` is an integer carried in every socket envelope and every client
socket payload. It increments only on a breaking wire change. The package version is allowed to sit
below 1.0 while the wire version is already meaningful, and a receiver rejects a mismatched wire
version outright rather than guessing at the shape.

Three rules hold regardless of version: a field name is never repurposed for a different meaning, an
enum member's meaning is never redefined, and new behavior is expressed as a new event type rather
than by overloading an existing one.

Every object schema rejects unknown keys. Silently ignoring an unexpected field is how a client and
a server drift into disagreeing about what was sent.

## 10. Technology and why

| Choice                | Reason                                                                                    |
| --------------------- | ----------------------------------------------------------------------------------------- |
| pnpm workspaces       | Strict dependency isolation and a single lockfile across apps and packages                |
| TypeScript, strict    | Type errors at boundaries are the cheapest class of bug to prevent                        |
| Zod at every boundary | One definition drives both runtime validation and static types                            |
| Express and Socket.IO | Long-lived authenticated WebSockets with per-event authorization                          |
| LangGraph             | A graph whose nodes and edges are the agent loop, rather than one hand written while loop |
| MongoDB               | Document shaped session state with the indexes the access patterns need                   |
| Redis                 | Expiring state, atomic counters, and leases, none of which belong in the durable store    |
| E2B                   | Managed isolated execution behind a `SandboxProvider` interface with a local fake         |
| Vitest and Playwright | Fast unit and integration runs, plus a real browser journey                               |

## 11. Deployment shape

Nimbus runs long-lived WebSocket connections and durable background work. A host that sleeps
processes or terminates workers mid-session is incompatible with that, and a keep-awake ping is not
a fix. Either the production host supports durable long-running workers, or the worker is deployed
separately as its own durable process. This is documented as a constraint rather than worked
around.
