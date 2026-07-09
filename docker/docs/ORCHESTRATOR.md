# Ragent Orchestration Guide

Orchestration here is a MODE, not a resident agent. Any interactive session in
this workspace enters it when the user asks to delegate work, onboard a repo,
or plan multi-repo tasks; several sessions may hold the role at once — that is
fine, every action below is idempotent or lands on GitHub, which arbitrates.
Continuity lives in `/workspace/agents/_orchestrator/notes.md`, not in any one
session.

The work: discuss requirements with the user, split them into repo-sized
tasks, delegate each task to the right repo agent, and track the results. You
never implement changes in the managed repos yourself — each repo's own agent
is the only write path to it. Your job ends at a well-written issue.

## Continuity notes

Before delegating, read `/workspace/agents/_orchestrator/notes.md` (create it
if missing): fleet state, what is delegated and still awaited, recent history.
After delegating / merging / onboarding, update it — prune resolved entries and
keep it short. It is the only memory the next session inherits.

## What you can see

- **Agent registry**: `/workspace/agents/agents.json` — maps `"owner/repo"` to
  `{ "name": "...", "persona": "..." }`. These are the repos you can delegate to.
- **Each agent's memory**: `/workspace/agents/<owner-repo>/notes.md` — read
  these for a repo's current state, conventions, and in-flight work. Read-only
  for you: the server maintains them; never edit another agent's notes.

## How to delegate work

Open a labeled issue in the target repo — the label wakes that repo's agent
via webhook, which implements the task and opens a PR (or replies if no code
change is needed):

    gh issue create -R owner/repo --label agent \
      -t "<concise title>" \
      -b "<self-contained spec>"

Rules:

- Only delegate to repos registered in `agents.json`.
- The body must be **self-contained**: what to build, acceptance criteria,
  relevant files/paths. The repo agent has no memory of your conversation with
  the user — everything it needs must be in the issue.
- One repo per issue. Cross-repo work = one issue per repo; if tasks depend on
  each other, delegate the upstream one first and wait for its PR before
  delegating the downstream one.
- The label name comes from `DISPATCH_ISSUE_LABEL` (default `agent`) and must
  exist in the target repo.
- Never write `ragent-meta` comments or `ragent-*` fenced blocks in issue
  bodies — the server manages delegation metadata itself.

## Discussing instead of delegating

To ask a repo agent something without triggering implementation, comment on an
existing issue in that repo starting with `/ragent <your question>` — the
agent replies in-thread, grounded in its repo, without opening a PR.

## Tracking results

- The repo agent opens a PR on branch `probe/issue-<N>`, or replies on the
  issue when no code change is needed.
- Check progress with `gh issue view -R owner/repo <N> --comments` and
  `gh pr list -R owner/repo`.
- When agents delegate to each other, outcomes are reported back on the origin
  issue automatically — you only need to watch the issues you opened.

## Instance configuration

Secrets live in env vars (which always win) or in
`/workspace/.ragent/config.json` (chmod 600, read lazily — edits take effect
without a restart):

    { "github_token": "...", "webhook_secret": "..." }

The `webhook_secret` is auto-generated on first boot. If `github_token` is
missing, ask the user to add it **from a plain shell prompt, not through this
conversation** — pasted secrets would otherwise end up in the session context.

To use `gh` yourself, export the token from the config file first:

    export GH_TOKEN=$(node -e 'console.log(require("/workspace/.ragent/config.json").github_token||"")')

## Onboarding a new repo

When the user asks to bring a repo under management, do all of this for them:

1. Verify a GitHub token is configured (see above); it needs Contents,
   Issues, and Pull requests read/write on the target repo.
2. Ask for the instance's public URL if you don't know it.
3. Create the trigger label (an already-exists error is fine):

       gh api repos/OWNER/REPO/labels -f name=agent -f color=5319e7

4. Create the webhook, with the secret from the config file:

       gh api repos/OWNER/REPO/hooks -f name=web -F active=true \
         -f "events[]=issues" -f "events[]=issue_comment" \
         -f "config[url]=https://<instance>/webhooks/github" \
         -f "config[content_type]=json" \
         -f "config[secret]=<webhook_secret from config.json>"

5. Register the agent in `/workspace/agents/agents.json` (name + optional
   persona). Registration doubles as the whitelist for cross-repo requests,
   so only add repos the user actually controls.
6. Smoke test: open a trivial labeled issue in the repo and confirm a PR
   (branch `probe/issue-<N>`) or a reply arrives within a few minutes.
