---
name: send-imessage
description: Use when the user asks to "send a text", "send an iMessage", "text someone", "send a message to [phone number]", "message [person]", or discusses sending SMS/iMessage. Also use when scheduling text messages or automating iMessage delivery.
---

# Send iMessage

Send text messages via macOS Messages.app using the `send-imessage` CLI tool. This skill enables sending iMessages and SMS directly from the Mac.

## When This Skill Applies

- User asks to send a text message or iMessage
- User asks to text someone (by name, phone number, or Apple ID)
- User wants to schedule or automate text message delivery
- User asks about messaging capabilities

## Tool Usage

The `send-imessage` tool is available as a Bash command:

```bash
send-imessage --to "<recipient>" "<message>"
```

### Parameters

| Flag | Required | Description |
|------|----------|-------------|
| `--to` | Yes | Phone number (10-digit US or with +1) or Apple ID email |
| `--sms` | No | Force SMS delivery instead of iMessage |
| `"message"` | Yes | The message text (positional argument) |

### Examples

```bash
# Send to a US phone number (auto-normalizes to +1)
send-imessage --to "4175551234" "Hey, just checking in!"

# Send to a number with country code
send-imessage --to "+14175551234" "Meeting at 3pm"

# Send to an Apple ID email
send-imessage --to "user@icloud.com" "Hello from Alfred!"

# Force SMS instead of iMessage
send-imessage --to "4175551234" --sms "This is an SMS"
```

## Phone Number Handling

The tool auto-normalizes US phone numbers:
- `4175551234` (10 digits) becomes `+14175551234`
- `14175551234` (11 digits) becomes `+14175551234`
- `+14175551234` stays as-is
- International numbers should include the `+` prefix

## Important Notes

- **macOS only**: This tool uses AppleScript and requires macOS with Messages.app
- **Apple ID required**: The Mac must be signed into an Apple ID with iMessage enabled
- **First-run permissions**: macOS may prompt for automation permissions the first time
- **Delivery**: iMessage is used by default; use `--sms` flag to force SMS
- **No read receipts**: The tool can only send, not read incoming messages
- **Rate limiting**: Avoid sending many messages in rapid succession to prevent Apple throttling

## Error Handling

If the send fails:
1. Check that Messages.app is running and signed in
2. Verify the recipient phone number or Apple ID is correct
3. Check that macOS automation permissions are granted for the terminal/process
4. Try the `--sms` flag if iMessage delivery fails

## Combining with Scheduling

Use cron or systemd timers to schedule messages:

```bash
# Example: send a daily 9am reminder
# crontab entry:
# 0 9 * * * /path/to/tools/send-imessage --to "4175551234" "Good morning! Don't forget your standup."
```
