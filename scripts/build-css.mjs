/**
 * Builds public/css/app.css from the Tailwind classes used in public/**.
 * Uses Tailwind CSS v4's programmatic compiler, so no CLI or PostCSS is needed:
 *
 *     npm install --save-dev tailwindcss     (once, needs internet)
 *     npm run build:css
 *
 * The built file is committed, so the demo machine needs neither Node build tools nor internet.
 */
import { compile } from 'tailwindcss';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const twDir = path.dirname(require.resolve('tailwindcss/package.json'));

const input = `
@import "tailwindcss";
@theme {
  --color-brand-50: #effcf9;  --color-brand-100: #c8f6ee; --color-brand-200: #93ebdd;
  --color-brand-300: #55d8c9; --color-brand-400: #27bdb1; --color-brand-500: #14a099;
  --color-brand-600: #0e817d; --color-brand-700: #0f6766; --color-brand-800: #115253; --color-brand-900: #124445;
}
button:not(:disabled), [role="button"] { cursor: pointer; }
`;

const loadStylesheet = async (id, base) => {
  let file;
  if (id === 'tailwindcss') file = path.join(twDir, 'index.css');
  else if (id.startsWith('tailwindcss/')) file = path.join(twDir, id.slice('tailwindcss/'.length));
  else file = path.resolve(base, id);
  return { path: file, base: path.dirname(file), content: fs.readFileSync(file, 'utf8') };
};

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['css', 'vendor'].includes(e.name)) walk(p, out); }
    else if (/\.(html|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const candidates = new Set();
for (const f of walk(path.join(root, 'public'))) {
  for (const tok of fs.readFileSync(f, 'utf8').split(/[\s"'`<>{}\\,;]+/)) if (tok) candidates.add(tok);
}

const compiler = await compile(input, { base: root, loadStylesheet });
const css = compiler.build([...candidates]);
fs.writeFileSync(path.join(root, 'public', 'css', 'app.css'), css);
console.log(`public/css/app.css written (${(css.length / 1024).toFixed(1)} KB from ${candidates.size} candidate tokens)`);
