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

Owned by features 007, 011, 039, and 045.

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

## 8a. Cancellation and the liveness of an external write

A cancellation is durable the moment the session row moves to `cancelled`, which is a conditional
update with exactly one winner. From that moment two things happen in parallel: the cancellation is
announced on a Redis channel so whichever process is running the session aborts it promptly, and the
worker's own checks will catch it even if that announcement is never delivered, because Redis pub sub
is a speed improvement and never the mechanism of record.

Immediately before every trusted external write, and again between the branch push and the pull
request, the worker asks five questions and stops unless all five still hold: the session exists, it
is still in an active status, it is still owned by the same user, this worker still holds the lease,
and the run has not been aborted. Failing any of them, the worker performs no further external write.
For a lost lease or a vanished session it also writes nothing to the database at all, because another
worker may legitimately own the session now.

An HTTP request that has already left the process cannot be recalled, so the guarantee is stated in
terms of what is started rather than what completes:

- No external write is ever started after a cancellation is durable.
- The remaining window is one HTTP round trip, because the check sits immediately before the call.
- If a cancellation wins between the push and the pull request, the branch exists and no pull request
  is opened. The worst case is an orphan branch, never a pull request on somebody's repository.
- A retry cannot duplicate an effect, because the branch name is derived from the session and the pull
  request gateway looks before it creates.

Deleting an orphan branch is deliberately not done. Feature 022's gateway has no delete operation at
all, and adding one to tidy up a rare case would widen the trusted surface for no security gain.

Cancellation is announced exactly once. The API owns the durable event and the notification because it
owns the decision and the conditional update guarantees a single winner; a worker that finds itself
cancelled tears down its sandbox, releases its lease, and announces nothing.

Owned by features 034, 035, and 038e.

## 8b. Shutting a worker down

A worker that is shutting down claims no further sessions, waits for the runs it already holds to
finish on their own, and only then aborts whatever is left. The abort travels through the same signal
a cancellation uses, so the same five liveness questions are asked before every remaining external
write and the same guarantee applies: no branch is pushed and no pull request is opened once the
worker has begun stopping a run.

A run interrupted by a shutdown is not a cancelled run, and the difference is written into the code
rather than left to interpretation. Nobody asked for this session to stop, so nothing is written about
it, its lease is released, and it stays in an active status where the existing recovery path claims it.
Writing `cancelled` would tell a person their work was cancelled when the machine it was on was
restarted, and it would also make that state terminal, so the session could never be recovered.

Every background worker in the process settles the work it is in the middle of before its dependencies
are closed, in an order that closes nothing under live work: runs drain, then the session and sandbox
and attachment sweepers, then the event stream, then in flight HTTP requests, and only then the mail
transport, Redis, and MongoDB. Each sweeper holds a Redis lease while it works, so a connection closed
under a sweep would strand that lease until its time to live expired and would leave the sweeper's own
deletions half done. Anything still running when the deadline passes is logged and abandoned to lease
expiry rather than allowed to hang the shutdown, because a process that will not die is worse than a
session another worker picks up.

Owned by features 038e and 038f.

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

Owned by features 004, 006, and 047.

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

## 10a1. Model provider keys held for an account

The server has no model API key of its own, so every model call a session makes is billed to a key
the account owner added. That makes the key an asset the account trusts Nimbus with, and the controls
here are about what is stored, who can read it, and what happens when it stops working.

**A key is checked with the provider before it is stored.** The key is asked to list the provider's
models. Only a success stores anything. A refusal is reported as a rejected key, and any other
outcome, including a timeout or a network fault, is reported as the provider being unreachable, so a
provider outage is never presented to somebody as their key being wrong.

**A key is encrypted before it is written down.** AES-256-GCM under a key derived from
`SESSION_SECRET`, with the account id and the provider name bound in as additional authenticated
data, so a row copied to another account or another provider fails to open rather than decrypting.
The nonce is fresh per seal, so the same key stored twice produces different ciphertext.

This protects against a database-only compromise, and against nothing more. There is no key
management service in this project, so anybody who holds both the database and `SESSION_SECRET` can
read every stored key. That is stated rather than implied, because the alternative is a reader
assuming a guarantee that is not there.

**A key is never sent back out.** The list endpoint returns the provider, the last four characters,
when it was added and when it was last verified. The response schema is strict, so a field carrying
the key cannot be added by accident. The browser stores nothing and re-reads the list after every
change.

**A key that cannot be opened is reported, not guessed at.** If `SESSION_SECRET` changes, the
affected keys stop opening. Those providers disappear from what the account can use and the fault is
logged as the account and the provider, never as the ciphertext, and the account is asked to save the
key again.

**Adding, rejecting and removing a key are audited.** Each writes an event naming the provider and
the caller's IP, and never the key. A rejected key records the verdict and the provider's status code
so a run of failures is attributable.

**One account can never read or remove another account's key.** Every query is scoped by user id, the
unique index is on the pair of account and provider, and a removal that matches nothing is a
`NOT_FOUND` rather than a success.

Owned by feature 044a.

## 10b. Model and vision routing

Routing decides which model is asked, what it is told, and when a session must stop, so its controls
are about substitution, untrusted content, and spending.

**A model the user may not choose is refused, never substituted.** The set of selectable text models
is explicit. An unknown or disallowed name raises `LLM_MODEL_UNKNOWN` when the session router is
constructed, before any request is made. Silent substitution is treated as the worse failure, because
it bills a user for a model they did not choose and answers them from a model they did not choose with
no way to observe it.

**Only the primary text model is a user choice.** The vision, light and reasoning models are chosen by
the server. This removes any path by which a user could select a model that cannot see for an image
job, and prevents a cheaper primary from changing the cost of unrelated internal work.

**Every role in a plan is covered by a key the account holds.** The server picks each role from an
ordered list of candidates and takes the first one a saved key pays for, so an account with only a
Groq key gets an all-Groq plan rather than a plan that fails at the first Gemini call. A primary the
account cannot pay for is refused when the plan is built, not swapped for something cheaper, and an
account with no key at all cannot create a session in the first place.

**An image is described once and the description is persisted** on the attachment record along with
the model that wrote it and the time. Sessions are resumable, and a resume that re-describes every
image would re-bill every image. Only attachments of kind `image` are ever sent to a vision provider.

**Descriptions and attached text are untrusted content** and are wrapped in the same marked blocks
feature 024 uses for repository text, sharing one implementation rather than a second copy. The per
bundle marker value is random and verified absent from every part being assembled, including the
retrieval bundle, so no part can close its own block or collide with another.

**Context is assembled under a fixed character budget** and trimmed by what cannot be recovered
elsewhere: the retrieval bundle first, since the agent can search again for it, then attached text,
then image descriptions. The task is never dropped at any budget. What was dropped is reported rather
than silently omitted.

**Spending is checked before a call is sent and charged after it returns.** A call that would cross a
token, money, or call limit raises `LLM_BUDGET_EXCEEDED` without being sent, so there is no partially
spent state, and the router remains usable for reporting what a session consumed.

**A failure to describe one image never ends a session.** It is logged as an attachment id and an
error code, never as the description or the image, and the session continues without it. The error
handling around a vision call covers only the remote call, so a local defect cannot be recorded and
skipped as though the provider had failed.

Owned by feature 026.

## 10c. Durable agent state

A checkpoint is a row in a database that outlives the process that wrote it, so anything sensitive in
it is sensitive at rest, findable in a backup, long after it should have been gone.

**Three independent defences keep credentials out.** The state schema has no field capable of holding
a token, and a sandbox is referenced by id rather than by object. Field names are checked recursively,
including inside arrays, so anything named `token`, `apiKey`, `secret`, `password`, `credentials`,
`authorization`, `cookie`, `privateKey`, `client`, `connection`, `socket` or `db` is refused; whole
normalised names are compared, so a counter named `tokensUsed` is unaffected. Finally the serialized
bytes are scanned with the same detector the logger uses, plus an explicit connection string pattern.

**A refusal, never a redaction.** Unlike a log line, a state with a value removed is one the agent
would resume from and act on. A write carrying anything credential shaped fails and stores nothing.

**Only plain data is accepted.** A class instance, a `Map`, a `Date` or a function is refused, which
removes the path by which a live client, connection or sandbox handle could be captured into state.

**Everything is bounded.** Every array and string has a maximum in the schema, the whole serialized
state is capped at 256 KB, and the state drops its oldest tool events and file reads as it runs, so a
long session cannot grow past the cap and then fail to save.

**Resuming is refused when it would be wrong.** A checkpoint is rejected if it was written under a
different state version, if it records a different base commit, or if it is older than a day. State is
never migrated across a code change. Corruption, meaning unreadable bytes or json not shaped like a
checkpoint, raises a named error and returns nothing, so a partly rebuilt state is never handed back.

**Sessions are isolated.** Every checkpoint query is keyed by thread and namespace, where the thread is
the session id, and an integration test proves one session cannot read another's checkpoints.

**Four budgets bound a run**: steps, retries, tokens and time. Each is checked before work begins so a
refusal leaves nothing half done, and the stop names the budget that ran out. The token budget is
stored in the state and restored on resume, and refuses a record kept under different limits, so
spending cannot reset itself across a restart.

Checkpoints expire after a day, enforced on read and by a TTL index, and a finished session's
checkpoints can be removed outright.

Owned by feature 028.

## 10d. The agent tool registry

The registry is the only place a model's request becomes an action, so it is the narrowest boundary in
the system and every argument reaching it is untrusted by definition.

**Dangerous capabilities are absent, not disabled.** There is no tool that pushes, opens a pull
request, merges, reads an environment variable, fetches a URL, or returns a credential. On top of that
absence, registration refuses any tool whose name contains `push`, `pull_request`, `merge`, `approve`,
`token`, `secret`, `credential`, `fetch`, `http`, `network`, `download` or `upload`, so a later feature
cannot add one by accident. `prepare_commit` states in its model facing description that it neither
pushes nor opens a pull request.

**Every tool has a strict schema and an unknown field fails the call.** Ignoring an unrecognised
argument would let a tool act differently from what was asked while appearing to succeed. The JSON
schema shown to the model is generated from the same Zod object that validates the input, so the
description and the enforcement cannot drift, and `additionalProperties: false` is carried through.

**The safety rules of the underlying operations are untouched.** Reading a symlink that leaves the
workspace still fails with `PATH_OUTSIDE_WORKSPACE`, an ignored or credential shaped path with
`PATH_IGNORED`, and a command outside the allowlist is surfaced as `denied`. The registry adds a door,
not a room, and the tests assert those refusals again through it.

**Every tool has its own timeout**, combined with the caller's cancellation signal into one signal
passed down to the sandbox. A request whose signal is already aborted is refused before the tool is
looked up, so nothing is read and nothing runs.

**Outcomes are distinguished deliberately.** A command exiting non zero is a successful tool call with
a bad result; a timeout, a cancellation and a policy denial are separate outcomes. Conflating them
would leave the agent unable to tell a failing test suite from a broken tool.

**Every invocation produces an audit record, including the failures.** The record holds a call id, the
tool, a bounded summary, at most twenty paths and a start time. It never holds the raw arguments, which
are model written text of arbitrary size, or the raw output, which is truncated and redacted by feature
018 before it goes anywhere. Logs carry the tool, outcome, duration, error code and session id, and a
test asserts a distinctive phrase from a tool argument appears in no log line.

Owned by feature 029.

## 10e. Deterministic pre-execution policy and approvals

The registry establishes that a request is well formed. The policy gate decides whether it is
permitted, and it is the control that the rest of the trusted boundary depends on.

**The decision is made outside the model, on inputs a model cannot argue through.** The classifier
receives the tool name, the arguments already parsed by feature 029, and fixed lists maintained by us:
protected paths from feature 017, dependency filenames, and the command allowlist from feature 018. It
never receives a summary, a reason, a justification, or any repository text. A prompt injection has no
field to occupy. This is verified by asserting that a hostile instruction placed in a file's contents
produces a decision and category identical to innocent contents, and that a path named to look
pre-approved is treated like any other protected path.

**Three outcomes, with a safe default.** `allowed` covers reading, searching, ordinary source changes,
and allowlisted commands. `approval_required` covers protected paths, dependency and lockfile changes,
deletions, renames, oversized diffs, lifecycle scripts, and anything with no matching rule. `denied`
covers commands outside the allowlist and unreadable patches. The fallback for an unrecognised tool or
argument shape is `approval_required`, never `allowed`.

**Denied is terminal.** A denied action has no approval path and no effect object is produced, so a
user is never offered the chance to authorize something that must not happen.

**Approvals are bound to a canonical, exact action hash.** SHA-256 over a serialization with keys
sorted at every depth, covering the tool name and the whole argument object. Canonical so the same
request written two ways is one action; exact so any changed value is a different action and an
existing approval no longer applies. Model written summaries and reasons are excluded from the hash so
it stays stable for the same real action.

**Approvals are single use, time limited, and one per action.** An approval is consumed when it
authorizes an action. It expires after fifteen minutes, and an expired approval reports as `expired`
rather than silently failing. A rejection remains a rejection past its expiry. A decision naming a
different action hash is refused. Requesting approval for an action that already has a pending or
approved one returns that one, so an agent cannot accumulate authorizations by asking repeatedly. A
session may request at most twenty approvals.

**Every decision is recorded, including the permitted ones**, because a record of only refusals cannot
explain how a change was made. The record holds the tool, decision, category, risk, action hash,
whether a person approved it, and a path count. It holds no model text and no raw arguments.

Owned by feature 030.

## 10f. Clarification, retrieval, and reasoning

These are the first nodes where a language model influences what a session does. The design question
is not whether a model can be misled, which it can, but what its being misled is able to cause.

**The reasoning node cannot authorize anything.** It produces a proposal: an intent sentence, a tool
name, and an argument object. Feature 030's policy gate then classifies that proposal from the tool
name and the arguments alone. The intent, the retrieval bundle, the model's reasoning and the
repository text are not inputs to the decision. This is verified by hashing the same action with a
hostile intent and with none and asserting the hashes are identical, and by a test in which the model
is scripted to fall for an injection completely, propose `run_command` with `curl`, and be denied.

**Untrusted material is labelled but the labelling is not the control.** Repository content,
attachments and image descriptions arrive inside the marked blocks from features 024 and 026, under a
header stating they are data and that instructions found inside are to be reported and never carried
out. Each block closes with the nonce it opened with, and the nonce is verified absent from the
material it wraps. This reduces how often a model is misled. It is not what makes being misled
harmless.

**Two independent checks run before the policy gate sees anything.** The tool name is checked against
the registry, so a name a model invented is refused with the real names given back. The arguments are
then parsed by that tool's own schema through `ToolRegistry.check`, which runs the schema without
running the tool, so a malformed call never costs a policy decision or an execution attempt. The same
parse still happens inside `invoke`, unchanged.

**Scope validation is shown the user's words only.** The light model that judges whether a task is
actionable receives the task and the clarification answer, and no repository content, so no file can
influence whether a session pauses or what it asks. This is asserted directly: after judging a task
in a repository containing `redirectAfterLogin`, the messages sent to the model do not contain that
identifier.

**Every shape is bounded.** The intent is capped at 300 characters, the argument object at 16384
serialized characters, the assembled context at a fixed budget with the task trimmed last, and the
retrieval result at a fixed file count. `ScopeVerdictSchema` and `NextActionSchema` are strict, so a
model cannot smuggle a second action or an extra field alongside the first.

**A session asks at most one clarifying question.** The check reads feature 028's durable
`clarificationQuestion`, runs before any counting and before any model call, and proceeds regardless
of what the answer said. A session cannot be made to pause indefinitely.

**The model cannot write a turn from the person.** The conversation between a session and its owner is
kept as roled turns, and the role is set by the backend on the way in: a message posted to the sessions
route is always a `user` turn, and a note produced by the `message_user` tool is always an `agent` turn.
Tool output never carries a role. A model that could append a turn labelled `user` could fabricate an
instruction and read it back as authorization on its next step, which is why the two paths are separate
methods rather than one method with a role argument taken from anywhere the model can reach.

**What the person says is not wrapped in the untrusted markers,** deliberately. Their words sit at the
same trust level as the task they already wrote, and marking a principal's own instructions as hostile
data would be theatre. What bounds them is the same thing that bounds the task: the policy gate decides
from the tool name and the arguments, so nothing said in a message can widen what an action is allowed
to do. The prompt says so in as many words, that a person can steer the work and cannot grant
permission the checking system withholds.

**The conversation is bounded twice, for two different reasons.** The session keeps a fixed number of
the newest turns so one session cannot grow a document without limit, and the reasoning node is shown
only the most recent few so a long conversation cannot crowd the repository context out of the request
or spend the token budget on itself.

Every persisted conversation turn has a server-generated message ID. User submissions also carry a
client idempotency key recorded in a bounded receipt ledger, so concurrent retries with the same key
and text converge on one turn and return its original ID even after that turn has rolled out of the
visible conversation. Reusing the key for different text is a conflict. Agent messages use one ID for
both the durable turn and the live event. Message-specific traffic rate limiting remains part of
feature 047; the V1 storage and retry bounds do not depend on it.

Owned by features 031 and 038h.

## 10g. Execution, observation, and validation

This is the boundary the rest of the agent exists to protect. Every effect on a repository passes
through `ActionExecutor.execute`, which authorizes before it acts.

**The ordering is a property of the code, not a convention.** The tool registry and the policy gate
are held in real private fields, `#registry` and `#policy`. The class exposes two public methods,
`execute` and `toolNames`, and there is no public path to `registry.invoke`. TypeScript's `private`
was used first and was not sufficient: it is erased at compile time, leaving an ordinary readable own
property. This is verified by asserting the instance has no own property names at runtime and that
the prototype carries exactly two methods.

**Four outcomes, three of which produce no effect.** `executed` only after `allowed`. `denied` with no
approval path and no effect object. `approval_required`, which opens one card, sets the phase to
`awaiting_approval`, and runs nothing. `refused`, when the arguments fail the tool's own schema, in
which case the policy classifier is not consulted at all, since feature 030 is specified to receive
arguments that have already been parsed.

**Tool output is untrusted content.** A file read, a search result, command output and a test failure
message are all written by whoever wrote the repository. Each observation is returned inside feature
024's marked blocks under a header of its own stating that it is data, is scanned with the same flag
rules, and carries a warning when a flag fires. The nonce is generated absent from the material, so
output cannot close its own block. There is no exemption for output the agent requested.

**Every observation is redacted three times over.** `redactSecrets` runs before the text reaches the
model, before it is written into the checkpointed state, and before it is logged, and the event
summary is redacted separately. Redaction replaces rather than refuses here, unlike feature 028's
handling of state, because an observation missing a token is still useful while a state missing a
field is a lie the agent would resume from.

**User facing text cannot impersonate the product.** Only `message_user` and `wait_for_user` produce a
message for a person. Marker prefixes inside it are rewritten, the text is redacted and length
bounded, and the approval card a user sees is built from feature 030's policy effect and from nothing
the model wrote.

**Failure loops terminate in two independent ways.** Different actions failing spend feature 028's
retry budget. The same action hash failing twice stops immediately with the stop reason
`repeated_action`, because a global budget spends everything on a single mistake. A pause for approval
is neither a success nor a failure: it consumes a step and leaves the retry count untouched, so
alternating a denied action with one awaiting approval cannot evade the budget. Cancellation is
checked before every step, ahead of all budgets.

**Records are precise.** `ToolEventSummary.outcome` distinguishes `paused` from `refused`, so an
action a person is about to approve is not recorded as a refusal. Check results live in their own
state field and are replaced by name, so a stale failure cannot sit beside a current pass.

Owned by feature 032.

## 10h. Cloning, completion, and the full graph

**The clone is a trust boundary and is defined by what it refuses.** It is the one moment repository
content crosses into the machine the agent can touch. Credential files, private keys, symlinks,
submodules, binaries, and anything past the file count, per file byte and total byte caps are never
written into the sandbox. Feature 017 refuses to read a credential file; this refuses to place one,
which is the stronger of the two. A partial clone reports which categories it skipped rather than
appearing complete.

**The installation token never enters the sandbox.** The backend fetches the tree and the blobs and
writes the contents in, the same division feature 022 uses for pushing. This is verified by reading
every file in the sandbox after a clone and asserting the token appears in none of them.

**A truncated listing is refused.** GitHub marks a recursive tree listing truncated on large
repositories. Cloning half a repository would have the agent reasoning confidently about code it
cannot see, so the run fails with `CLONE_TREE_TRUNCATED`.

**The clone is the baseline, not a change.** `Sandbox.markBaseline()` is called once the clone has
written everything: `git init`, stage, and a baseline commit in the real sandbox, and a baseline copy
in the fake. Without it the exported patch would contain the entire repository, and on the real path
`exportPatch` would fail outright because the workspace would not be a git repository.

**Completion is a tool call, not a sentence.** An agent declares itself finished by calling
`prepare_commit`, which policy already classifies. Completion is then refused if no file changed, if
the checks were never run, or if any check failed or errored, each with a reason naming what is
missing. No English is parsed to decide whether work is done.

**The patch is exported by the backend and validated by feature 021.** Nothing is re-decided here, and
nothing in this feature pushes a branch or opens a pull request. Publishing belongs to a session, not
to a graph.

**A pause ends a run.** A clarifying question or a required approval checkpoints the state and returns
rather than holding a thread open. A process that waits in memory for a human loses the work when it
restarts, and a human approval is the wait with no upper bound. The sandbox is torn down on a pause
and rebuilt from the clone on resume, which is deterministic because the base commit is fixed.

**Teardown is unconditional.** Every terminal path terminates the sandbox, including a run that throws
and a run stopped by a budget, and a failure to terminate is logged rather than swallowed.

**The graph cannot loop forever.** On top of every budget from feature 028 and the repetition guard
from feature 032, the compiled graph carries a recursion limit derived from the step budget.

Owned by feature 033.

## 11. Rate limiting and abuse control

Limits apply per IP, per account, per session, and globally, covering authentication attempts,
uploads, socket connections and events, agent steps, model spend, sandbox time, and concurrent
work. Transient external failures use exponential backoff with jitter and honor provider rate limit
headers. A kill switch disables new agent sessions without breaking login or access to history.

Operational alerts fire on repeated authentication failures, policy denials, sandbox cleanup
failures, budget spikes, webhook failures, and push or pull request anomalies.

Owned by features 008 and 047.

## 12. Secrets management

No application module reads `process.env` directly. One validated configuration module parses the
environment at startup and fails fast with a useful message that never prints a secret value.
Secrets reach production through injected environment variables, never through a committed file.
`.gitignore` excludes `.env` files, key material, and local data. `pnpm audit` runs in
`pnpm security:check`, and secret scanning is part of the final quality gate.

Owned by features 004 and 050.

## 13. Testing as a control

Security properties are asserted by tests, not by intent. The suite includes adversarial fixtures
for prompt injection through repository content, malicious lifecycle scripts, traversal and symlink
escapes, nested repositories and submodule changes, shell metacharacters in every user-supplied
field, spoofed and oversized attachments, cross-user access to sessions and installations, revoked
sessions on open sockets, duplicate session starts and duplicate webhook, push, and pull request
events, terminal escape sequences and secret-like tool output, unapproved changes to workflows and
deployment configuration, sandbox timeouts, and a backend restart while waiting on the user.

Owned by feature 050, with each control tested in the feature that introduces it.
