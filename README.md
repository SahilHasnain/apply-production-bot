# Apply-for-Production Bot

Playwright bot that fills the Google Play Console **"Apply for production"** answers
for your apps, using the same persistent-Chrome-profile approach as the sibling
`tester-optin` project. Supports **multiple apps** via a single config file.

> Use your **developer account** (the one that owns the apps) — production access
> must come from the app owner, not a tester account.

## Setup

```bash
npm install
```

## Config: `apps.json`

Add one entry per app. Each needs `package`, `appName`, `track`, and an `answers`
object whose keys are the 7 question prompts and values the text (each ≤300 chars).

```json
{
  "apps": [
    {
      "package": "com.nearbook",
      "appName": "NearBook",
      "track": "closed",
      "answers": {
        "How did you recruit users for your closed test?": "...",
        "..."
      }
    }
  ]
}
```

## Usage

```bash
node apply.js seed      # one-time: sign into your developer account (Chrome opens)
node apply.js status    # confirm signed in
node apply.js fill      # fill answers for all apps (DRY RUN, no submit)
node apply.js fill --app com.nearbook   # only one app
node apply.js fill --app com.a --app com.b   # several apps
node apply.js fill --submit             # fill AND submit
```

Options: `--config FILE`, `--profile-dir D`, `--app PACKAGE` (repeatable or
comma-separated), `--submit`, `--stop-on-error`, `--headless`, `--timeout MIN`.

Results are written to `apply-results-<timestamp>.jsonl`, and a screenshot is saved
per app so you can eyeball the filled form before submitting.
