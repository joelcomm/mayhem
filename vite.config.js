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
export default defineConfig({
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
