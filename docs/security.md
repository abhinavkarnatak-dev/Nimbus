# Nimbus V1 Security Controls

The threat model in `docs/threat-model.md` states what can go wrong. This document states what
Nimbus does about it, control by control, and where each control lives. A control marked "planned"
is designed but not yet implemented.

## 1. Security invariants

These hold for the whole system. If a change would break one, the change is wrong.

1. The sandbox never holds a credential of any kind.
2. Only deterministic application code authorizes an effect. Model output is never authorization.
3. Nimbus never merges, approves, closes, force-pushes, or writes to a default branch.
4. Every payload crossing a trust boundary is schema validated and rejects unknown keys.
5. No secret is ever written to a log, an event, agent state, or the durable store.
6. Every query for user-owned data is scoped by the authenticated owner, checked server side.
7. Failing tests or checks are reported. They are never suppressed to produce a green result.

## 2. Authentication

**Email one time password.** Codes are 8 digits generated with a cryptographically secure RNG.
Only an HMAC of the code is stored, in Redis, with a short TTL, a request id, an attempt counter,
and a purpose field. A new request invalidates prior codes. A code is single use and invalidated on
success. Requests are limited per normalized account and per IP; verification attempts are capped
with backoff. Responses and timing are uniform whether or not the account exists. No user record is
created or modified until a code verifies. Codes are never logged, and the development mail adapter
is explicitly marked development only.

**Google OAuth.** `state` is signed and bound to the initiating browser session, and is validated
before any account association. Callback URLs are exact. Scopes are minimal. PKCE is used where the
chosen server flow supports it.

**Application sessions.** The session identifier is opaque and server side, delivered in an
`HttpOnly` cookie, `Secure` in production, with an appropriate `SameSite` value. No bearer token is
ever placed in local storage or a URL. The session rotates after authentication and after any
privilege change. Logout, expiry, revocation, and disabled account handling are implemented on the
server, and open sockets are disconnected when a session ends.

Owned by features 009 through 012.

## 3. Transport and browser hardening

- Exact CORS origin allowlisting. Credentials are permitted only for the configured frontend
  origin, never a wildcard.
- CSRF protection on every cookie authenticated state changing HTTP endpoint.
- A restrictive Content Security Policy, frame ancestors denied, no inline script.
- Standard security headers, including strict transport security in production.
- Request body size limits and a timeout on every inbound request.
- The browser never renders raw HTML originating from a model or a repository. Tool output, ANSI,
  Markdown, diffs, filenames, and URLs are all escaped or sanitized, and external links carry safe
  relationship attributes.

Owned by features 007, 011, 038, and 044.

## 4. Authorization and tenancy

Ownership is checked on every read and every write of user-owned data, in the query itself rather
than after the fact. Public identifiers are non-guessable and MongoDB object ids are never exposed.
Socket events re-authorize the session on each event, because an authenticated connection is not
standing permission for whatever arrives on it later. Cross-user access attempts have explicit
negative tests for every session, attachment, event, and repository endpoint.

Owned by features 006, 014, 020, 034, and 036.

## 5. GitHub credential handling

The GitHub App private key is supplied base64 encoded and decoded in memory. It is never written to
disk unless the platform makes that unavoidable, in which case it uses restrictive permissions and
guaranteed cleanup.

Installation access tokens are minted just in time inside the trusted backend, narrowed to the one
selected repository and to the minimum permissions the specific operation needs. They are never
persisted to MongoDB, never logged, never placed in agent state or analytics, never sent to the
browser, and never sent to the sandbox. After the push and pull request succeed, only pull request
metadata is stored and the token is discarded.

Requested permissions are metadata read, contents read and write, and pull requests read and write.
Contents write exists solely because the trusted backend must create the agent's branch.
Administration, secrets, actions, workflows, members, and organization scopes are not requested.

Webhook signatures are verified against the raw request body before parsing, and delivery ids are
recorded so replays are ignored.

Owned by features 013, 014, 015, 022, and 023.

## 6. Sandbox isolation

A fresh sandbox is created per session with no filesystem reuse. It contains no GitHub token, no
database URI, no Redis URL, no SMTP credential, no model provider key, and no application session
secret. Outbound network access is denied by default; any exception is narrow, time limited,
explicitly approved, and routed through a controlled proxy or allowlist. Private, loopback, link
local, cloud metadata, and internal service ranges are blocked from sandbox workloads.

Hard limits apply to wall time, CPU, memory, process count, disk, output bytes, and total session
duration. A cancellation signal terminates the running command and the sandbox. Cleanup runs in a
`finally` block and a periodic sweeper terminates orphans left by a crash.

Commands run from a fixed workspace directory using argv arrays. Model and user text is never
interpolated into a shell string. The sandbox provider's own interface takes a command string rather
than an argument list, so the conversion happens in one place: every argument is POSIX single quoted,
and the finished string is then parsed back into words and compared to the input. A mismatch of a
single character refuses the command, so a fault in the quoting is a refusal rather than an
injection.

The provider key that creates and destroys sandboxes is refused if it appears anywhere in what is
sent to a machine, including inside a longer value and including sandbox metadata.

Blocking of the cloud metadata address is enforced by a firewall rule installed before the sandbox is
handed over. Where the machine image grants the sandbox user unrestricted `sudo`, that rule is a
barrier rather than a boundary; the enforced protections remain the virtual machine itself and the
absence of any credential inside it. Every path is canonicalized after symlink resolution and rejected
if it escapes the workspace. Output has terminal control sequences stripped and secrets redacted
before it is streamed or stored.

Dependency installation is treated as untrusted code execution. The existing lockfile with
`npm ci --ignore-scripts` is preferred; lifecycle scripts run only in the restricted sandbox and
only with explicit approval.

Owned by features 016 through 019.

## 7. Deterministic policy and approvals

Policy runs before every effect, in application code, outside the model.

**Automatically allowed within limits:** listing, searching, and reading files inside the
workspace; modifying ordinary source, test, and documentation files inside the workspace; running
allowlisted read-only development commands; running repository-defined checks within budget.

**Requires one-time exact approval:** adding, removing, or upgrading dependencies or enabling
lifecycle scripts; modifying authentication, authorization, billing, encryption, deployment,
infrastructure, CI, GitHub workflow, CODEOWNERS, package publishing, database migration, or secret
related files; deleting or renaming files; a diff exceeding the configured file or line limits;
temporarily enabling a narrow network destination; anything not clearly covered by policy.

**Always denied in V1:** accessing credentials or host and internal services; modifying the default
branch, force-pushing, merging, approving, closing, or deleting GitHub resources; disabling security
controls or tests to obtain a green result; privileged containers, host mounts, persistence,
mining, scanning, or attacks; reading or writing outside the workspace after canonical resolution;
unrestricted network access; sending repository data anywhere other than the configured model
providers under the documented data policy.

An approval request shows the exact proposed effect, the paths or command category, the reason, the
risk, and an expiry. The approval is bound to a hash of those exact parameters. If any parameter
changes, the hash changes and the approval no longer applies.

Owned by feature 030, re-enforced by feature 021.

## 8. Trusted patch, push, and pull request gateway

The sandbox exports a patch or bundle with no credentials. The backend then, in order:

1. Re-verifies session, user, repository, active installation, immutable base SHA, and the expected
   feature branch.
2. Parses the diff, resolves renames, and rejects path traversal, symlink escapes, submodule URL
   changes, nested repositories, and protected paths lacking a valid approval.
3. Enforces changed file, diff line, and binary size limits.
4. Runs secret scanning on the diff and rejects likely credentials.
5. Confirms the target is not the default branch and that force-push is disabled.
6. Mints a repository scoped installation token just in time.
7. Pushes a unique `nimbus/<short-session-id>-<slug>` branch idempotently.
8. Creates exactly one pull request, or recovers the existing one after a retry.
9. Stores only pull request metadata and discards the token.

The pull request body states the task, a summary, changed files, test and lint results, any failing
or not-run checks, the approvals granted, and a clear notice that the change was generated by AI.

Owned by features 021, 022, and 023.

## 9. Input validation

Every request, response, and socket event is validated against a Zod schema from
`packages/contracts`, and every object schema rejects unknown keys. Types are inferred from the
schemas so a validated value and its static type cannot disagree. Sizes are bounded at the schema
level, not only at the transport level, so an oversized task, message, or event is rejected by the
same rule on both sides.

Attachments are validated by extension, declared MIME type, and magic bytes together. Accepted
types are plain text, Markdown, PNG, JPEG, and WebP. Archives, SVG, HTML, executables, and
detectable polyglots are rejected. Images are re-encoded with metadata stripped and dimension and
decompressed size caps. Storage names are generated; the original name is retained only as escaped
metadata and is never used in a command.

Owned by features 003 and 020.

## 10. Logging, redaction, and privacy

Every request and session carries a correlation id. The logger redacts authorization headers,
cookies, one time passwords, API keys, GitHub tokens, credentials embedded in URLs, environment
values, and common secret patterns. Raw attachments and complete repository files are never logged.
Shell and tool logs are bounded and retention controlled.

Audit events record security-relevant metadata for authentication, approvals, policy denials,
sandbox lifecycle, token minting, push, pull request creation, cancellation, and administrative
failures. They never contain raw prompts, full source, tokens, one time passwords, cookies,
authorization headers, or secret values.

Documented deletion behavior exists for sessions, attachments, indexes, and account data.

Owned by features 004, 006, and 046.

## 11. Rate limiting and abuse control

Limits apply per IP, per account, per session, and globally, covering authentication attempts,
uploads, socket connections and events, agent steps, model spend, sandbox time, and concurrent
work. Transient external failures use exponential backoff with jitter and honor provider rate limit
headers. A kill switch disables new agent sessions without breaking login or access to history.

Operational alerts fire on repeated authentication failures, policy denials, sandbox cleanup
failures, budget spikes, webhook failures, and push or pull request anomalies.

Owned by features 008 and 046.

## 12. Secrets management

No application module reads `process.env` directly. One validated configuration module parses the
environment at startup and fails fast with a useful message that never prints a secret value.
Secrets reach production through injected environment variables, never through a committed file.
`.gitignore` excludes `.env` files, key material, and local data. `pnpm audit` runs in
`pnpm security:check`, and secret scanning is part of the final quality gate.

Owned by features 004 and 049.

## 13. Testing as a control

Security properties are asserted by tests, not by intent. The suite includes adversarial fixtures
for prompt injection through repository content, malicious lifecycle scripts, traversal and symlink
escapes, nested repositories and submodule changes, shell metacharacters in every user-supplied
field, spoofed and oversized attachments, cross-user access to sessions and installations, revoked
sessions on open sockets, duplicate session starts and duplicate webhook, push, and pull request
events, terminal escape sequences and secret-like tool output, unapproved changes to workflows and
deployment configuration, sandbox timeouts, and a backend restart while waiting on the user.

Owned by feature 049, with each control tested in the feature that introduces it.
