# Nexus Mobile Command Center

## Purpose
A phone-first dashboard for reviewing what Nexus prepared, approving/rejecting exact revisions, seeing spend/performance, and understanding what Nexus recommends next.

## Screens for v1
1. **Today** — prepared, ready, awaiting approval, failures, spend.
2. **Review** — preview assets/captions and approve, reject, regenerate, or request changes.
3. **Queue** — scheduled/running/retrying/checkpointed jobs.
4. **Analytics** — views, retention, saves, shares, followers, revenue, cost per accepted asset.
5. **Learning** — hypotheses, experiments, confidence, promoted/deprecated strategies.
6. **Providers** — health, enabled models, credit/budget status; never expose secrets.

## Security rules
- Dashboard must require authentication before it is exposed beyond localhost/Tailscale.
- Approval applies to an exact content revision/hash. Editing after approval invalidates it.
- Approve and publish are separate operations in Approval Mode.
- Destructive or account-level operations require explicit confirmation.
- Never render API keys, access tokens, refresh tokens, cookies, or secrets into HTML/API responses.
- All state-changing API requests require authenticated POST/PUT/DELETE semantics plus CSRF/session protection where applicable.
- Record actor, timestamp, revision and action in the audit log.

## Mobile UX
Large touch targets, one-handed actions, clear status language, preview-first review, no tiny desktop tables. Primary actions: Review, Approve, Reject, Regenerate, Pause. Analytics are secondary to today's operational decisions.

## Current state
`dashboard/index.html` is a responsive shell with demo data and a future `/api/dashboard` fetch. `src/dashboard/dashboard-service.ts` defines the data projection layer. Claude Code should connect this to the persistent store and authenticated local server on the laptop, then replace demo action alerts with real API calls.

## Remote phone access
Preferred development route: bind the authenticated dashboard server locally and expose it privately over the owner's Tailscale network. Do not expose an unauthenticated dashboard to the public internet.
