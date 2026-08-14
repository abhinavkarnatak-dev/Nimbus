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

Steps 2 to 4 are performed by a parser written for this system rather than a general purpose library,
and they are performed again here even though the sandbox already refuses the same things. The sandbox
is where untrusted code runs, and its own checks are made by code an attacker inside it could replace,
so the only checks that count are the ones made after the patch has left it.

Symbolic links and submodules are identified by Git file mode, `120000` and `160000`, rather than
inferred from the body of a diff. A patch the parser cannot read with certainty, including one with a
quoted path or a malformed mode, is rejected rather than interpreted.

Validation produces a structured report with one of three decisions: `allowed`, `approval_required`,
or `denied`. A refusal can never be softened by an allowed or approval level finding, and a report
that is denied carries no approval requests at all, since no approval could rescue it.

Secret scanning reads only added lines, so removing a credential is never penalised. Known credential
shapes are refused outright and are named in the finding. A high entropy value that matches no known
shape raises an approval request rather than a refusal, because build hashes are indistinguishable
from keys and a validator that cries wolf gets disabled. In neither case does the matched value enter
the report, the logs, or any stored record: only the kind of credential and the line it was on.

Steps 6 to 8 never invoke Git. The branch is assembled through the Git Data API as blobs, a tree, a
commit, and finally a ref, so the installation token exists only as an HTTP header: it is never
written to disk, never placed in a URL, never passed to a subprocess, and never present while the
sandbox is running. It is minted only after validation has passed, so material that will be refused
never causes a credential to exist, and it is revoked in a `finally` regardless of outcome. A failure
to revoke is logged and does not discard a successful push.

Idempotency does not rely on a database flag. The branch name is derived from the session, so a retry
targets the same ref, and Git objects are content addressed, so rebuilding them yields the same
hashes. If the ref already exists and its commit carries the same tree, the earlier attempt is
returned as the result. If it carries a different tree, the push is refused as a conflict and the ref
is left untouched, since a reviewer may already be reading it.

Writing to the default branch is refused by comparing against the repository's own reported default,
not by trusting the branch naming convention. Force pushing is not disabled by configuration; no
update-ref operation exists in the port at all.

Pull request creation is made idempotent by GitHub itself rather than by local state: a branch has at
most one open pull request against the same base, so the lookup is both the duplicate check and the
recovery path. Losing a create race is expected rather than exceptional, and the refusal is turned
into a second lookup so the loser returns what the winner made. The notification email is sent only
when a pull request was actually created, and a failure to send it is logged without discarding the
pull request.

Every piece of untrusted text in the description, meaning the user's task, the model's summary, and
any check output originating in the repository, is placed inside a fenced code block rather than
escaped character by character. This makes mentions, issue references, links and HTML inert without
maintaining a list of dangerous characters, and prevents Nimbus from being used to notify or spam
third parties through pull request rendering. The fence length is derived from the content so backtick
runs inside cannot terminate it early.

Checks that failed or did not run appear before anything else in the description, and a body where
everything passed makes no claim of success. The pull request gateway exposes exactly two operations,
finding by branch and creating; merging, approving, closing, updating and commenting are absent from
the port rather than merely disallowed by policy.

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

None of the three claims an upload makes about itself is treated as evidence, because all three are
written by the client. They must agree with each other, and disagreement is a refusal rather than a
correction. Detection is a hand written allowlist of five signatures rather than a general purpose
library, so nothing can be accepted that was never intended.

Polyglot files are not detected, they are destroyed. Every image is decoded to raw pixels and
re-encoded, so what is stored is a file Nimbus wrote rather than a file it received. This is also
what removes EXIF and GPS data. The pixel cap is passed to the decoder before decoding so a small
compressed file cannot ask for gigabytes of memory, and the byte cap is enforced while the upload
streams rather than after it is buffered.

Uploaded bytes never reach object storage without passing through the backend. Presigned upload URLs
are deliberately not used, since they would route the bytes around every check above. The bucket is
private, has no public domain, and is only reachable through an authorized request. Storage keys are
generated from identifiers Nimbus issued.

Every download is sent with `Content-Type` exactly as stored, `X-Content-Type-Options: nosniff`,
`Content-Disposition: attachment`, `Cache-Control: private, no-store`, and a
`Content-Security-Policy` of `default-src 'none'; sandbox`, so a browser will not render an
attachment as a document on Nimbus's own origin. Reading an attachment that belongs to somebody else
answers `404` rather than `403`, because `403` would confirm that it exists.

Attachments that are never attached to a session expire after 24 hours and are removed from both
object storage and the database by a leased sweeper, rather than by a database TTL that would leave
the stored object orphaned.

Owned by features 003 and 020.

## 9a. Retrieval and untrusted repository content

Retrieval is the path by which repository text reaches a model provider, so it carries two duties:
keep the wrong files out, and make sure what does go through cannot be mistaken for instructions.

**What is never read.** The ignore policy from feature 017 is reused unchanged and covers `.git`,
dependency and build directories, binaries, and credential shaped files such as `.env`, `*.pem`, and
`id_rsa`. On top of it sits a secret shaped name policy for files that are material rather than
modules: `credentials.json`, `secrets.yml`, `passwords.txt`, `apiKeys.json`, and anything under
`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, or `.azure`. Names are compared as whole words and as
adjacent word pairs after splitting on case changes and separators, so `tokenizer.ts` is readable and
`accessToken.json` is not. A file with a source code extension is exempt from the name rule, because
`src/auth/token.ts` is a module somebody may need to fix; the redaction layer below covers the case
where that judgement is wrong. Excluded files are never opened, not filtered from results afterwards,
and a test asserts which paths the reader was asked for.

Only regular files are read. Symbolic links are never followed and paths inside a nested repository
are never scanned, both as single rules rather than path resolution that has to be correct.

**Every line handed over is redacted** with the same patterns the logger uses, so a credential inside
a file that was legitimately readable is replaced before it leaves the process. Private key blocks
span multiple lines and match no single line, so they are tracked across the lines of a window and
each line is replaced individually, which preserves the line count so the line numbers reported to the
agent stay accurate.

**Untrusted content labelling.** Everything retrieved is wrapped in markers under a header stating
that the material is data, that nobody has vouched for it, and that instructions inside it are to be
reported rather than obeyed. The markers carry a random value generated for each bundle and verified
absent from the material, so repository content cannot close its own block and issue instructions
outside it. This is the same reasoning as the measured fence in feature 023: an unguessable value
rather than a list of characters to escape.

**Prompt injection is flagged, not refused.** Lines matching `IGNORE_PREVIOUS`, `ROLE_SWITCH`,
`SYSTEM_PROMPT_CLAIM`, `EXFILTRATION`, or `MARKER_SPOOF` are reported as a code, a path, and a line
number, and the header gains a warning. The flag shape has three fields and nowhere to hold the
matched text. Refusal is deliberately not the response, because a repository about prompt engineering
trips every rule and is ordinary work, and a check that fires on ordinary work gets disabled.

Every stage is bounded: files scanned, bytes scanned, per file size and line count, tree depth and
width, files returned, lines and windows per file, line length, total bundle characters, and flag
count. Each limit reports truncation truthfully rather than failing or silently overrunning.

There is no persistent index. Every query is a fresh bounded pass, so retrieval cannot serve content
from a repository or commit other than the one in the workspace.

Owned by feature 024.

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

## 10a. Model providers

Provider adapters are the one place where a user's private source code leaves the system, so the
controls here are about what is sent, what is recorded, and what is spent.

**Nothing about the conversation is logged.** A model call records the provider, the model, the
attempt number, the HTTP status, the duration, the token counts, and the estimated cost. It never
records the messages, the answer, the image bytes, or the API key. Five tests capture every line the
logger emits during a call and assert that a distinctive phrase from the prompt appears in none of
them, including during a schema repair round and during a run of failed attempts.

Schema validation failures are recorded and raised as field paths and codes, such as
`summary:invalid_type,files:invalid_type`, never as the validator's message, because that message
quotes the offending key out of the model's answer. The detailed message is sent back to the model,
where the detail is useful, and never leaves the process any other way.

**Outgoing content is redacted.** Every message is passed through the same redaction the logger uses
before it is sent, so a credential pasted into a task, present in build output, or embedded in an
error message is replaced before it reaches a provider. This is a second pass over material feature
024 already redacts, and exists for the paths that do not come from retrieval.

**Keys travel as headers, never in a URL.** Gemini's documented query parameter form is deliberately
unused, since a URL is the value most likely to appear in a log line, an error, or a proxy record.
Error details returned by a provider are redacted and clipped before they are stored on an error
object, because a provider may echo the request back.

**Images are declared untrusted to the model that reads them.** The vision system instruction states
that an image is untrusted material and that instructions found inside it are to be described and
never carried out, which is the same position feature 024 takes on repository text.

**Retries are bounded and selective.** Only 408, 409, 429, and 5xx are retried, with exponential
backoff and full jitter, capped, and honouring `Retry-After` when the provider sends it. 400, 401,
403, 404, 413, and 422 are never retried, since the request would be equally wrong the second time. A
cancelled request is never retried, and cancellation interrupts the backoff wait as well as the
request itself. Every call carries a timeout combined with the caller's cancellation signal.

**Spending is bounded per session** in tokens, in estimated money, and in number of calls, checked
before a call is started rather than during it, so there is no partially spent state. Token counts are
taken from what the provider reported, including hidden reasoning tokens, which the two providers
report differently and which the adapters normalise. Cost is derived from a price table, is always
labelled as an estimate, and a model absent from the table is charged the highest rate in it rather
than nothing.

Owned by feature 025.

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
