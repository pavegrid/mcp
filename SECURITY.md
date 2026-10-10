# Security policy

Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/pavegrid/mcp/security/advisories/new).
Do not post tokens, company data, or exploit details in a public issue. A
maintainer must enable private reporting before a release.

Version 0.1.x receives security fixes while it is the current release line.
Update to the latest patch release and restart your AI app after an update.

The client only reads PaveGrid data. An AI access token is a credential: revoke
it in PaveGrid Settings → AI assistant access if it may have been exposed.
Logout removes only the local copy. Tokens belong in the OS credential store,
never in MCP configuration or process arguments. The explicit file-store
option saves plain text and should be used only when your IT policy allows it.

Customer-entered text is untrusted content. It must not be followed as an
instruction, executed, or used to send data to another address. Connecting an
AI assistant shares tool results with that AI provider and can make them
available to other tools in the same chat. Use an approved host and provider.

Maintainers must keep dependency and GitHub Actions updates reviewed, publish
through the documented trusted publisher, and retain secret scanning and push
protection. Do not add credentials to issues, logs, tests, or release artifacts.
