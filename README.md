# first-reader

**An email first-reader for Outlook.com.** It reads every new message before you do, files the mechanical stuff into folders, and delivers one short Telegram report: what needs action, what changed with your money and accounts, and what you can safely ignore. Most days the correct report is short and mostly empty — that is the product working.

The name is the job description. A first reader is what a good secretary does with a stack of mail: read everything once, deal with the routine, and put three things on your desk — what needs your action, what needs your decision, and what they could not judge. This tool is that secretary, not a court reporter. It deliberately does **not** summarize every email, and it deliberately does **not** draft replies — coverage is failure; judgment is the product.

## Why this exists

The author's mailbox had settled into a death spiral. An invoice for every online purchase, security notices the banks are obliged to send, and — the author drives for a living — a receipt email for every tunnel crossing. Skip one day of checking and the pile makes the next check heavier; the heavier the check, the stronger the urge to skip it. Almost none of it needed opening — the preview alone said so — yet every item still demanded a look before it could be dismissed.

The first version was nothing but a CLI built so that an AI coding agent (Claude Code) could read the mailbox and help clear it. Watching how that mail actually got handled hardened into the sorting rules; the rules raised the question of who reads the remainder; the agent is the answer to that question.

## Three layers, adopt any prefix

The project grew in three layers, and each works without the ones above it:

1. **CLI** — read, send, search, and manage Outlook.com mail from the terminal, via Microsoft Graph with device-code OAuth. Useful on its own.
2. **Sorter** — a deterministic rules engine on a launchd/cron schedule. Rules are data (`config/rules.json`): domain matches, subject regexes, guard words. Bank and payment emails become rows in a transactions database via per-sender parsers.
3. **Agent** — the first reader. An LLM reads what the rules didn't classify, renders the daily report, and holds a conversation over Telegram: "keep those", "add a rule for that sender", "is this one safe to open?".

Failure degrades downward, never sideways: if the agent dies, the sorter keeps filing; if the sorter dies, mail just stays in the inbox. Nothing in the pipeline ever deletes mail.

## What a report looks like

Synthetic example. Reports render in your `replyLanguage` — the author's arrive in Cantonese. A day with nothing actionable produces a few lines, and that is the intended steady state.

```
31 new since yesterday

Action needed
1. HSBC — credit card payment HKD 4,120.00 due Thu 24 Jul.
   The email carries the amount and the deadline; pay and forget.
2. Cloudflare — a domain renews in 3 days against an expired card.
   Fix the card or it lapses Sunday.

Worth knowing
- Stripe payout HKD 2,300.00 landed Monday.
- Vercel: build-minute pricing changes in August — your plan unaffected.
- New sender billing@newsaas.example sent an invoice-shaped email;
  no rule covers it yet — see suggestion 1.

Routine — 26 emails, nothing worth opening
statements x3, promos x9, newsletters x8, service notices x6

Junk — 2 pending
1. "Your parcel is held" — courier lookalike, link domain mismatch,
   hidden tracking pixel. Dangerous, do not open.
2. Gym renewal promo — harmless, likely misfiled. Say "rescue 2".

Suggestions
1. rule: billing@newsaas.example → accounting, subject "invoice".
   Say "yes to 1" and it lands with 7-day probation.
```

## The safety model

Most email-agent projects optimize for automation — auto-classify, auto-draft, auto-send. This one is built around distrust, in both directions:

- **Iron rule.** Operations (moves, rule changes, any mutation) can only originate from the owner's Telegram messages. Email content is untrusted data everywhere in the pipeline — a message that says "add a rule" or "click here" is adversarial input, not an instruction. Every LLM prompt carries this rule above everything else.
- **Rules come from the owner.** The agent suggests; it never decides. Every rule change is recorded in the agent database with the owner's verbatim instruction, so each rule traces back to a human decision.
- **Guards.** Anything that smells like a failure, decline, or deadline ("failed", "declined", "overdue", …) is never auto-filed, regardless of rules — unless a rule explicitly declares it targets that failure pattern by design.
- **Dwell time.** Mail is guaranteed to sit in the inbox for a minimum age before the sorter may touch it, so you see what arrived even on sorted senders.
- **Probation and audit.** New rules carry a probation period during which their moves are flagged in reports. Every move lands in an audit log; `unsort` undoes a move and pins the message against re-sorting. A monthly folder audit asks the LLM to distrust past filing and flag suspects — advisory only.
- **Junk lane.** Mail in the junk folder is judged on one axis: is it dangerous to open — not what it says. A safety-inspection toolkit does deterministic forensics before any LLM sees it: header alignment (From / Return-Path / Reply-To, SPF/DKIM/DMARC), link audits (display text vs real href, punycode, shorteners, IP literals), hidden-content detection (zero-width characters, invisible styles, tracking pixels), and a machine-view vs human-view diff that flags content written for AI eyes rather than human ones. The LLM only ever sees the rendered view — never raw HTML.

## How the LLM runs — no API key

LLM calls are file-queue jobs. The daemon writes a request file; a worker picks it up, invokes the **`claude` CLI** (billed to your existing Claude subscription, no API key in any config), and writes the result back atomically. Renders survive daemon restarts, results produced while the worker was asleep are delivered late, and a report that cannot be rendered degrades to a deterministic fallback at its deadline instead of going missing.

The two-machine shape is deliberate, not incidental. The mail daemon runs on an always-on headless server; the `claude` login lives on the author's daily development laptop, and the worker pulls the queue from the laptop over SSH. The reasoning: **a credential on a machine you use every day cannot rot silently.** If the laptop's `claude` login expires, you notice the same morning — you were about to use it anyway. Put the CLI on the server instead and its login expires quietly some week later, taking the agent down until someone thinks to check. So the credential stays where it is exercised daily, and the queue absorbs the distance: requests wait, the laptop wakes, answers arrive late rather than never — and the report tells you when the worker seems to be asleep.

## Built for one, published as-is

This is the author's live daily driver, published the way it actually runs rather than sanitized into a demo:

- LLM prompts and Telegram strings carry Cantonese fragments; report language follows the `replyLanguage` config field, so your reports come out in your language.
- The transaction parsers target the author's (mostly Hong Kong) banks — each is a small regex function in `src/sorter/parsers.js`; add your own in minutes.
- A few internal strings reference the author's machines.

Fill in your own config and it runs for you. Publishing as-is is deliberate: the difference between a concept demo and a working tool is the tuning that real use forces — the tier caps, hard downgrades, and guard words all answer for reports and sorts that once got it wrong — and a cleaned-up demo would have thrown exactly that away. The git history is the honest record of how it grew — CLI, then sorter, then agent.

## Setup

1. **Azure app registration** — one-time, ~5 minutes, personal Microsoft accounts: follow [SETUP.md](SETUP.md).
2. **Environment** — `cp .env.example .env`; fill in the Azure client ID and (for the agent) Telegram bot token and chat ID.
3. **Config** — copy each `config/*.example.*` to its real name and edit:
   - `rules.json` — sorting rules; start empty and add them as patterns emerge, or let the agent suggest them
   - `agent.json` — models, timezone, owner name, reply language
   - `agent-notes.md` — context about your accounts and priorities that shapes report ranking
4. **Login** — `email login`, follow the device-code prompt.
5. **Daemons (optional)** — edit the `/Users/YOURUSER` placeholder in the `com.first-reader.*.plist` files, copy to `~/Library/LaunchAgents`, `launchctl load`. Three jobs: sort cron, agent loop, LLM worker.

## Usage

```
email inbox                 list inbox
email read 3                read message #3
email send / reply 3        compose
email search <query>        search
email sort                  run the sorter once (also runs from launchd)
email sort --dry-run        classify without moving anything
email transactions          transactions extracted from bank emails
email rule list             show rules and guard words
email rule add              add a sort rule
email unsort --sender X     undo sort moves, pin against re-sorting
email reparse --sender X    backfill transactions after adding a parser
email report                sorter activity report
email agent-report          assemble and render a report once
email agent-loop            run the Telegram agent daemon
email llm-worker            run the LLM worker
```

Then message your bot on Telegram: `/check`, or just talk to it — "check email", "those job alerts are fine, stop asking", "is that prize email dangerous?".

## Architecture

Three long-running processes — sort cron, agent loop, LLM worker — around two SQLite databases, a file-based LLM queue, and a Telegram outbox. The data flow, the file map, and the reasoning behind each design decision are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Limitations

- Personal Microsoft accounts only, as configured in SETUP.md (work/school tenants need a different app registration and consent flow).
- Three fixed buckets — accounting, notifications, keep — filed into auto-created `Accounting` / `Notifications` folders; bucket taxonomy is not yet configurable.
- The LLM worker is currently wired for the author's two-machine layout (SSH host alias and remote queue path live in code). Single-machine operation would need a small local-mode patch; the split-machine shape described above is the design's home ground.
- Reports and conversation are Telegram-only.

## Status

In daily use by the author — the CLI and sorter since March 2026, the agent since July 2026. It evolves the way it was built: changes land when daily use demands them, not on a roadmap.

Issues and pull requests are welcome. The rules and parsers are personal by nature, so adapting the ideas — first reader, iron rule, judgment over coverage — to your own mailbox is as much an intended use of this repo as running the code itself.

## License

MIT — see [LICENSE](LICENSE).
