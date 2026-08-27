# First Reader Setup

## 1. Register Azure App (one-time)

1. Go to https://portal.azure.com
2. Search "App registrations" → New registration
3. Name: "First Reader"
4. Supported account types: "Personal Microsoft accounts only"
5. Redirect URI: leave blank
6. Click Register
7. Copy "Application (client) ID" from Overview page

## 2. Set API Permissions

1. In your app → API permissions → Add a permission
2. Microsoft Graph → Delegated permissions
3. Add: `Mail.ReadWrite`, `Mail.Send`
4. Click "Grant admin consent" (if available, otherwise it prompts on first login)

## 3. Enable Public Client Flow

1. In your app → Authentication
2. Under "Advanced settings", set "Allow public client flows" to Yes
3. Save

## 4. Configure

```bash
cp .env.example .env
# Edit .env and paste your Application (client) ID
```

## 5. Login

```bash
email login
# Follow the URL and enter the code shown
```

## 6. Feeds (optional)

A *feed* publishes the transactions of one sender to another program on the same
host. Declare it as a top-level `feeds` array in `config/rules.json`, beside the
sort rules:

```json
"feeds": [
  {
    "id": "ride-dispatch",
    "sender": "payment.notification@hsbc.com.hk",
    "memo": "SUPPLIERPAY",
    "platform": "ride"
  }
]
```

`id` names the output file (`data/feed/<id>.jsonl`) and must be lowercase
letters, digits and dashes. Only income from `sender` whose message-to-payee
memo equals `memo` is published; `platform` is passed through to the consumer.
With no `feeds` entry the ledger pass has nothing to publish and says so.

Backfill an existing mailbox once, by hand, after the timer is installed:

```bash
email ledger --since 2026-06-01 --dry-run   # inspect first
email ledger --since 2026-06-01
```

## 7. Schedules

The sorter and the agent run from the launchd plists in the repo root. The
ledger pass runs from systemd units in `deploy/` (Linux mail server):

```bash
sudo cp deploy/first-reader-ledger.service deploy/first-reader-ledger.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now first-reader-ledger.timer
systemctl list-timers first-reader-ledger.timer
```

The unit runs `bin/ledger-cron.sh` every 15 minutes and appends to
`data/ledger.log`. The pass is read-only against the mailbox: it never moves,
deletes, or marks mail, so it is safe to run on any schedule.
