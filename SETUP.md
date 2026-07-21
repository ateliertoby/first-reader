# Outlook CLI Setup

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
