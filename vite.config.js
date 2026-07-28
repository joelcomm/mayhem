import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The build deliberately produces ONE self-contained docs/index.html.
//
// That is not nostalgia for the old single-file setup — it is what keeps deployment
// trivial. This game ships to two places (GitHub Pages on this repo, and the Netlify
// hub at games.aiforeveryoneshow.com/mayhem/), and both are "copy one file". A normal
// chunked build would mean shipping a dist/ tree and getting asset base paths right on
// two different hosts. Inlining three costs ~600 KB but buys an artifact you can drop
// anywhere, open with file://, and email to someone.
//
// Output goes to docs/ rather than dist/ so GitHub Pages can serve it straight from
// the branch with no extra workflow.
// A build stamp baked in at compile time. Browsers hold on to this page harder than you
// expect, and "is this the new build?" was otherwise unanswerable without diffing the
// file — you cannot tell a stale tab from a fresh one by looking at it. The stamp is
// printed to the console on load and shown in the pause panel.
const BUILD_STAMP = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD_STAMP) },
  base: './',                       // relative asset paths: works at / and at /mayhem/
  build: {
    outDir: 'docs',
    emptyOutDir: true,
    target: 'es2020',
    assetsInlineLimit: 100000000,   // inline everything
    chunkSizeWarningLimit: 4000,
  },
  plugins: [viteSingleFile()],
});
