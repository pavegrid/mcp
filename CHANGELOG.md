# Changelog

## 0.1.1

- Wait up to 30 seconds (was 10) for the OS credential helper, so a slow
  first PowerShell start on Windows no longer reports the store as unavailable.

## 0.1.0

- Initial read-only PaveGrid MCP client with ten tools and full server summaries.
- OS credential stores, explicit private file storage, bounded GET retries,
  token redaction, structured output and page-completeness fields.
- Node.js 22 minimum; one bundled CLI without runtime dependencies or install hooks.
- Cross-platform CI, real store tests, package smoke tests, secret scanning,
  dependency updates and npm provenance release workflow.
