#!/bin/bash
set -euo pipefail
S="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"  
M="${NANOCLAW_REPO:?set NANOCLAW_REPO to a nanoclaw checkout holding the four feature branches}"
O=$S/verify-out; rm -rf "$O"; mkdir -p "$O"
echo "== registry from current tips"
git -C $M push -q --force $S/registry.git feat/ollama-launch-finish:refs/heads/main feat/ollama-provider-finish:refs/heads/providers feat/local-web-channel-finish:refs/heads/channels
git -C $S/registry.git for-each-ref --format='   %(refname:short) %(objectname:short) %(subject)'
rm -rf $S/composed; git clone -q -b main $S/registry.git $S/composed; cd $S/composed
pnpm install --frozen-lockfile > "$O/pnpm-install.out" 2>&1; tail -1 "$O/pnpm-install.out"
(cd container/agent-runner && bun install --frozen-lockfile > "$O/bun-install.out" 2>&1); tail -1 "$O/bun-install.out"
echo "== registry harness (real fetch path, each skill alone)"
pnpm exec tsx scripts/test-registry-skills.ts --all add-ollama-provider add-local-web-chat > "$O/harness.out" 2>&1; grep -E 'PASS|FAIL|registry skills passed' "$O/harness.out"
echo "== apply both skills into the composed clone"
sed -i '' "s#$S/composed/scripts/skill-apply.js#$S/composed/scripts/skill-apply.js#" $S/apply-both.mts
pnpm exec tsx $S/apply-both.mts > "$O/apply.out" 2>&1; grep -E 'FULLY|NOT FULLY' "$O/apply.out"
test "$(grep -c '] FULLY APPLIED' "$O/apply.out")" = 2
echo "== host tsc"; pnpm run build > "$O/tsc.out" 2>&1 && echo "   clean"
echo "== vitest (full)"; pnpm exec vitest run > "$O/vitest.out" 2>&1 || true
grep -E 'Test Files|^\s+Tests ' "$O/vitest.out" | sed 's/^/   /'
unexpected=$( (grep -E '^ FAIL ' "$O/vitest.out" || true) | (grep -v 'scripts/update/transaction.e2e.test.ts' || true) | wc -l | tr -d ' ')
test "$unexpected" = 0 || { echo "unexpected vitest failures:"; grep -E '^ FAIL ' "$O/vitest.out" | grep -v transaction.e2e | head; exit 1; }
echo "   only known env failure: scripts/update/transaction.e2e.test.ts"
echo "== container tsc"; pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit > "$O/ctsc.out" 2>&1 && echo "   clean"
echo "== bun test (full)"; (cd container/agent-runner && bun test > "$O/bun.out" 2>&1); grep -E '^\s*[0-9]+ (pass|fail)' "$O/bun.out" | sed 's/^/   /'; test "$(grep -E '^\s*[0-9]+ fail' "$O/bun.out" | awk '{print $1}')" = 0
echo "== lint"; pnpm run lint > "$O/lint.out" 2>&1 || true; grep -E 'problems' "$O/lint.out" | sed 's/^/   /'; ! grep -qE '[1-9][0-9]* errors?' "$O/lint.out"
echo "== contract verifier (composed clone)"; pnpm exec tsx scripts/provider-contract-verifier.ts --required-declared ollama > "$O/verifier.out" 2>&1 && echo "   passed" || { tail -20 "$O/verifier.out"; exit 1; }
echo "== prettier on payload files"; pnpm exec prettier --check src/providers/ollama.ts src/providers/ollama.test.ts src/provider-contracts/ollama.ts container/agent-runner/src/provider-contracts/ollama.ts container/agent-runner/src/providers/ollama.ts > "$O/prettier.out" 2>&1 && echo "   clean" || { tail -5 "$O/prettier.out"; exit 1; }
echo "== VERIFY DONE"
if [ "${RENEW:-0}" = 1 ]; then bash $S/renew-e2e.sh; echo "== ALL DONE"; fi
