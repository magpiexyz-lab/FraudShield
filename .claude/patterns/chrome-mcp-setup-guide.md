# Chrome MCP Setup Guide for Google Ads

When Claude Code detects that Chrome MCP tools are not available, show
this guide to the user. Reference this file — do NOT inline a shortened
version (users need the full steps).

---

## Step 1: Install the Claude-in-Chrome Extension

1. Open Google Chrome
2. Go to the Chrome Web Store and search for **"Claude-in-Chrome"**
   (or ask your team lead for the direct install link)
3. Click **"Add to Chrome"** → Confirm the installation
4. You should see the Claude icon appear in your Chrome toolbar (top-right)

## Step 2: Connect the Extension to Claude Code

1. Click the Claude icon in your Chrome toolbar
2. The extension should show a **"Connected"** status
   - If it shows "Disconnected", click **"Connect"** and follow the prompts
3. Back in your terminal where Claude Code is running, verify the connection:
   - Claude Code should now detect `mcp__claude-in-chrome__*` tools
   - If not, try restarting Claude Code (`/exit` then re-launch)

## Step 3: Log into Google Ads

1. In Chrome, go to https://ads.google.com
2. Log in with your Google account that has access to the team's MCC
3. Make sure you can see your **sub-account** (not the MCC top level)
   - Your campaigns should be visible under your sub-account
4. **Keep this Chrome tab open** — Claude Code will interact with it

## Step 4: Verify Everything Works

Once all three steps are done, re-run the command that brought you here:
- `/distribute phase-1` — to create a campaign
- `/iterate --check` — to monitor a campaign
- `/iterate --cross` — to evaluate all MVPs (Team Lead only)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Extension not visible in toolbar | Click the puzzle icon (Extensions) → Pin "Claude-in-Chrome" |
| Extension shows "Disconnected" | Close and reopen Chrome, then click Connect again |
| Claude Code doesn't detect Chrome tools | Restart Claude Code session |
| Google Ads asks for account selection | Select your sub-account (not the MCC manager account) |
| "You don't have access" in Google Ads | Ask your team lead to add your Google account to the MCC |
