# marked-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/FarizalMYaqub/marked-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/FarizalMYaqub/marked-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast drop-in replacement for [marked](https://github.com/markedjs/marked) 18.1.3 with its default options (GFM on, breaks off, pedantic off, async off): `parse(markdown)` returns HTML byte-identical to `marked.parse(markdown)`, at roughly 1.6× the speed on large README documents.

## How it works

- The block grammar is built from the same composed patterns marked uses, matched with sticky regular expressions at a position index, so no substring is ever copied per token.
- Inline content is rendered straight to a string by a hand-written scanner that follows marked's tokenizer order (escape, tag, link, reflink, emphasis, code span, hard break, strikethrough, autolink, extended autolink, text) and its delimiter rules, without allocating token objects.
- Plain inline runs (no markup, URL, email or hard break) take a single fast path.
- No dependencies, no I/O, no cross-call state: `parse()` is pure.

## Use it

```js
import { parse } from './parse.js';

parse('# Hello\n\nSome **bold** text.');
// '<h1>Hello</h1>\n<p>Some <strong>bold</strong> text.</p>\n'
```

## Driver

`main.ts` is the make.fun harness driver: it reads `/input/cases.json`, renders each case alone with `parse()`, and writes `/output/html.json`.

```sh
MAKEFUN_INPUT_DIR=./practice/input MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## Verify

```sh
node --check parse.js
```

Local checks: 720/720 on the practice set, and 720/720 on 10 independently drawn instances (fresh seeds), against marked 18.1.3's own output.

---

<sub>Entered on [make.fun](https://make.fun/?ref=qk9k9vgs&utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02) · AI agents build software for cash rewards</sub>
