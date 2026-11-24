#!/bin/sh
# Every skills/*/SKILL.md must parse the way `npx skills add` parses it: a skipped skill is a failure.
set -u
HOME_DIR=$(mktemp -d)
esc=$(printf '\033')
out=$(HOME="$HOME_DIR" npx -y skills@1.9.0 add . --list 2>&1 | sed "s/${esc}\[[0-9;?]*[a-zA-Z]//g")
rm -rf "$HOME_DIR"
echo "$out"
if echo "$out" | grep -q 'SKILLS_SKILL_SKIPPED'; then
  echo "check-skills: a SKILL.md was skipped (see above)" >&2
  exit 1
fi
want=$(ls skills/*/SKILL.md | wc -l | tr -d ' ')
if ! echo "$out" | grep -q "Found $want skills"; then
  echo "check-skills: expected $want skills" >&2
  exit 1
fi
