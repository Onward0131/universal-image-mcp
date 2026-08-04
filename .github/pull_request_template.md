## Summary

Describe the user-visible change and why it is needed.

## Verification

- [ ] `npm ci`
- [ ] `npm test`
- [ ] `npm pack --dry-run`
- [ ] `npm run build:release` when installer or release packaging changed

## Safety and scope

- [ ] MCP content remains text-only; no image Base64 or MCP `image` blocks were added.
- [ ] No real API Key, authorization header, raw credential file, or private image is included.
- [ ] Billable requests are not automatically replayed after ambiguous failures.
- [ ] The change stays within the stdio MCP and Codex Skill product scope.
- [ ] User-visible changes are documented in `CHANGELOG.md`.
