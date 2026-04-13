#!/bin/bash
set -e

# Release script for @hoverlover/cc-discord
# Usage: ./scripts/release.sh [patch|minor|major]

BUMP=${1:-patch}
if [[ ! "$BUMP" =~ ^(patch|minor|major)$ ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "📦 Releasing @hoverlover/cc-discord"
echo "   Bump type: $BUMP"
echo ""

# Check we're on main branch
BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$BRANCH" != "main" ]; then
  echo -e "${RED}Error: Must be on main branch to release (currently on $BRANCH)${NC}"
  exit 1
fi

# Check working directory is clean
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${RED}Error: Working directory is not clean. Commit or stash changes first.${NC}"
  git status --short
  exit 1
fi

# Pull latest changes
echo "⬇️  Pulling latest changes..."
git pull origin main

# Get current version
CURRENT_VERSION=$(node -p "require('./package.json').version")
echo "   Current version: v$CURRENT_VERSION"

# Calculate new version
NEW_VERSION=$(node -p "
  const [major, minor, patch] = '$CURRENT_VERSION'.split('.').map(Number);
  if ('$BUMP' === 'major') console.log(\`\${major + 1}.0.0\`);
  else if ('$BUMP' === 'minor') console.log(\`\${major}.\${minor + 1}.0\`);
  else console.log(\`\${major}.\${minor}.\${patch + 1}\`);
")
echo "   New version: v$NEW_VERSION"
echo ""

# Update version in package.json
echo "📝 Updating package.json..."
npm version $BUMP --no-git-tag-version

# Commit the version bump
echo "📝 Committing version bump..."
git add package.json
if [ -f package-lock.json ]; then
  git add package-lock.json
fi
git commit -m "chore(release): v$NEW_VERSION"

# Create git tag
echo "🏷️  Creating git tag..."
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

# Push to remote
echo "⬆️  Pushing to git..."
git push origin main
git push origin "v$NEW_VERSION"

# Publish to npm with browser-based 2FA
echo ""
echo "📤 Publishing to npm..."
echo "   You may need to authenticate in your browser..."
echo ""
npm publish --access public

echo ""
echo -e "${GREEN}✅ Release complete!${NC}"
echo "   Version: v$NEW_VERSION"
echo "   npm: https://www.npmjs.com/package/@hoverlover/cc-discord/v/$NEW_VERSION"
echo "   Tag: v$NEW_VERSION"
