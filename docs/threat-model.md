# Nimbus V1 Threat Model

This document is written before the privileged parts of Nimbus exist, so that the controls in
features 013 through 037 are built against a checklist rather than invented as they go. Each
mitigation names the feature that owns it. A mitigation marked "planned" is not yet implemented.

## 1. Actors

| Actor              | Description                                         | Trusted                                                 |
| ------------------ | --------------------------------------------------- | ------------------------------------------------------- |
| Authenticated user | Owns a Nimbus account and a GitHub App installation | Partially. Authorized for their own data only           |
| Anonymous visitor  | Can reach the landing page and the auth endpoints   | No                                                      |
| Repository author  | Wrote the code Nimbus reads. Often not the user     | No                                                      |
| Language model     | Proposes actions. Influenced by repository content  | No                                                      |
| Nimbus operator    | Runs the deployment                                 | Yes                                                     |
| External services  | GitHub, Groq, Gemini, SMTP, E2B                     | Trusted to perform their function, not with excess data |

The language model is explicitly an untrusted actor. It is influenced by text written by strangers,
so its output is a proposal, never an authorization.

## 2. Assets

Ranked by what an attacker gains from them.

| Asset                                        | Impact if compromised                                  |
| -------------------------------------------- | ------------------------------------------------------ |
| GitHub installation tokens                   | Write access to a user's repositories                  |
| GitHub App private key                       | Ability to mint tokens for every installation          |
| Application session cookies                  | Full account takeover                                  |
| One time passwords in flight                 | Account takeover without a password                    |
| Model provider API keys                      | Financial loss and data exfiltration channel           |
| SMTP credentials                             | Phishing from a trusted sender                         |
| User to repository mapping                   | Discloses what a user is working on                    |
| Private repository content held in a session | Source code disclosure                                 |
| Attachments                                  | May contain sensitive user material                    |
| Audit log                                    | Discloses activity patterns; tampering hides an attack |

## 3. Trust boundaries

| #   | Boundary                               | Crossing                     | Primary risk                                                  |
| --- | -------------------------------------- | ---------------------------- | ------------------------------------------------------------- |
| B1  | Browser to API                         | HTTPS, cookie authenticated  | CSRF, session theft, cross-user access                        |
| B2  | Browser to socket                      | WSS, handshake authenticated | Origin abuse, cross-session subscription, stale authorization |
| B3  | API to MongoDB and Redis               | Private network              | Injection, unauthorized read across tenants                   |
| B4  | API to GitHub                          | HTTPS with a minted token    | Token scope too broad, token leakage, unintended writes       |
| B5  | API to model providers                 | HTTPS with an API key        | Sending secrets or excess source code                         |
| B6  | API to sandbox                         | Provider control plane       | Command injection, resource exhaustion, credential leakage    |
| B7  | Sandbox to internet                    | Denied by default            | Exfiltration, dependency confusion, metadata service access   |
| B8  | Repository content into the model      | Text                         | Prompt injection                                              |
| B9  | Attachment upload into the system      | Multipart                    | Malicious file, decompression bomb, spoofed type              |
| B10 | Sandbox patch into the trusted backend | Patch or bundle              | Path traversal, protected file change, smuggled secret        |

B10 is the boundary that matters most. It is the only path by which anything produced under model
influence becomes a real effect on a real repository.

## 4. Why credentials stay out of the sandbox

The alternative design, giving the sandbox a GitHub token so it can push directly, is simpler and
is the wrong choice. In the sandbox, a token would be readable by any process the agent starts:
the repository's own build scripts, a test suite, a dependency's install hook, or a command the
model was talked into running by a comment in the source. None of those are under Nimbus's control.
Once a token is in that environment, a single hostile `postinstall` exfiltrates it, and the blast
radius is every repository that token can reach, for its full lifetime.

Keeping credentials in Z1 converts a credential theft problem into a data validation problem. The
sandbox can only ever hand back a patch. A patch is inert, inspectable, and can be rejected. The
backend then decides, with deterministic code and full context about who owns what, whether that
patch becomes a branch. That is a boundary a reviewer can actually verify.

## 5. Attack surfaces and mitigations

### 5.1 Browser and session

| Threat                           | Mitigation                                                                                                                   | Feature       |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Session theft via XSS            | No token in local storage or URLs; opaque `HttpOnly` cookie; restrictive CSP; never render raw HTML from model or repository | 011, 039, 045 |
| CSRF on state changing requests  | CSRF token on cookie authenticated mutations; exact CORS origin allowlist with credentials                                   | 007, 011      |
| Session fixation                 | Rotate the session identifier after authentication and after privilege changes                                               | 011           |
| Stale authorization after logout | Server side revocation; sockets revalidate periodically and disconnect                                                       | 011, 036      |
| Clickjacking                     | Frame ancestors denied by CSP and frame options                                                                              | 007           |

### 5.2 Authentication

| Threat                        | Mitigation                                                                                                 | Feature  |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------- | -------- |
| One time password brute force | 8 digits from a cryptographically secure RNG, hashed at rest in Redis, short TTL, capped attempts, backoff | 010      |
| Account enumeration           | Identical response body and approximately constant timing whether or not the account exists                | 010      |
| Code replay                   | Single use, invalidated on success, and a new request invalidates prior codes                              | 010      |
| Request flooding              | Rate limits per normalized account and per IP                                                              | 010      |
| Login CSRF via OAuth          | Signed `state` bound to the initiating browser session, validated on callback                              | 012      |
| Account linking confusion     | Deterministic matching on normalized email with explicit provider records                                  | 012      |
| Codes leaking through logs    | Codes are never logged. The development mail adapter is marked development only                            | 009, 010 |

### 5.3 GitHub integration

| Threat                                       | Mitigation                                                                                                                                                            | Feature  |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Client supplied installation id or clone URL | Repository list resolved server side from the authenticated user's active installation. Client input is never trusted for identity                                    | 014      |
| Token scope too broad                        | Tokens minted just in time, narrowed to the one selected repository and the minimum permissions for the operation                                                     | 013      |
| Token persistence                            | Tokens never written to MongoDB, logs, agent state, analytics, or UI events, and never sent to the sandbox                                                            | 013, 019 |
| Forged webhooks                              | Signature verified against the raw request body before parsing                                                                                                        | 015      |
| Replayed webhooks                            | Delivery ids recorded and duplicates ignored idempotently                                                                                                             | 015      |
| Unintended repository writes                 | Default branch rejected as a push target, force push disabled, no merge or approve capability requested                                                               | 022, 023 |
| Excess permissions                           | Metadata read, contents read and write, pull requests read and write. Administration, secrets, actions, workflows, members, and organization scopes are not requested | 013      |

### 5.4 Sandbox

| Threat                                       | Mitigation                                                                                               | Feature  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------- |
| Credential theft from the sandbox            | No credential of any kind is placed in the sandbox                                                       | 016, 019 |
| Data exfiltration over the network           | Outbound access denied by default. Any exception is narrow, time limited, and explicitly approved        | 019      |
| Cloud metadata service access                | Private, loopback, link local, metadata, and internal ranges blocked from sandbox workloads              | 019      |
| Resource exhaustion                          | Hard limits on wall time, CPU, memory, processes, disk, output bytes, and total session duration         | 018, 019 |
| Cross-session data reuse                     | A fresh sandbox per session, with no filesystem reuse                                                    | 016, 019 |
| Orphaned sandboxes after a crash             | Teardown in `finally` plus a periodic sweeper                                                            | 019      |
| Command injection through model or user text | Typed operations and argv arrays. Model and user text is never interpolated into a shell string          | 018      |
| Malicious dependency lifecycle scripts       | Prefer the existing lockfile with `npm ci --ignore-scripts`. Lifecycle scripts require explicit approval | 018      |
| Terminal escape sequences in output          | Control sequences stripped and secrets redacted before streaming                                         | 018, 045 |

### 5.5 Filesystem

| Threat                                      | Mitigation                                                       | Feature  |
| ------------------------------------------- | ---------------------------------------------------------------- | -------- |
| Path traversal with `../` or absolute paths | Every path canonicalized and confirmed inside the workspace root | 017      |
| Symlink escape                              | Symlinks resolved before the containment check, not after        | 017      |
| Nested repository or submodule tricks       | Nested `.git` directories and submodule URL changes rejected     | 017, 021 |
| Oversized or binary files                   | Size limits and binary rejection on read and patch               | 017      |

### 5.6 Hostile repository content

This is the attack unique to a coding agent. A repository is data, but a language model reads it as
language.

| Threat                                                                                                             | Mitigation                                                                                                                                     | Feature  |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| A README or comment instructing the agent to ignore its rules, print environment variables, or send code somewhere | Repository text is passed as clearly delimited untrusted data. Authorization is deterministic code that never reads model output as permission | 030, 031 |
| Injected instruction to modify CI, workflows, or CODEOWNERS                                                        | Protected path list enforced by the policy engine and re-enforced by the patch validator at B10                                                | 021, 030 |
| Injected instruction to add a dependency that exfiltrates on install                                               | Dependency changes require explicit approval, and lifecycle scripts are off by default                                                         | 018, 030 |
| Injected instruction to disable a test or a security check to get a green result                                   | Explicitly denied class. Failing checks are reported prominently rather than suppressed                                                        | 030, 032 |

The controlling principle: the model can propose anything, and none of it is authorization. Policy
is code, it runs before the effect, and no string produced by a model or a repository can reach it
as an instruction.

### 5.7 Attachments

| Threat                             | Mitigation                                                                                              | Feature |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| Spoofed content type               | Extension, declared MIME, and magic bytes all validated. None alone is sufficient                       | 020     |
| Active content such as SVG or HTML | Rejected. Only plain text, Markdown, PNG, JPEG, and WebP accepted                                       | 020     |
| Decompression bomb                 | Dimension and decompressed size caps, with re-encoding                                                  | 020     |
| Metadata leakage                   | Images re-encoded and metadata stripped                                                                 | 020     |
| Malicious filename                 | Storage names generated. The original name is kept only as escaped metadata and never used in a command | 020     |
| Unauthorized retrieval             | Per user and per session authorization, stored outside any public web root                              | 020     |

### 5.8 WebSockets

| Threat                                | Mitigation                                                                      | Feature |
| ------------------------------------- | ------------------------------------------------------------------------------- | ------- |
| Cross origin socket connection        | Exact Origin allowlist at handshake                                             | 036     |
| Token in query string leaking to logs | Handshake authenticates from the cookie, never a query parameter                | 036     |
| Subscribing to another user's session | Ownership authorized per event. A connected socket is not blanket authorization | 036     |
| Revoked session on an open socket     | Periodic revalidation and disconnect on logout or expiry                        | 036     |
| Payload flooding                      | Schema validation, payload size caps, and per connection rate limits            | 036     |
| Lost events across a reconnect        | Durable sequenced event log with replay from `lastEventSequence`                | 036     |

### 5.9 Persistence and multi-tenancy

| Threat                                                      | Mitigation                                                                            | Feature       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------- |
| Cross-user reads of sessions, attachments, or installations | Ownership checked on every query, tested explicitly with cross-user negative tests    | 034, 020, 014 |
| Enumerable identifiers                                      | Non-guessable public ids. MongoDB object ids are never exposed                        | 006           |
| Cross-repository or cross-commit retrieval                  | Immutable repository id and commit SHA required in every retrieval filter             | 027           |
| Secrets in the durable store                                | Tokens and one time passwords are never persisted. Redis holds only hashes with a TTL | 010, 013      |

### 5.10 Model providers

| Threat                                  | Mitigation                                                                           | Feature  |
| --------------------------------------- | ------------------------------------------------------------------------------------ | -------- |
| Sending secrets to a third party        | Environment values, tokens, cookies, and key material are never included in a prompt | 025, 026 |
| Sending more source code than needed    | Minimal context, bounded snippets, documented in the README                          | 024, 026 |
| Unbounded spend                         | Per session token and monetary budgets, with a safe stop on exhaustion               | 026      |
| Prompt or response leaking through logs | Logs record metadata and usage, never full prompts or completions                    | 004, 025 |

### 5.11 Trusted patch gateway, boundary B10

Every check runs in the backend, on material that came from an untrusted sandbox.

| Threat                                                 | Mitigation                                                                                              | Feature  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- | -------- |
| Patch targeting another repository or a stale base     | Session, user, repository, active installation, immutable base SHA, and expected branch all re-verified | 021      |
| Path traversal or symlink escape inside the diff       | Paths parsed, renames resolved, traversal and symlink escapes rejected                                  | 021      |
| Submodule URL change or nested repository              | Rejected                                                                                                | 021      |
| Protected file changed without approval                | Protected path list enforced, approval record required and matched by hash                              | 021, 030 |
| Oversized change                                       | Changed file, diff line, and binary size limits enforced                                                | 021      |
| Credential smuggled into the diff                      | Secret scanning on the diff, likely credentials rejected                                                | 021      |
| Duplicate push or duplicate pull request after a retry | Idempotency checks, unique branch naming, existing pull request recovery                                | 022, 023 |

Pushing a branch or opening a pull request can trigger CI, preview deployments, and bots. Protected
file validation is a security boundary even though Nimbus never merges.

## 6. Protected paths

Changes to these require an explicit, exactly scoped approval, and the patch validator rejects them
without a matching approval record.

```text
.github/**
.gitlab-ci.yml, .circleci/**, azure-pipelines.yml, Jenkinsfile
CODEOWNERS, .github/CODEOWNERS, docs/CODEOWNERS
Dockerfile*, docker-compose*.yml, .dockerignore
package.json, package-lock.json, pnpm-lock.yaml, yarn.lock
.npmrc, .yarnrc*, .pnpmfile.cjs
.env*, *.pem, *.key, *.p12, secrets/**
terraform/**, k8s/**, helm/**, *.tf, *.tfvars
migrations/**, prisma/schema.prisma
any path matching auth, authz, session, crypto, billing, or payment
.git/**
```

## 7. Abuse cases

| Case                                                       | Response                                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A user points Nimbus at a repository designed to attack it | Repository content is untrusted by default. Policy and the patch validator are unaffected by its contents |
| A user tries to run two sessions to double their budget    | One active session per user, enforced atomically on the server                                            |
| A user uploads an attachment to reach the filesystem       | Generated storage names, no filename in any command, stored outside any served root                       |
| A user asks the agent to exfiltrate another repository     | The sandbox has one repository and no network egress                                                      |
| A user tries to make Nimbus merge a pull request           | The capability does not exist. Merge permissions are never requested                                      |
| Automated account creation to burn model budget            | Per account, per IP, and global rate limits, plus a kill switch for new sessions                          |
| An operator needs to stop everything during an incident    | Kill switch disables new agent sessions while leaving login and history intact                            |

## 8. Residual risks accepted for V1

Stated plainly rather than hidden.

- **Prompt injection is mitigated, not solved.** Deterministic policy means injection cannot exceed
  what policy already allows, but a sufficiently clever injection can still waste a session or
  produce a low quality pull request. The bound is the policy, not the model's judgment.
- **A user can approve something harmful.** Approvals show the exact effect, but a user who
  approves without reading has authorized it. Nimbus reduces this with precise, non-generic
  approval text, not by refusing to ask.
- **Provider trust.** Repository snippets are sent to Groq and Gemini under their terms. This is
  documented for the user rather than obscured.
- **Sandbox provider trust.** Isolation ultimately depends on E2B. Nimbus reduces the value of a
  break by ensuring nothing sensitive is inside.
- **Public repositories only in V1.** This deliberately keeps the worst case disclosure at zero for
  repository content, which is why private repository support is not in V1.
