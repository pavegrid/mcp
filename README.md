# PaveGrid MCP

Read your PaveGrid data from an AI assistant through a local, read-only
[Model Context Protocol](https://modelcontextprotocol.io/) connection.
Package: `@pavegrid/mcp`. Source: [pavegrid/mcp](https://github.com/pavegrid/mcp).

## Before you connect

Your PaveGrid admin must enable AI assistant access. Create a personal AI access
token in PaveGrid Settings → AI assistant access. It starts with `pgai_`.
The token has the same company scope and read permissions as your account.
The client cannot create, edit, or delete PaveGrid records.

**Data you give your AI goes to that AI provider and may be available to any other
tools in the same chat.** This can include customer text, locations, project
records, account email, and costs if your role can see them. Check your company
policy and the AI provider's data retention terms before you connect. A token
never goes to the AI host: the local client uses it to authenticate to PaveGrid.

## Install and log in

Install Node.js 22 or newer. Node.js 24 LTS is recommended.

```sh
npm install -g @pavegrid/mcp@0.1.0
pavegrid-mcp login
pavegrid-mcp whoami
```

Paste the token at the hidden prompt. It is not displayed. For automation,
`pavegrid-mcp login --stdin` reads a token from stdin; send it from a secure
secret source. Never put a token in a command argument, environment variable,
MCP configuration, shell history, or support report.

The default store is macOS Keychain, Windows Credential Manager, or Linux
libsecret. On Linux, install `secret-tool` (usually `libsecret-tools`) and run a
Secret Service, such as GNOME Keyring, in your signed-in desktop session.
A locked, denied, or missing credential service produces a clear error. The
client never silently switches to a file.

## Claude Desktop

Add this to your Claude Desktop MCP configuration, then restart Claude Desktop.
You must log in on the same OS user account first.

macOS and Linux:

```json
{
  "mcpServers": {
    "pavegrid": {
      "command": "npx",
      "args": ["--yes", "@pavegrid/mcp@0.1.0", "serve"]
    }
  }
}
```

Windows uses `cmd /c npx`. This avoids invoking the PowerShell `npx.ps1` shim.
The credential helper uses built-in commands and does not require a change to
PowerShell execution policy.

```json
{
  "mcpServers": {
    "pavegrid": {
      "command": "cmd",
      "args": ["/c", "npx", "--yes", "@pavegrid/mcp@0.1.0", "serve"]
    }
  }
}
```

If Node.js is not on the AI app's PATH, configure its absolute executable path.
For an installed package you can use `node` with the absolute path to
`dist/cli.cjs` and `serve` as separate arguments. Paths with spaces work when
passed as separate JSON array entries.

## Claude Code

```sh
claude mcp add --transport stdio pavegrid -- npx --yes @pavegrid/mcp@0.1.0 serve
```

On Windows, replace the launch command after `--` with
`cmd /c npx --yes @pavegrid/mcp@0.1.0 serve`.

Ask your AI: “List my PaveGrid Sites.” Then use a Site id to request Projects,
Contract Items, Events, or a full summary.

## Tools and reports

| Tool | Reads |
| --- | --- |
| `whoami` | Your account, company, role and token expiry |
| `list_sites`, `get_site` | Sites and Site configuration |
| `list_projects`, `get_project` | Projects for a Site and full Project records |
| `list_contract_items`, `get_contract_item` | Contract Items and full records |
| `list_events`, `get_event` | Events and full records |
| `get_summary` | Full server counts and totals, grouped by Project, status, type or month |

List inputs use `limit` (1–50, default 25) and `offset` (default 0). Results
include `data`, `total`, `limit`, `offset`, `returned`, `next_offset`, and
`complete`. `complete` is true only when that response contains the entire
list. `next_offset` is null at the final page; a final page with a nonzero
offset still contains only part of the list. Do not calculate full totals from
one page. Use `get_summary` for reports. Lists can change between requests;
they are not a snapshot.

`get_summary` requires `site_id` and `group_by` (`project`, `status`, `type`, or
`month`). It accepts `project_id`, `from`, and `to`; dates are inclusive
`YYYY-MM-DD` values interpreted by the server for the Site time zone. Use
`scope`, `generated_at`, and `units` to label reports. The server defines the
fields inside `counts` and `totals`; the client preserves them. State
`cost_visible` and never infer a hidden cost from a missing or null value.
Record area fields ending in `_sf` use square feet. Summary area and currency
units come from `units.area` and `units.currency`.

All tools declare read-only, non-destructive, idempotent behavior and a closed
set of PaveGrid endpoints. All provide an output schema, structured results,
and a JSON text fallback. Customer text is labelled as **untrusted data**.
The client never executes instructions or opens URLs from returned data.
An AI assistant must also treat that text as data; these labels cannot guarantee
that a model will resist every prompt injection.

## Logout and revoke

```sh
pavegrid-mcp logout
```

Logout removes the local token only. To revoke the token on every device,
revoke it in PaveGrid Settings → AI assistant access. Your admin can also turn
AI access off for the company. There is no identity or record cache; the next
API call checks authorization again.

## Explicit file store

If your OS store cannot be used, you can explicitly select a plain text store:

```sh
pavegrid-mcp login --allow-file-store
pavegrid-mcp whoami --allow-file-store
pavegrid-mcp serve --allow-file-store
pavegrid-mcp logout --allow-file-store
```

Include `--allow-file-store` in the host's `serve` arguments too. This selects a
separate store; it does not migrate or replace a token in the OS store. A warning
goes to stderr on each use. On POSIX the directory is 0700 and the file is 0600,
owned by the current user; on Windows the file has one explicit full-control
rule for the current user's SID and inheritance is disabled. The Windows
helper sets and verifies this ACL through Windows PowerShell's bundled modules;
paths travel on stdin.
Symlinks and unsafe permissions are refused. The locations are:

- macOS: `~/Library/Application Support/PaveGrid/mcp/ai-token`
- Windows: `%APPDATA%\PaveGrid\mcp\ai-token`
- Linux: `$XDG_CONFIG_HOME/pavegrid/mcp/ai-token`, or `~/.config/pavegrid/mcp/ai-token`

OS credential entries use service `pavegrid-mcp:production` and account
`pavegrid`. Windows uses a generic credential with that target.

## Network and IT review

- Only HTTPS GET requests to `https://pavegrid.com` are sent. Authorization
  uses a bearer token and every request sends the client version. No telemetry
  is added. No local HTTP listener is opened; MCP uses stdin/stdout.
- Standard `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` (also lowercase variants)
  are supported. Use `NODE_EXTRA_CA_CERTS` for a company CA certificate. TLS
  validation remains enabled; disabling it is refused.
- Requests have a 25-second deadline. Only 429 and 503 responses are retried,
  at most three attempts. `Retry-After` is honored; long waits are returned to
  the user instead of retried early. All redirects are refused. Responses are
  limited to 1 MiB; reduce the list limit if needed.
- 401 means AI access is off, expired, or revoked. 403 means the read is not
  allowed. 426 means update the client and restart the AI app. 429 means wait
  before trying again. Transport diagnostics go to stderr; MCP stdout contains
  only protocol messages. OS helper output is captured in private pipes and
  never forwarded to terminal output or the MCP host.
- npm ships one esbuild bundle with no runtime dependencies or install hooks.
  Bundled dependency license notices are included in the bundle. The source and
  lockfile can be reviewed independently.
- CI covers Ubuntu, macOS and Windows on Node 22 and 24. Store tests use real
  APIs: a temporary macOS keychain, a unique Windows target, and libsecret in an
  isolated D-Bus session. Packed bundles are run outside the checkout with
  plain Node from a path with spaces. Releases use npm trusted publishing and
  provenance; no long-lived publish token belongs in the workflow.

## Compatibility evidence

The automated suite checks SDK discovery and calls for all ten tools, plus
stdio protocol output, error paths, packing, and credential operations.
Live PaveGrid account acceptance and actual Claude Desktop / Claude Code host
acceptance are separate release requirements. Windows Desktop behavior must be
verified on a real Windows machine before it is claimed. Workflow configuration
alone is not evidence that all six CI jobs have passed.

## Develop

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run test:store
npm run build
npm run test:pack
```

On Linux, run store and pack tests under `dbus-run-session` with an unlocked
GNOME Keyring; `scripts/linux-store-checks.sh` does that in CI.
See [release requirements](docs/releasing.md) and [security policy](SECURITY.md).
