# dendro-feedback worker

Receives agent-written feedback debriefs from the `submit_feedback` MCP tool.

- **Live:** https://dendro-feedback.captaincolinr.workers.dev (POST `/v1/feedback`)
- **Storage:** D1 `dendro-feedback` (id `02dd0d71-ebc0-4d66-b60e-323f74bb9c6a`)
- **Consent model:** the MCP tool refuses to send without `userConsented: true`, which its
  description requires the agent to obtain explicitly in-conversation. This endpoint is the
  ONLY place any Dendro data leaves a user's machine, and only ever the debrief fields plus
  version/platform/per-tool call+error counts (no error text, no paths, no code).
- **Abuse posture:** public write path, 32KB body cap, 10 posts/hour per hashed IP, no read path.

Read the feedback:

```bash
cd workers/feedback
npx wrangler d1 execute dendro-feedback --remote --command \
  "SELECT id, received_at, server_version, would_reuse, summary FROM feedback ORDER BY id DESC LIMIT 20"
```

Deploy changes: `npx wrangler deploy` (from this directory).
