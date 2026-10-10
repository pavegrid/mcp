# Client design

The caller runs `pavegrid-mcp login`, then launches `pavegrid-mcp serve` from an
MCP host. The host sees ten stable read tools and never receives the token.

## Chosen structure

- `main.ts` owns command parsing, hidden token input, store selection and stdio
  lifetime. The CLI has no token argument or token environment setting.
- `store.ts` owns native credential operations, private helper pipes and the
  opt-in file store. Credentials are separated by the validated API origin;
  production retains its existing credential entry and file path. Static macOS
  JXA and Windows interop helpers invoke OS APIs
  without a compiler or PowerShell execution-policy changes. Linux uses libsecret.
- `api.ts` owns the HTTPS GET allowlist, version header, deadline, bounded
  retries, redirect refusal, body limit and token redaction.
- `tools.ts` owns input and output schemas, scope checks, page completeness,
  summary pass-through and the untrusted-text envelope.
- esbuild produces one CommonJS executable; dependency notices are embedded.

## Alternatives considered

A native Node credential add-on would give a smaller helper interface, but it
adds OS-specific binaries and installation work. OS-provided helper runtimes
keep the public package portable and require no install hooks.

The SDK's high-level tool registration is simpler, but its default validation
errors can quote caller input. A low-level Server with one schema catalog
lets validation happen inside a controlled error boundary; all published
schemas are generated from the same catalog used to validate calls and outputs.

## Verification boundary

Unit tests exercise API and CLI behavior, mocked store status codes, and every
MCP tool through a real SDK client. Real store tests use only isolated test
credentials, including a temporary keychain on macOS. Packed CLI tests run with
plain Node outside the checkout. CI repeats these on three OSes and two Node
lines. Real hosts and a live disposable account remain separate release checks.
