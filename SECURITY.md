# Security policy

## Supported versions

Security fixes are applied to the current `main` branch. Until the first stable release, no older
version line receives backports.

## Threat model

LCARS for Herdr displays terminal output and can focus panes or start another local agent. It is a
local operator tool, not a multi-user web service:

- the HTTP server only binds to `127.0.0.1`, `localhost` or `::1`;
- every request must carry a loopback `Host`, and browser origins must also be loopback on the same
  port, which closes the DNS-rebinding path;
- control requests require JSON and are capped at 64 KiB; OTLP has separate compressed and inflated
  limits;
- the context store and status snapshots use private directory/file modes (`0700`/`0600`), atomic
  replacement and per-context locking;
- stored narrative and transcript text is size-bounded and common credentials are redacted before
  persistence and handoff;
- context records are untrusted data inside a fixed handoff envelope, never executable instructions.
- account profiles contain only validated aliases and absolute local directories, use mode `0600`,
  and are resolved server-side to an allowlist of environment variables; OAuth tokens and auth files
  are never returned to the browser or copied between profiles;
- Claude quota polling reads the token from the platform store only inside the server process, calls
  one hard-coded Anthropic HTTPS URL with redirects disabled, and bounds time and response size. It
  never logs the token, response body or credential-store stderr. POSIX credential files must not be
  readable by group or others;
- quota observations are account-bound. When several accounts could match, an unstamped observation
  stays unattributed instead of borrowing the last active account.

Do not expose the bridge through a reverse proxy, port forward, container publish flag or a
non-loopback bind. If remote access is ever added, it requires authentication, authorization and a
separate security design.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that can expose terminal content, credentials or
local files. Use GitHub's private vulnerability reporting for the repository. Include the affected
version/commit, reproduction, impact and any suggested mitigation. Remove real secrets and terminal
content from the report.
