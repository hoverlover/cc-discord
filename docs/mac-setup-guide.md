# macOS Headless Server Setup Guide

This guide walks through configuring a Mac (e.g., Mac mini) as a headless server for running cc-discord. It covers system security changes, permissions, auto-login, and service management required for unattended operation.

> **⚠️ Security Notice:** Several steps in this guide weaken macOS security protections. These tradeoffs are acceptable for a dedicated server machine but should **not** be applied to a primary workstation. See [Security Tradeoffs](#security-tradeoffs) for details.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Disable System Integrity Protection (SIP)](#1-disable-system-integrity-protection-sip)
3. [Configure TCC Permissions](#2-configure-tcc-permissions)
4. [FileVault Considerations](#3-filevault-considerations)
5. [Enable Auto Login](#4-enable-auto-login)
6. [Install cc-discord](#5-install-cc-discord)
7. [Configure the LaunchDaemon](#6-configure-the-launchdaemon)
8. [Verify the Setup](#7-verify-the-setup)
9. [Security Tradeoffs](#security-tradeoffs)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- macOS (tested on macOS 26.x / Sequoia)
- [Bun](https://bun.sh) runtime installed (`curl -fsSL https://bun.sh/install | bash`)
- Admin access to the machine
- Physical access (or remote screen sharing) for Recovery Mode steps

---

## 1. Disable System Integrity Protection (SIP)

SIP must be disabled to modify the TCC database, which controls app permissions for automation, accessibility, and more.

### Steps

1. **Shut down** the Mac completely
2. **Boot into Recovery Mode:**
   - Apple Silicon: Hold the power button until "Loading startup options" appears → click **Options**
   - Intel: Hold `Cmd + R` during boot
3. Open **Terminal** from the Utilities menu
4. Run:
   ```bash
   csrutil disable
   ```
5. Restart the Mac

### Verify SIP is disabled

```bash
csrutil status
# Should show: System Integrity Protection status: disabled.
```

---

## 2. Configure TCC Permissions

TCC (Transparency, Consent, and Control) manages per-app permissions for things like Automation, Accessibility, Full Disk Access, etc. For headless operation, scripts and services need these permissions granted without GUI prompts.

### Option A: Reset and Auto-Approve (Recommended)

This approach resets the TCC database and sets up a LaunchAgent that automatically approves new permission requests.

#### Reset the user-level TCC database

```bash
# Back up first
cp ~/Library/Application\ Support/com.apple.TCC/TCC.db ~/Library/Application\ Support/com.apple.TCC/TCC.db.bak

# Reset it
tccutil reset All
```

#### Set all existing user-level entries to "allowed"

```bash
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "UPDATE access SET auth_value = 2 WHERE auth_value = 0;"
```

#### Create an auto-approve LaunchAgent

This runs every 60 seconds and flips any newly denied entries to allowed:

```bash
cat > ~/Library/LaunchAgents/com.tcc-auto-approve.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.tcc-auto-approve</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>-c</string>
    <string>sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "UPDATE access SET auth_value = 2 WHERE auth_value = 0;"</string>
  </array>

  <key>StartInterval</key>
  <integer>60</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>/tmp/tcc-auto-approve.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/tcc-auto-approve-err.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.tcc-auto-approve.plist
```

### Option B: Manual Per-App Approval

If you prefer tighter control, you can manually grant specific permissions:

```bash
# Example: Grant Accessibility to Terminal
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, indirect_object_identifier) \
   VALUES ('kTCCServiceAccessibility', 'com.apple.Terminal', 0, 2, 0, 'UNUSED');"
```

> **Note:** SIP must be disabled for direct TCC database modifications to work.

---

## 3. FileVault Considerations

FileVault provides full-disk encryption. There's a tradeoff between security and true headless boot:

### With FileVault ON (more secure)

- Mac boots to a **pre-boot login screen** — you must enter your password before macOS loads
- LaunchAgents/LaunchDaemons **won't start** until after you authenticate
- After a power outage, the server won't be fully operational until you log in remotely or physically
- **Remote access:** You can use Apple Remote Desktop or screen sharing to type the FileVault password remotely (requires another device on the same network)

### With FileVault OFF (fully headless)

- Mac boots straight to macOS
- Combined with Auto Login, services start automatically with **zero interaction**
- Disk contents are **not encrypted** — anyone with physical access to the drive can read data
- **Recommended for:** Dedicated servers in physically secure locations

### To disable FileVault

```bash
sudo fdesetup disable
```

> Decryption happens in the background and may take hours depending on disk size.

---

## 4. Enable Auto Login

Auto Login bypasses the macOS login screen so that LaunchAgents start automatically after boot.

> **Note:** Auto Login requires FileVault to be **disabled**. macOS will not allow both simultaneously.

### Via System Settings (GUI)

1. Open **System Settings** → **Users & Groups**
2. Click **Login Options** (or the ⓘ icon)
3. Set **Automatic login** to your user account

### Via Command Line

```bash
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "your-username"
```

### Disable the login screen password prompt

```bash
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser -string "your-username"
sudo defaults delete /Library/Preferences/com.apple.loginwindow GuestEnabled 2>/dev/null
```

---

## 5. Install cc-discord

### Install Bun (if not already installed)

```bash
curl -fsSL https://bun.sh/install | bash
```

### Verify Bun is available

```bash
~/.bun/bin/bun --version
```

### Test cc-discord runs manually

```bash
~/.bun/bin/bunx @hoverlover/cc-discord@latest
```

> Configure your `.env.relay` and `.env.worker` files in `~/.config/cc-discord/` before proceeding. See the main [README](../README.md) for configuration details.

---

## 6. Configure the LaunchDaemon

A LaunchDaemon starts at boot (before user login) and runs as a system service. This is the recommended approach for a headless server.

> **Alternative:** If you keep FileVault enabled, a LaunchAgent (in `~/Library/LaunchAgents/`) works just as well, since services won't start until after login anyway.

### LaunchDaemon (starts at boot, before login)

Create the plist:

```bash
sudo tee /Library/LaunchDaemons/com.cc-discord.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-discord</string>

  <key>UserName</key>
  <string>your-username</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/your-username/.bun/bin/bunx</string>
    <string>@hoverlover/cc-discord@latest</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/your-username</string>
    <key>PATH</key>
    <string>/Users/your-username/.bun/bin:/Users/your-username/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>/Users/your-username</string>

  <key>StandardOutPath</key>
  <string>/tmp/cc-discord/launchd-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/cc-discord/launchd-stderr.log</string>
</dict>
</plist>
EOF
```

> Replace `your-username` with your macOS username (e.g., `cboyd-mac-mini`).

### Set ownership and load

```bash
sudo chown root:wheel /Library/LaunchDaemons/com.cc-discord.plist
sudo chmod 644 /Library/LaunchDaemons/com.cc-discord.plist
sudo launchctl load /Library/LaunchDaemons/com.cc-discord.plist
```

### LaunchAgent Alternative (starts after login)

If you prefer a LaunchAgent (e.g., with FileVault enabled):

```bash
cat > ~/Library/LaunchAgents/com.cc-discord.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.cc-discord</string>

  <key>ProgramArguments</key>
  <array>
    <string>/Users/your-username/.bun/bin/bunx</string>
    <string>@hoverlover/cc-discord@latest</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/your-username</string>
    <key>PATH</key>
    <string>/Users/your-username/.bun/bin:/Users/your-username/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>WorkingDirectory</key>
  <string>/Users/your-username</string>

  <key>StandardOutPath</key>
  <string>/tmp/cc-discord/launchd-stdout.log</string>

  <key>StandardErrorPath</key>
  <string>/tmp/cc-discord/launchd-stderr.log</string>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.cc-discord.plist
```

---

## 7. Verify the Setup

### Check the service is running

```bash
# For LaunchDaemon
sudo launchctl list | grep cc-discord

# For LaunchAgent
launchctl list | grep cc-discord
```

A running service shows a PID in the first column:

```
479   0   com.cc-discord
```

### Check logs

```bash
# Startup logs
cat /tmp/cc-discord/launchd-stdout.log

# Error logs
cat /tmp/cc-discord/launchd-stderr.log

# Application logs
cat /tmp/cc-discord/logs/relay.log
```

### Test a full reboot

```bash
sudo reboot
```

After the machine comes back up, verify the service is running and responding to Discord messages.

---

## Security Tradeoffs

Here's a summary of what's been changed and the implications:

| Change | What It Does | Risk |
|--------|-------------|------|
| **SIP disabled** | Allows modifying system-protected files and the TCC database | Malware could modify system files; reduced OS integrity |
| **TCC auto-approve** | Automatically grants permission requests for automation, accessibility, etc. | Any process can gain permissions without user consent |
| **FileVault off** | Removes disk encryption | Physical access to the drive exposes all data |
| **Auto Login** | Bypasses login screen | Physical access gives immediate desktop access |

### Mitigations

- **Keep the Mac in a physically secure location** (locked room/closet)
- **Keep sudo authentication enabled** — even with the above changes, root access still requires a password
- **Use a firewall** — macOS built-in firewall + network-level firewalls limit remote attack surface
- **Keep macOS updated** — security patches still apply and matter
- **Use SSH keys** instead of password authentication for remote access
- **Monitor logs** — check `/tmp/cc-discord/logs/` periodically for unexpected activity

---

## Troubleshooting

### Service won't start after reboot

1. Check if the plist is loaded:
   ```bash
   sudo launchctl list | grep cc-discord
   ```
2. Check for errors:
   ```bash
   cat /tmp/cc-discord/launchd-stderr.log
   ```
3. Verify Bun is accessible from the configured PATH:
   ```bash
   /Users/your-username/.bun/bin/bun --version
   ```

### TCC prompts still appearing

1. Verify SIP is disabled: `csrutil status`
2. Check the auto-approve agent is running: `launchctl list | grep tcc`
3. Manually run the approval query:
   ```bash
   sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db \
     "UPDATE access SET auth_value = 2 WHERE auth_value = 0;"
   ```

### "Operation not permitted" errors

This usually means SIP is still enabled or you're trying to modify the system-level TCC database (`/Library/Application Support/com.apple.TCC/TCC.db`) which requires additional steps. The user-level database is at `~/Library/Application Support/com.apple.TCC/TCC.db`.

### Service keeps restarting (crash loop)

1. Check error logs for the root cause
2. Verify environment variables are correct in the plist
3. Test running the command manually:
   ```bash
   HOME=/Users/your-username /Users/your-username/.bun/bin/bunx @hoverlover/cc-discord@latest
   ```
4. If `bunx` is downloading a new version, the KeepAlive restart timer may interfere. Wait for the download to complete.

### Can't access Mac remotely after reboot

- **With FileVault:** You need to enter the password at the pre-boot screen. Use Apple Remote Desktop or screen sharing from another device on the same network.
- **Without FileVault + Auto Login:** SSH should be available after boot. Enable Remote Login in **System Settings → General → Sharing → Remote Login**.
