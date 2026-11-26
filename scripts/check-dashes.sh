#!/bin/sh
# No em dash in the skills, their tests or the docs. A path that does not exist yet is skipped.
set -u
dash=$(printf '\342\200\224')
found=0
for p in skills/job-search skills/writing skills/loop-base skills/gtm tests README.md package.json .github scripts; do
  [ -e "$p" ] || continue
  if grep -rn "$dash" "$p"; then found=1; fi
done
exit $found
