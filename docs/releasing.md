# Release requirements

## Repository and registry setup

These are administrator settings, not properties a local workflow file can
create or prove. Complete them before publishing:

1. Create public `pavegrid/mcp` with fresh client-only history. Protect `main`
   against direct and force pushes and require the six CI matrix checks and
   secret scan. Protect `v*` tags so only release maintainers can create them.
2. Enable GitHub secret scanning, push protection, and private vulnerability
   reporting. Verify the private report link in SECURITY.md works.
3. Require npm organization 2FA. The first publish is a controlled bootstrap
   performed by a maintainer with MFA. Do not introduce a publish token into
   GitHub Actions to work around this bootstrap.
4. Configure the npm trusted publisher: organization `pavegrid`, repository
   `mcp`, workflow `release.yml`, environment `npm-release`. Permit direct
   publish. The workflow uses GitHub-hosted runners, Node 24, and npm >=11.5.1.
   After setup, disallow token-based publishing in the package settings.
5. Create GitHub environment `npm-release`, restrict it to protected `v*` tags,
   and make release access follow the repository's administrator policy.

[Official npm trusted publisher setup](https://docs.npmjs.com/trusted-publishers/)
and [provenance](https://docs.npmjs.com/generating-provenance-statements/).

## Acceptance before a tag

- All six CI jobs must be green, including real native store operations and
  running the packed bundle outside the repo. Secret scanning must pass.
- Install the packed tarball in clean environments and exercise all ten tools
  with a disposable PaveGrid account. Compare full summary totals with all
  pages of the corresponding lists. Check cost restrictions, units, dates,
  revocation and company AI access off on the next call.
- Record real Claude Desktop on macOS and real Claude Code discovery and calls.
  Verify Windows Desktop on a real Windows machine before claiming support.
- Confirm the deployed server supports the read routes, summary endpoint,
  minimum client version, and AI access authorization contract.
- Check the README data-sharing disclosure and all package/history contents
  for credentials or private business information.

Do not treat SDK-only tests as host acceptance, or a workflow file as a green
CI run. These acceptance records are required before the first public release.

## Publish

Update package.json, src/version.ts and CHANGELOG.md together, merge to protected
`main`, then create the matching `v<version>` tag from `main`. The release
workflow checks that the tag commit belongs to main and that the tag version
matches package.json. It repeats the CI matrix and secret scan before publishing
with `npm publish --provenance --access public` through OIDC. No NPM_TOKEN is used.
