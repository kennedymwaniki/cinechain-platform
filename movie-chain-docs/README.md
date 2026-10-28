# CineChain documentation

Four PDFs, built from HTML + 33 hand-authored SVG diagrams by headless Chrome.

| Document | Source | Pages |
|---|---|---|
| Multi-Tenant Architecture — A Masterclass | `src/masterclass.html` | 57 |
| CineChain PRD — NestJS Edition | `src/prd-nest.html` | 76 |
| CineChain PRD — Go Edition | `src/prd-go.html` | 76 |
| CineChain — Implementation Plan | `../IMPLEMENTATION-PLAN.md` → `src/plan.html` | 48 |

The implementation plan is rendered **from the Markdown at the repo root**, which is what AI agents
read. Edit the Markdown, rebuild, and the PDF follows — the two cannot drift apart.

## Setup

```bash
npm install          # once
```

Run from this directory. There is one `package.json` here and another in `movie-chain-api/`;
they are independent projects.

## Preview commands

Each builds the document **and opens it in Chrome**:

```bash
npm run masterclass    # the multi-tenancy guide
npm run plan           # the 27-step implementation plan
npm run nest           # PRD, NestJS/TypeScript edition
npm run golang         # PRD, Go edition   (npm run go also works)
npm run prd            # both PRD editions
npm run all            # all four
```

Build without opening:

```bash
npm run build          # all four → dist/
npm run build -- plan  # just one
```

Fast HTML preview — no PDF, reflows to the window, good while editing:

```bash
npm run html:masterclass
npm run html:nest
npm run html:go
```

Other: `npm run open` (open what's already built), `npm run clean`.

## Layout

```
src/
  masterclass.html      the guide (single file)
  plan.html             cover + {{md}} placeholder for the Markdown plan
  prd-nest.html         PRD cover + {{inc:…}} includes
  prd-go.html           identical except sections 11–12
  prd/*.html            PRD sections s1…s17, shared between both editions
  diagrams/*.svg        33 diagrams, injected via {{d:name}}
  style.css             the design system (print CSS, components, SVG classes)
  fonts/                Inter, Source Serif 4, JetBrains Mono (local woff2)
build/build.mjs         the builder
dist/                   output PDFs
```

Both PRD editions share every section except **11 (Technology Stack)** and **12 (Implementation
Guide)**. Edit a file in `src/prd/` and both editions change.

## How it works

`build/build.mjs` inlines `style.css` + fonts, renders `{{md}}` through `marked`, resolves
`{{inc:name}}` from `src/prd/` and `{{d:name}}` from `src/diagrams/`, drives your installed Chrome
via puppeteer-core, prints page 1 without a footer, prints the rest with page numbers, and merges
them with `pdfunite`.

Missing diagrams or includes are reported and exit non-zero, so a typo fails the build.

**Font paths are rewritten at build time** relative to wherever this folder lives. `fonts.css` ships
absolute `file://` URLs; without that rewrite, moving the folder makes Chrome silently substitute a
fallback face and every PDF re-renders with wrong typography *without erroring*.

Requires: Node, `google-chrome`, and `pdfunite`/`pdfinfo`/`pdffonts` (poppler-utils).
Set `CHROME_PATH` if Chrome is not at `/usr/bin/google-chrome`.
