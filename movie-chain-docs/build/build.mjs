#!/usr/bin/env node
import puppeteer from 'puppeteer-core';
import { marked } from 'marked';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { execFile, execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DOCS = {
  masterclass: { src: 'src/masterclass.html', out: 'Multi-Tenant Architecture — A Masterclass.pdf',
                 title: 'Multi-Tenant Architecture — A Masterclass' },
  nest:        { src: 'src/prd-nest.html',    out: 'CineChain PRD — NestJS Edition.pdf',
                 title: 'CineChain PRD — NestJS Edition' },
  go:          { src: 'src/prd-go.html',      out: 'CineChain PRD — Go Edition.pdf',
                 title: 'CineChain PRD — Go Edition' },
  // Rendered FROM ../IMPLEMENTATION-PLAN.md so the Markdown stays the single
  // source of truth and the PDF can never drift away from what agents read.
  plan:        { src: 'src/plan.html',        out: 'CineChain — Implementation Plan.pdf',
                 title: 'CineChain — Implementation Plan', markdown: '../IMPLEMENTATION-PLAN.md' },
};
const GROUPS = { prd: ['nest', 'go'], all: ['masterclass', 'nest', 'go', 'plan'] };

// ---------------- argument parsing ----------------
const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
let names = argv.filter(a => !a.startsWith('--'));
if (!names.length) names = ['all'];

const targets = [...new Set(names.flatMap(n => {
  const k = n.toLowerCase();
  if (GROUPS[k]) return GROUPS[k];
  if (DOCS[k]) return [k];
  if (k === 'golang') return ['go'];
  if (k === 'masterclass' || k === 'guide') return ['masterclass'];
  console.error(`Unknown target "${n}". Try: masterclass | nest | go | prd | all`);
  process.exit(1);
}))];

const openAfter = flags.has('--open');
const htmlOnly  = flags.has('--html');

// ---------------- shared assets ----------------
// fonts.css carries absolute file:// URLs. Rewrite them to wherever this
// project currently lives, so moving the folder never silently drops the
// fonts (Chrome substitutes a fallback face without erroring).
const fontsCss = readFileSync(`${ROOT}/src/fonts/fonts.css`, 'utf8')
  .replace(/file:\/\/\S*?\/src\/fonts\//g, `file://${ROOT}/src/fonts/`);
const css = fontsCss + '\n' + readFileSync(`${ROOT}/src/style.css`, 'utf8');

const dgDir = `${ROOT}/src/diagrams`;
const diagrams = {};
if (existsSync(dgDir)) for (const f of readdirSync(dgDir))
  if (f.endsWith('.svg')) diagrams[f.replace(/\.svg$/, '')] = readFileSync(`${dgDir}/${f}`, 'utf8');

let problems = 0;
function assemble(srcPath, title, markdownPath) {
  let body = readFileSync(resolve(ROOT, srcPath), 'utf8');

  // {{md}} → the Markdown source, rendered. Keeps one source of truth.
  if (markdownPath) {
    const md = readFileSync(resolve(ROOT, markdownPath), 'utf8');
    body = body.replace('{{md}}', marked.parse(md, { mangle: false, headerIds: false }));
  }
  for (let i = 0; i < 4; i++)
    body = body.replace(/\{\{inc:([a-z0-9_-]+)\}\}/gi, (_m, n) => {
      const f = `${ROOT}/src/prd/${n}.html`;
      if (!existsSync(f)) { console.error(`   ! missing include: ${n}`); problems++; return ''; }
      return readFileSync(f, 'utf8');
    });
  body = body.replace(/\{\{d:([a-z0-9_-]+)\}\}/gi, (_m, n) => {
    if (!diagrams[n]) { console.error(`   ! missing diagram: ${n}`); problems++; return ''; }
    return diagrams[n];
  });
  const left = body.match(/\{\{[^}]+\}\}/g);
  if (left) { console.error(`   ! unresolved: ${[...new Set(left)].join(', ')}`); problems++; }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
       + `<title>${title}</title><style>${css}</style></head><body>${body}</body></html>`;
}

function footer(title) {
  return `<div style="width:100%;font-family:Inter,Helvetica,Arial,sans-serif;font-size:7.5pt;`
    + `color:#7a8596;padding:0 16mm;display:flex;justify-content:space-between;align-items:center;`
    + `-webkit-print-color-adjust:exact"><span style="letter-spacing:.06em">${title}</span>`
    + `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;
}

const openInChrome = f =>
  execFile('google-chrome', [f], { detached: true, stdio: 'ignore' }).unref();

// ---------------- build ----------------
mkdirSync(`${ROOT}/dist`, { recursive: true });
const built = [];
const t0 = Date.now();

if (htmlOnly) {
  for (const k of targets) {
    const d = DOCS[k];
    const f = `${ROOT}/dist/${k}.html`;
    writeFileSync(f, assemble(d.src, d.title, d.markdown));
    console.log(`  ${k.padEnd(12)} → dist/${k}.html`);
    built.push(f);
  }
} else {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--font-render-hinting=none'],
  });
  for (const k of targets) {
    const d = DOCS[k];
    const tmp = `${ROOT}/build/.render-${k}.html`;
    writeFileSync(tmp, assemble(d.src, d.title, d.markdown));

    const page = await browser.newPage();
    await page.goto('file://' + tmp, { waitUntil: 'networkidle0', timeout: 120000 });
    await page.evaluate(() => document.fonts.ready);

    const base = { printBackground: true, preferCSSPageSize: true, headerTemplate: '<div></div>' };
    const cov = `${ROOT}/build/.cover-${k}.pdf`, bod = `${ROOT}/build/.body-${k}.pdf`;
    // cover printed without a footer, then merged back on
    await page.pdf({ ...base, path: cov, pageRanges: '1', displayHeaderFooter: false });
    await page.pdf({ ...base, path: bod, pageRanges: '2-', displayHeaderFooter: true,
                     footerTemplate: footer(d.title) });
    await page.close();

    const out = `${ROOT}/dist/${d.out}`;
    execFileSync('pdfunite', [cov, bod, out]);
    const pages = execFileSync('pdfinfo', [out], { encoding: 'utf8' }).match(/Pages:\s+(\d+)/)?.[1] ?? '?';
    console.log(`  ${k.padEnd(12)} → ${d.out}  (${pages} pages)`);
    built.push(out);
  }
  await browser.close();
}

console.log(`\n  ${built.length} document(s) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
          + (problems ? `  —  ${problems} problem(s), see above` : ''));
if (openAfter) { built.forEach(openInChrome); console.log('  opening in Chrome…'); }
process.exit(problems ? 1 : 0);
