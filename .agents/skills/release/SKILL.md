---
name: Release
description: Analyze commits since last release and publish with intelligent semantic version bumping.
---

# Release

Analyze all commits since the last version tag, determine the appropriate semantic version bump (major/minor/patch), and publish to npm.

## Version Bump Rules

Semantic versioning: `MAJOR.MINOR.PATCH`

| Change Type | Bump | Indicators |
|-------------|------|------------|
| **Breaking** | MAJOR | `BREAKING CHANGE:`, `!:` suffix, API removals, incompatible changes |
| **Feature** | MINOR | `feat:`, `feature:`, `add:`, new functionality, enhancements |
| **Bugfix** | PATCH | `fix:`, `bugfix:`, `patch:`, corrections, typos, small improvements |

The highest-impact change determines the bump (MAJOR > MINOR > PATCH).

## Instructions

### Step 1: Gather Release Context

Run these commands in parallel:

1. Get the last version tag:
   ```bash
   git describe --tags --abbrev=0
   ```

2. Get commits since last tag:
   ```bash
   git log $(git describe --tags --abbrev=0)..HEAD --oneline
   ```

3. Check npm login status:
   ```bash
   npm whoami 2>/dev/null || echo "NOT_LOGGED_IN"
   ```

### Step 2: Verify npm Authentication

Check the result of `npm whoami`:

**If logged in** (returns a username): Proceed to Step 3.

**If not logged in** (returns "NOT_LOGGED_IN" or error): Use browser-based authentication:

1. Connect to Chrome (with retry logic):
   - Call `mcp__claude-in-chrome__tabs_context_mcp` with `createIfEmpty: true`
   - If connection fails, wait 2 seconds and retry (up to 3 times)
   - If connected, create a new tab using `mcp__claude-in-chrome__tabs_create_mcp`
   - Note whether Chrome is available for later steps

2. Start `npm login` in the terminal with a pseudo-terminal to get the login URL:
   ```bash
   script -q /dev/null npm login --auth-type=web 2>&1
   ```

3. The command will output a URL like `https://www.npmjs.com/login?next=/login/cli/...`

4. Open the URL:
   - **If Chrome connected:** Navigate the browser tab to that URL using `mcp__claude-in-chrome__navigate`
   - **If Chrome unavailable:** Display the URL and ask user to open it manually

5. Inform the user: "Please complete the npm login in the browser window."

6. Wait for the login command to complete (it polls for authentication)

7. Verify login succeeded:
   ```bash
   npm whoami
   ```

8. If still not logged in, ask user if they want to retry or abort

### Step 3: Analyze Commits

For each commit since the last tag, classify it:

**Conventional Commit Patterns (primary):**
- `fix:`, `fix(scope):` → PATCH
- `feat:`, `feat(scope):` → MINOR
- `BREAKING CHANGE:` in body or `!:` → MAJOR
- `docs:`, `chore:`, `style:`, `refactor:`, `test:` → PATCH (maintenance)

**Content Analysis (for non-conventional commits):**
- Look at the commit message semantics
- "Add", "Implement", "Introduce" → likely MINOR
- "Fix", "Correct", "Repair", "Resolve" → likely PATCH
- "Remove", "Delete API", "Breaking" → likely MAJOR
- "Update", "Bump", "Improve" → likely PATCH
- Release commits ("Bump installer to...") → skip (don't count)

**When uncertain:** Default to PATCH unless the change clearly adds new functionality.

### Step 4: Present Analysis

Show the user:

```
Analyzing commits since vX.Y.Z...

Commit Analysis:
  [hash] [message] → [classification] ([bump type])
  [hash] [message] → [classification] ([bump type])
  ...

Summary:
  Breaking changes: N
  New features: N
  Bugfixes/maintenance: N

Highest impact: [MAJOR|MINOR|PATCH]
Proposed version: vX.Y.Z → vA.B.C

Proceed with release?
```

Wait for user confirmation before proceeding.

### Step 5: Execute Release

#### 5a. Connect to Chrome Browser

Before starting the release, establish a Chrome connection for browser-based npm authentication:

1. Call `mcp__claude-in-chrome__tabs_context_mcp` with `createIfEmpty: true`
2. If the connection fails (extension not connected error):
   - Wait 2 seconds and retry
   - Retry up to 3 times total
   - If all retries fail, inform the user: "Chrome browser extension is not available. You'll need to open the npm auth URL manually when prompted."
3. If connected, create a new tab using `mcp__claude-in-chrome__tabs_create_mcp`
4. Store the tab ID for later use

#### 5b. Run Release Script

Run the release script in background mode to capture the auth URL:

```bash
script -q /dev/null ./scripts/release.sh [patch|minor|major] 2>&1
```

The script will:
1. Validate agent configurations
2. Bump version in package.json files
3. Commit and tag the release
4. Push to git
5. Publish to npm with browser-based 2FA

#### 5c. Handle npm Authentication

Monitor the script output for the auth URL. When you see:
```
Authenticate your account at:
https://www.npmjs.com/auth/cli/[unique-id]
```

**If Chrome is connected:**
1. Navigate the browser tab to that URL using `mcp__claude-in-chrome__navigate`
2. Inform the user: "Please complete the npm authentication in the browser."

**If Chrome is not available:**
1. Display the full URL to the user
2. Inform them: "Please open this URL in your browser to authenticate."

Wait for the script to complete (npm polls for authentication).

### Step 6: Report Results

After successful release, show:
- New version number
- npm package URL
- Git tag created

## Edge Cases

**No commits since last tag:**
- Inform user there's nothing to release
- Ask if they want to force a patch bump anyway

**All commits are release/chore commits:**
- Default to PATCH bump
- Note that only maintenance commits were found

**Mixed signals in a commit:**
- If a commit adds a feature but also fixes a bug, classify by primary intent
- When truly ambiguous, ask the user

## Safety Rules

- Always show analysis and get confirmation before releasing
- Verify npm login before attempting to publish (use browser auth if needed)
- If any step fails, stop and report the error
- Don't push or publish without explicit user approval
