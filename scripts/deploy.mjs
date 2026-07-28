// Publish the built game to both places it lives.
//
//   1. this repo's docs/ folder  -> GitHub Pages (joelcomm.github.io/mayhem/)
//   2. joelcomm/Mobile-fun, gh-pages branch, mayhem/  -> Netlify, which serves
//      games.aiforeveryoneshow.com/mayhem/
//
// Two targets is how they drift. `npm run deploy` builds once and pushes the same
// artifact to both, so they cannot disagree. The Mobile-fun push uses a throwaway
// clone on purpose: that repo has a local working copy with unrelated work in
// progress on another branch, and this must never touch it.
import { execSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BUILT = 'docs/index.html';
const HUB_REPO = 'https://github.com/joelcomm/Mobile-fun.git';
const HUB_BRANCH = 'gh-pages';

if (!existsSync(BUILT)) {
  console.error(`✗ ${BUILT} missing — run \`npm run build\` first.`);
  process.exit(1);
}
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
const capture = (cmd, cwd) => execSync(cmd, { cwd, encoding: 'utf8' }).trim();

// ---- 1. this repo ----
run('git add docs && git commit -m "Deploy: rebuild docs/" --allow-empty -q');
run('git push -q');
console.log('✓ pushed docs/ — GitHub Pages will publish shortly');

// ---- 2. the Netlify hub ----
const tmp = mkdtempSync(join(tmpdir(), 'mayhem-hub-'));
run(`git clone -q --depth 1 -b ${HUB_BRANCH} ${HUB_REPO} .`, tmp);
mkdirSync(join(tmp, 'mayhem'), { recursive: true });
copyFileSync(BUILT, join(tmp, 'mayhem', 'index.html'));
// Netlify serves the hub with a long-lived default, and browsers hung on to an old copy
// of the game for hours — you would open it on another machine and get a build from days
// ago, title and all. This forces a revalidation on our page only. The rule is SCOPED to
// /mayhem/*: this repo is shared with a dozen other games and their caching is not ours
// to change. Appended rather than overwritten, so anything added here later survives.
{
  const hp = join(tmp, '_headers');
  const MARK = '# --- public nuisance (managed by driver/scripts/deploy.mjs) ---';
  let cur = existsSync(hp) ? readFileSync(hp, 'utf8') : '';
  if (!cur.includes(MARK)) {
    const block = `${MARK}\n/mayhem/*\n  Cache-Control: public, max-age=0, must-revalidate\n`;
    writeFileSync(hp, cur ? cur.replace(/\s*$/, '\n\n') + block : block);
    console.log('· added a no-cache rule for /mayhem/* to the hub _headers');
  }
}
run('git add mayhem _headers', tmp);
// Only skip when the artifact is genuinely identical. Any other failure (a 403 on
// push, a network error, a rejected non-fast-forward) must crash the deploy loudly —
// a swallowed catch here is how the hub silently drifts stale, as it did before.
if (capture('git status --porcelain mayhem', tmp) === '') {
  console.log('· hub unchanged (already up to date)');
} else {
  run('git commit -q -m "Update Public Nuisance"', tmp);
  run(`git push -q origin ${HUB_BRANCH}`, tmp);
  console.log('✓ pushed to Mobile-fun/gh-pages — games.aiforeveryoneshow.com/mayhem/');
}
