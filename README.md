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
MongoDB and Redis, so they are a separate project:

```bash
pnpm dev:services      # start MongoDB and Redis first
pnpm test:integration
pnpm test:all          # both projects
```

Each integration test file gets a randomly named MongoDB database and a numbered Redis database, and
wipes both afterwards, so your local `nimbus` data is never touched.

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

## Running the API

```bash
pnpm dev:services   # MongoDB and Redis
pnpm dev            # the API on http://localhost:4000, and the web client
```

`pnpm --filter @nimbus/api start` runs the compiled build instead of the watcher.

Startup connects to MongoDB, waits for a real ping, applies collection validators and indexes,
connects to Redis, and only then begins listening, so the server is never accepting requests it
cannot serve. Shutdown on `SIGINT` or `SIGTERM` stops accepting connections, lets in flight requests
finish, closes both databases, and exits, with a fifteen second cap.

| Route         | Answers                                                                     |
| ------------- | --------------------------------------------------------------------------- |
| `GET /health` | Whether the process is alive. Checks nothing else, names no dependency      |
| `GET /ready`  | Whether MongoDB and Redis respond. 200 or 503, with the reason in logs only |

Stopping a database does not stop the server. `/health` stays 200 while `/ready` turns 503, and
readiness returns to 200 on its own once the database comes back, with no restart.

Every response carries an `X-Request-Id` that also appears in the logs and in any error body, so a
user can report one value and you can find the exact request.

Every error, from every route, uses one shape:

```json
{
  "error": {
    "code": "STABLE_MACHINE_CODE",
    "message": "Safe message for the user",
    "requestId": "req_V1StGXR8Z5jdHi6BmyT"
  }
}
```

`code` is stable for programs to branch on. Messages are only ever ones Nimbus wrote; an unexpected
failure returns a generic message and keeps the detail in the logs, so a connection string or file
path can never reach a browser.

### Transport security

- **Exactly one allowed browser origin**, `WEB_ORIGIN`, compared as a whole string. Any other origin
  receives no `Access-Control-Allow-Origin` header at all. This is written directly rather than with
  the `cors` package, whose `origin: true` option reflects whatever origin asked and, combined with
  the credentials this API needs, would let any site make authenticated requests as your user.
- **`Content-Security-Policy: default-src 'none'`**, since a JSON API should load nothing from
  anywhere, plus `frame-ancestors 'none'`, `nosniff`, `X-Frame-Options: DENY`, and
  `Referrer-Policy: no-referrer`. HSTS is added in production only.
- **Explicit socket timeouts** for headers, body, and keep alive, so a slow client cannot hold
  connections open indefinitely.
- **JSON bodies capped at 100 KB**, returning `PAYLOAD_TOO_LARGE`.
- **`TRUST_PROXY_HOPS`** states how many proxies sit in front, defaulting to `0`. Trusting the whole
  `X-Forwarded-For` chain would let a client forge its own address and defeat per IP rate limiting.

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

## Short lived state

Redis holds everything that should expire on its own. MongoDB's expiry sweeper runs about once a
minute, which is too loose for a ten minute login code or a lock held by a worker that died.

| Primitive           | Used later for                     | Guarantee                                                        |
| ------------------- | ---------------------------------- | ---------------------------------------------------------------- |
| Typed store         | OTP records, session lookups       | Expiry is compulsory; values validated on write and read         |
| Rate limiter        | Login, uploads, agent work         | Token bucket, no window boundary to exploit, reports retry delay |
| Single use values   | Google and GitHub return trips     | `GETDEL`, so a value works exactly once                          |
| Leases              | One worker per session             | Holder checked on renew and release, self expiring               |
| Idempotency records | Branch push, pull request creation | Exactly one caller starts; others get the original result        |

Anything that reads, decides, then writes runs as a Lua script, because that gap is where the
concurrency bug lives. Redis executes a script as one uninterruptible unit.

Two properties are enforced rather than documented:

- **No key can be written without an expiry.** Redis runs with `noeviction`, so an unexpired key is
  never silently reclaimed; it accumulates until writes start failing. A test walks every key created
  by every primitive and asserts none lacks a time to live.
- **A lease can only be renewed or released by whoever still holds it.** Otherwise a stalled worker
  whose lease already expired would release its successor's lease and admit a third worker.

## Email

Nimbus picks a mail adapter from your settings at startup and says which one in the log.

| Adapter     | Chosen when                       | Behaviour                                 |
| ----------- | --------------------------------- | ----------------------------------------- |
| `smtp`      | SMTP settings are filled in       | Really sends                              |
| `console`   | SMTP is blank, outside production | Prints the whole message to your terminal |
| `capturing` | Tests                             | Keeps messages in memory                  |

That means **you can develop the whole login flow without an email account**. Leave SMTP blank and
the sign in code prints to your terminal. The console adapter throws if it is ever constructed in
production, and production already refuses to start without SMTP.

Three guarantees, each with tests:

- **Message bodies are never logged.** A sign in code in a log file is a password in a log file. Logs
  carry a masked recipient, the subject, and a byte count. Recipient addresses are masked to
  `a***@example.com` because an address is personal data.
- **Credentials never reach logs or error messages.** A mail server that echoes your password back in
  a rejection is a real thing; the raw error does contain it and redaction removes it before
  anything is written.
- **Addresses, subjects, and bodies are injection safe.** Carriage returns and line feeds are refused
  so nobody can add a `Bcc:` header through an address field, everything interpolated into HTML is
  escaped, and only `http` and `https` links become clickable.

Connections require STARTTLS unless already encrypted, so a server that will not upgrade gets no
credentials and no message at all rather than receiving them in the clear.

## Signing in

Nimbus has no passwords. You prove you control an email address.

```bash
curl -i -X POST http://localhost:4000/auth/otp/request \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com"}'
```

```json
{
  "requestId": "req_HrcHSBbyP3UHpFviJ02Xv",
  "expiresInSeconds": 600,
  "resendAvailableInSeconds": 60
}
```

An eight digit code arrives by email, or prints to your terminal if SMTP is blank.

Send it back to finish signing in:

```bash
curl -s -c jar.txt -X POST http://localhost:4000/auth/otp/verify \
  -H "Content-Type: application/json" \
  -d '{"requestId":"req_...","email":"you@example.com","code":"12345678"}'

curl -s -b jar.txt http://localhost:4000/auth/me
```

| Limit                                       | Value                         |
| ------------------------------------------- | ----------------------------- |
| Guesses per code                            | 5, then the code is destroyed |
| Codes per address per hour                  | 5                             |
| Codes per internet address per hour         | 20                            |
| Verifications per internet address per hour | 50                            |
| Wait between codes                          | 60 seconds                    |
| Code lifetime                               | 10 minutes                    |

Three properties are worth knowing about, each covered by tests:

- **Asking for a code cannot reveal whether an account exists.** The request path never reads the
  users collection. An account is created only when a valid code is proved, so there is nothing to
  branch on and nothing to leak. A stranger typing your address also cannot cause a record carrying
  it to exist.
- **Redis never holds the code.** It holds a keyed HMAC, bound to the request and the address, with
  the key derived from `SESSION_SECRET`. Eight digits is small enough to reverse a plain hash in
  seconds, so the server side key is what makes a stolen dump worthless. Comparison is constant time.
- **A code works exactly once.** The record is deleted at the moment it is accepted and the delete
  itself elects the winner, so ten simultaneous attempts produce one success and one account.

Codes never appear in logs or in the audit trail, and neither do email addresses.

## Signing in with Google

```text
GET /auth/google           sends the browser to Google
GET /auth/google/callback  finishes, sets the session cookie, redirects to the frontend
```

Both doors reach the same account. Signing in with Google using an address that already has a Nimbus
account adds `google` to that account rather than creating a second one.

- **Authorization code flow with PKCE.** The verifier stays on the server, so a captured code cannot
  be exchanged by anybody else.
- **State is single use and bound to the browser that started it.** A separate short lived cookie
  holds a random value whose hash is stored beside the state. Without both, the callback is refused
  before Nimbus talks to Google at all. This is what stops an attacker sending you a link that signs
  you into **their** account, which would quietly route everything you then do into it.
- **An address Google has not verified is refused outright.** It does not link and it does not create
  an account. A Workspace administrator can create an account claiming any address, so linking on an
  unverified one would be an account takeover.
- **Scopes are `openid email` and nothing else.** The display name is derived from the address, so
  `profile` would be collecting data with no use for it.

The ID token's issuer, audience, expiry, and verified flag are all checked. Its signature is not,
because it arrives directly from Google's token endpoint over TLS rather than through the browser,
which the OpenID Connect specification permits for this flow.

Leaving `GOOGLE_CLIENT_ID` blank is supported: both routes then answer `PROVIDER_UNAVAILABLE` and
email codes still work.

## Sessions

The session cookie holds a long random value and nothing else. Everything real lives in Redis, keyed
by a hash of that value, so a database dump is not a set of working sessions. A token carrying its
own claims could not be revoked; an opaque identifier can be deleted, and the moment it is, the
session is over.

| Route                   | Needs                                                 |
| ----------------------- | ----------------------------------------------------- |
| `POST /auth/otp/verify` | Nothing. Signs you in and sets the cookie             |
| `GET /auth/me`          | The cookie. Reading changes nothing, so no CSRF token |
| `POST /auth/logout`     | The cookie and a CSRF token                           |

```text
Set-Cookie: nimbus_session=...; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax
```

In production the cookie is `Secure` and named `__Host-nimbus_session`, a prefix browsers only accept
on a cookie that is `Secure`, has no `Domain`, and uses `Path=/`, which blocks a sibling host from
overwriting it.

`SameSite` is `Lax` rather than `Strict` on purpose. `Strict` would withhold the cookie when Google
redirects back after sign in, so the callback would see nobody logged in.

Four properties, each with tests:

- **Signing in destroys whatever session identifier you arrived with.** Otherwise somebody who
  planted an identifier in your browser would be holding your session after you logged in.
- **State changing requests need a CSRF token** sent as a header, never as a cookie. It is derived
  from the session, so it is stable across browser tabs and changes automatically when the session
  does. A failed check refuses the request but does **not** end the session, or any website could
  sign you out with one blind request.
- **Two expiry clocks.** An hour of inactivity ends a session, and an absolute lifetime ends it
  regardless of activity, so a stolen cookie kept quietly warm still dies.
- **Disabling an account takes effect on the next request**, not at the next login, because the
  account is re-read every time rather than trusted from the session. Every session that person holds
  is revoked at once.

## GitHub access

Nimbus never holds a long lived GitHub credential. It holds a private key that proves who it is, and
trades that for a token scoped to one repository, for one hour, whenever it needs to do something.

```text
private key  ->  App JWT              proves Nimbus is Nimbus, touches no repository
App JWT      ->  installation token   one repository, one permission set, one hour
```

Three permission sets exist, and nothing else is possible:

| Set           | Permissions                                        | Used for                  |
| ------------- | -------------------------------------------------- | ------------------------- |
| `read`        | metadata read, contents read                       | Reading a repository      |
| `push`        | metadata read, contents write                      | Creating the agent branch |
| `pullRequest` | metadata read, contents write, pull requests write | Opening a pull request    |

The App itself requests no administration, secrets, actions, workflows, or organisation permissions,
and a test asserts none of the three sets ever contains one.

- **Every token is tied to one repository id**, never a name, since names can be renamed and reused.
- **Tokens are cached in memory only, never in Redis or MongoDB.** Redis runs with `appendonly yes`,
  so storing one there would write a repository credential to disk.
- **Tokens are treated as expired five minutes early**, so an operation never begins with a token
  about to die.
- **Tokens are handed back when finished**, and stop working immediately rather than lingering.
- **What GitHub grants is checked against what was asked for.** A token wider than requested is
  discarded rather than used.

## Connecting a repository

```text
GET  /github/connect           returns a GitHub install URL carrying a one time value
GET  /github/setup/callback    GitHub sends you back here, the installation is remembered
GET  /github/repositories      the public repositories Nimbus may work on
POST /github/webhook           GitHub tells Nimbus what changed, signature checked
```

The three `GET` routes require a session. The list is resolved on the server from **your**
installation; there is no way to name an installation or a repository in a request, and no clone URL
is ever accepted.

- **A one time value ties the connect flow to your account.** It is spent on return, and a value
  issued to a different account is refused even if the installation number is right.
- **You must prove to GitHub that the installation is yours.** Connecting sends you through GitHub's
  authorization step, and Nimbus exchanges the resulting code for a user token to ask GitHub which
  installations that account can actually reach. Without that proof a new connection is refused, so
  knowing somebody else's installation number is not enough to claim it. The check uses reachable
  installations rather than comparing account ids, because on an organisation install the account is
  the organisation, not the person.
- **The installation is verified with GitHub before it is associated**, so a number typed into the URL
  is not enough. A bad value is rejected before GitHub is contacted at all, so the callback cannot be
  used to probe which installation numbers exist.
- **An installation already connected to another account is refused**, leaving the existing record
  untouched.
- **Only public repositories are offered.** A repository must say explicitly that it is not private
  and that its visibility is public, so `internal` repositories and ambiguous payloads are both
  refused rather than assumed safe.
- **Not connected is an error, not an empty list**, because "you have not connected GitHub" and "you
  have connected it and own nothing" are different answers.

Listing needs a token that is not scoped to one repository, which is the single exception to the rule
that every GitHub token is. It carries `metadata: read` and nothing else, so it can list repository
names and cannot read a line of code.

## Staying in step with GitHub

`POST /github/webhook` is the one route with no session, because GitHub calls it. It is trusted only
because every delivery is proved to have come from GitHub before anything else happens.

- **The signature is checked against the raw bytes**, using HMAC SHA-256 and the shared
  `GITHUB_WEBHOOK_SECRET`, compared in constant time. Parsing the body first and re-serialising it
  would change the bytes and break the check, so the raw body is kept for these paths only. The older
  SHA-1 header is never accepted, and a blank secret verifies nothing rather than everything.
- **A repeated delivery is done once.** Every delivery carries an id, which is claimed before the work
  and marked done after it, so GitHub's retries and its Redeliver button do not apply a change twice.
  If handling fails partway the claim is released, so a retry can genuinely retry.
- **Suspend, unsuspend, uninstall, and repository changes are applied** to the installation record. A
  suspended or removed installation stops being usable, and a removed one is never revived by a late
  event.

What a webhook deliberately **cannot** do is the part worth knowing:

- It cannot create an installation record. Records are created in one place only, the setup callback,
  where a signed in person proved the installation is theirs. A webhook has no user attached and could
  only guess.
- It cannot change which account owns an installation, or the proven GitHub identity stored on it.
- It cannot make a repository appear in the list Nimbus offers you, because that list is still fetched
  live from GitHub on every request.

An event for an installation Nimbus does not hold is acknowledged and ignored rather than refused,
because GitHub disables a webhook that keeps failing, and "I have no use for this" is not a failure.

## Local fake-adapter mode _(not yet implemented)_

Nimbus is designed to run its entire browser journey, from OTP login through GitHub connection,
agent work, approvals, checks, and a pull request, against fake adapters that need no paid
credentials.

## External service setup _(not yet implemented)_

Google OAuth, the GitHub App, E2B, Groq, Gemini, SMTP, and optional Qdrant each require
configuration before the corresponding real adapter can be used. Exact steps, GitHub App
permissions, callback URLs, and webhook events will be documented as those features land.

The GitHub App needs four things set before the GitHub routes will mount at all: the App id, slug and
private key, an OAuth client id and secret with "Request user authorization (OAuth) during
installation" enabled, a Callback URL pointing at `/github/setup/callback`, and a webhook secret
matching `GITHUB_WEBHOOK_SECRET`. Missing any of them leaves `config.github` null and the routes
unmounted, which fails closed.

Webhooks need a URL GitHub can reach, so local testing needs a tunnel. The `installation` and
`installation_repositories` events are delivered to every GitHub App automatically and do not appear
in the "Subscribe to events" list.

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
