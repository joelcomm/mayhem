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
import { mkdtempSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
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

// ---- 1. this repo ----
run('git add docs && git commit -m "Deploy: rebuild docs/" --allow-empty -q');
run('git push -q');
console.log('✓ pushed docs/ — GitHub Pages will publish shortly');

// ---- 2. the Netlify hub ----
const tmp = mkdtempSync(join(tmpdir(), 'mayhem-hub-'));
run(`git clone -q --depth 1 -b ${HUB_BRANCH} ${HUB_REPO} .`, tmp);
mkdirSync(join(tmp, 'mayhem'), { recursive: true });
copyFileSync(BUILT, join(tmp, 'mayhem', 'index.html'));
try {
  run('git add mayhem && git commit -q -m "Update Maplewood Mayhem"', tmp);
  run(`git push -q origin ${HUB_BRANCH}`, tmp);
  console.log('✓ pushed to Mobile-fun/gh-pages — games.aiforeveryoneshow.com/mayhem/');
} catch {
  console.log('· hub unchanged (nothing new to publish)');
}
