// parse.js — a fast drop-in replacement for marked 18.1.3 with its default
// options (GFM on, breaks off, pedantic off, async off).
//
// Original implementation, written from the CommonMark 0.31.2 and GFM 0.29
// specifications and marked's published behaviour. It renders exactly the HTML
// marked 18.1.3 renders, byte for byte, for every input — where marked departs
// from the spec, marked's output is what this produces.
//
// Design: the block grammar is built from the same composed patterns marked
// uses (a tiny `edit` composer below assembles them), matched with sticky
// regular expressions at a position index so no substring is ever copied per
// token. Inline content is rendered straight to a string by a hand-written
// scanner that follows marked's tokenizer order (escape, tag, link, reflink,
// emphasis, code span, hard break, strikethrough, autolink, extended
// autolink, text) and its delimiter rules, without allocating token objects.
//
// No dependencies, no I/O, no cross-call state: parse() is pure.

/** Compose a pattern out of named pieces, the way a grammar is assembled. */
function edit(pattern, flags = '') {
  let source = typeof pattern === 'string' ? pattern : pattern.source;
  const caret = /(^|[^\[])\^/g;
  const obj = {
    replace(name, val) {
      let valSource = typeof val === 'string' ? val : val.source;
      valSource = valSource.replace(caret, '$1');
      source = source.replace(name, valSource);
      return obj;
    },
    getRegex() {
      return new RegExp(source, flags);
    },
  };
  return obj;
}

/** A sticky copy of an anchored pattern: matches exactly at `pos`. */
function sticky(re, flags = '') {
  // Drop start-of-string anchors: a sticky pattern is already anchored at
  // `pos`, and `^` would only match at position 0 of the whole string.
  // An anchor counts when it opens the pattern or an alternative (or group);
  // `[^` and an escaped `\^` are not anchors.
  const src = re.source;
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '^') {
      const prev = out[out.length - 1];
      if (prev === undefined || prev === '|' || prev === '(') {
        let bs = 0;
        for (let j = i - 1; j >= 0 && src[j] === '\\'; j--) bs++;
        if (bs % 2 === 0) continue;
      }
    }
    out += ch;
  }
  return new RegExp(out, flags + 'y');
}

/** Run a sticky pattern at `pos` of `str`; null when it does not match there. */
function at(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

/** The line of `s` starting at `p` (without its trailing newline). */
function lineAt(s, p) {
  const nl = s.indexOf('\n', p);
  return nl === -1 ? s.slice(p) : s.slice(p, nl);
}

// ---------------------------------------------------------------------------
// Small shared patterns
// ---------------------------------------------------------------------------

const _reCache = new Map();
function cachedRe(key, make) {
  let re = _reCache.get(key);
  if (!re) { re = make(); _reCache.set(key, re); }
  return re;
}

const other = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand:
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  spaceLine: /^ +$/gm,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  listItemRegex: (bull) => cachedRe('li:' + bull, () => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`)),
  nextBulletRegex: (indent) => cachedRe('nb:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\\n]*)?(?:\\n|$))`)),
  hrRegex: (indent) => cachedRe('hr:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`)),
  fencesBeginRegex: (indent) => cachedRe('fe:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:\`\`\`|~~~)`)),
  headingBeginRegex: (indent) => cachedRe('he:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}#{1,6}(?:\\s|$)`)),
  htmlBeginRegex: (indent) => cachedRe('ht:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}(?:</?(?:${TAG})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i')),
  blockquoteBeginRegex: (indent) => cachedRe('bq:' + indent, () => new RegExp(`^ {0,${Math.max(0, Math.min(3, indent - 1))}}>`)),
};

// ---------------------------------------------------------------------------
// Block grammar (GFM)
// ---------------------------------------------------------------------------

const TAG =
  'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const newlineRe = sticky(/^(?:[ \t]*(?:\n|$))+/);
const blockCodeRe = sticky(/^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/);
const fencesRe = sticky(/^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/);
const hrRe = sticky(/^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/);
const headingRe = sticky(/^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/);

const bulletSrc = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';

const lheadingRe = sticky(edit(
  /^(?!bull |blockCode|fences|blockquote|heading|hr|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, bulletSrc)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex());

const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;

function makeParagraph(listInterrupt) {
  return sticky(edit(paragraphCore)
    .replace('hr', hrRe.source.replace(/^\^/, ''))
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('|lheading', '')
    .replace('|table', '')
    .replace('blockquote', ' {0,3}>')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', listInterrupt)
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .getRegex());
}

// GFM paragraph: a table can interrupt, and only a non-empty list starting
// from 1 can.
const paragraphRe = sticky(edit(paragraphCore)
  .replace('hr', hrRe.source.replace(/^\^/, ''))
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', gfmTableReSource())
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
  .replace('tag', TAG)
  .getRegex());

// Paragraph inside a blockquote: a bare list marker (any number) interrupts.
const blockquoteParagraphRe = makeParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/);

const blockTextRe = sticky(/^[^\n]+/);

const blockLabelSrc = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+`;

const defRe = sticky(edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', blockLabelSrc)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex());

const listRe = sticky(edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/)
  .replace(/bull/g, bulletSrc)
  .getRegex());

const htmlBlockRe = sticky(edit(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')', 'i')
  .replace('comment', COMMENT)
  .replace('tag', TAG)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex(), 'i');

function gfmTableReSource() {
  return edit(
    '^ *([^\\n ].*)\\n'
    + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
    + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)')
    .replace('hr', hrRe.source.replace(/^\^/, ''))
    .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .replace('blockquote', ' {0,3}>')
    .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
    .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
    .replace('html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)')
    .replace('tag', TAG)
    .getRegex().source;
}
const tableRe = sticky(new RegExp(gfmTableReSource()));

const blockquoteRe = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
// `paragraph` here is the blockquote paragraph grammar; the composer strips
// the `^` its source carries.
  .replace('paragraph', blockquoteParagraphRe.source)
  .getRegex();
const blockquoteReY = sticky(blockquoteRe);

// ---------------------------------------------------------------------------
// Inline grammar (GFM)
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
// GFM lets `~` sit inside emphasis, so it is not punctuation there.
const PUNCT_GFM = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

const punctuationRe = /^((?![*_])[\s\p{P}\p{S}])/u;
const unicodeAlphaNumericRe = /[\p{L}\p{N}]/u;

const escapeRe = sticky(/^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/);
const codespanRe = sticky(/^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/);

// Emphasis / strong left delimiter (GFM): `*` or `_` run, then a punctuation
// character (groups 1/3) or a non-space character (groups 2/4).
const emStrongLDelimRe = sticky(
  /(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/, 'u');

// Right-delimiter scanners, run over the masked source after the opener.
// Groups 1–6 classify the delimiter run they end on.
const emStrongRDelimAstRe = edit(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE_GFM)
  .replace(/punctSpace/g, PUNCT_OR_SPACE_GFM)
  .replace(/punct/g, PUNCT_GFM)
  .getRegex();

const emStrongRDelimUndRe = edit(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)', 'gu')
  // NOTE: unlike the asterisk version, the underscore right-delimiter
  // regex uses the plain punctuation classes (marked's GFM rules only
  // override emStrongRDelimAst, not emStrongRDelimUnd, so `~` still
  // counts as punctuation after a `_` closer).
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

// Strikethrough delimiters.
const delLDelimRe = sticky(/~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/, 'u');
const delRDelimRe = edit(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)', 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_OR_SPACE)
  .replace(/punctSpace/g, PUNCT_OR_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();

const anyPunctuationRe = /\\([\p{P}\p{S}])/gu;
const anyPunctuationOutsideCodeRe = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;

const inlineCommentRe = /<!--(?:-?>|[\s\S]*?-->)/;
const tagRe = sticky(
  /(?:<!--(?:-?>|[\s\S]*?-->)|<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|<\?[\s\S]*?\?>|<![a-zA-Z]+\s[\s\S]*?>|<!\[CDATA\[[\s\S]*?\]\]>)/);

const autolinkRe = sticky(/<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/);

const inlineLabelBracketsSrc = String.raw`\[(?:\\[\s\S]|[^\[\]\\])*\]`;
const inlineLabelSrc = edit(
  '(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?')
  .replace('brackets', inlineLabelBracketsSrc)
  .getRegex().source;

const linkRe = sticky(edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', inlineLabelSrc)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex());

const reflinkRe = sticky(edit(/^!?\[(label)\]\[(ref)\]/)
  .replace('label', inlineLabelSrc)
  .replace('ref', blockLabelSrc)
  .getRegex());

const nolinkRe = sticky(edit(/^!?\[(ref)\](?:\[\])?/)
  .replace('ref', blockLabelSrc)
  .getRegex());

const boundedBlockLabelSrc = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}`;
const boundedInlineLabelSrc = edit(
  '(?:[^\\[\\]\\\\`]*(?:\\[(?:brackets|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?')
  .replace('brackets', inlineLabelBracketsSrc)
  .getRegex().source;

const reflinkSearchRe = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/)
    .replace('label', boundedInlineLabelSrc)
    .replace('ref', boundedBlockLabelSrc)
    .getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/)
    .replace('ref', boundedBlockLabelSrc)
    .getRegex())
  .getRegex();

// Inline link / code / tag shapes, masked out of the emphasis scan.
const blockSkipRe = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

const extendedEmailSrc = String.raw`[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])`;
const urlRe = sticky(edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
    .replace(/email/g, extendedEmailSrc)
    .getRegex())
  .replace('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .replace('email', new RegExp(extendedEmailSrc.replace('@', '(@)')))
  .getRegex());

const backpedalRe = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s, encode) {
  if (encode) {
    if (!other.escapeTest.test(s)) return s;
    return s.replace(other.escapeReplace, (ch) => ESCAPE_MAP[ch]);
  }
  if (!other.escapeTestNoEncode.test(s)) return s;
  return s.replace(other.escapeReplaceNoEncode, (ch) => ESCAPE_MAP[ch]);
}

/** Decode numeric character references; a bare `&` becomes `&amp;`. */
function decodeNumericRefs(text) {
  if (!other.numericCharacterReference.test(text)) return text;
  return text.replace(other.numericCharacterReferenceOrAmpersand, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(other.percentDecode, '%');
  } catch {
    return null;
  }
  return href;
}

/** Remove trailing `c`s (or, inverted, trailing non-`c`s). */
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && other.blankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

function normalizeLabel(label) {
  return label.trim().replace(other.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}

/** Index of the bracket that closes `str`'s opening bracket, -1 / -2. */
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  return level > 0 ? -2 : -1;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(other.findPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(other.splitPipe);
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(other.slashPipe, '|');
  return cells;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else {
      expanded += char;
      col++;
    }
  }
  return expanded;
}

// ---------------------------------------------------------------------------
// Block tokenizing
// ---------------------------------------------------------------------------
//
// A token is a small object: {type, raw, text?, ...}. Inline sources are
// queued (token._q = {src}) so link reference definitions anywhere in the
// document apply, exactly as marked defers inline lexing until every block
// is read. Rendering happens afterwards, from the queued sources.

function freshState() {
  return {
    links: Object.create(null),
    queue: [],
    top: true,
    inLink: false,
    inRawBlock: false,
    linkEmitted: false,
    linkParenPossible: true,
  };
}

/** Queue an inline source for a token; returns the queue entry. */
function queueInline(st, token, src) {
  const entry = { src };
  st.queue.push(entry);
  token._q = entry;
  return entry;
}

function spaceToken(src, pos) {
  const cap = at(newlineRe, src, pos);
  if (cap && cap[0].length > 0) return { type: 'space', raw: cap[0] };
  return null;
}

function codeToken(src, pos) {
  const cap = at(blockCodeRe, src, pos);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  const text = raw.replace(other.codeRemoveIndent, '');
  return { type: 'code', raw, codeBlockStyle: 'indented', text };
}

function fencesToken(src, pos) {
  const cap = at(fencesRe, src, pos);
  if (!cap) return null;
  const raw = cap[0];
  const text = indentCodeCompensation(raw, cap[3] || '');
  return {
    type: 'code',
    raw,
    lang: cap[2] ? cap[2].trim().replace(anyPunctuationRe, '$1') : cap[2],
    text,
  };
}

function indentCodeCompensation(raw, text) {
  const m = raw.match(other.indentCodeCompensation);
  if (m === null) return text;
  const indentToCode = m[1];
  return text
    .split('\n')
    .map((node) => {
      const matchIndentInNode = node.match(other.beginningSpace);
      if (matchIndentInNode === null) return node;
      const indentInNode = matchIndentInNode[0];
      return node.slice(Math.min(indentInNode.length, indentToCode.length));
    })
    .join('\n');
}

function headingToken(src, pos, st) {
  const cap = at(headingRe, src, pos);
  if (!cap) return null;
  let text = cap[2].trim();
  if (other.endingHash.test(text)) {
    const trimmed = rtrim(text, '#');
    if (!trimmed || other.endingSpaceTabChar.test(trimmed)) text = trimmed.trim();
  }
  const token = {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[1].length,
    text,
  };
  queueInline(st, token, text);
  return token;
}

function hrToken(src, pos) {
  const cap = at(hrRe, src, pos);
  if (!cap) return null;
  return { type: 'hr', raw: rtrim(cap[0], '\n') };
}

function htmlToken(src, pos) {
  const cap = at(htmlBlockRe, src, pos);
  if (!cap) return null;
  const raw = trimTrailingBlankLines(cap[0]);
  return {
    type: 'html',
    block: true,
    raw,
    pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
    text: raw,
  };
}

function defToken(src, pos) {
  const cap = at(defRe, src, pos);
  if (!cap) return null;
  if (!other.startAngleBracket.test(cap[2]) && findClosingBracket(cap[2], '()') !== -1) return null;
  const tag = normalizeLabel(cap[1]);
  const href = cap[2] ? cap[2].replace(other.hrefBrackets, '$1').replace(anyPunctuationRe, '$1') : '';
  const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(anyPunctuationRe, '$1') : cap[3];
  return { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
}

function tableToken(src, pos, st) {
  const cap = at(tableRe, src, pos);
  if (!cap) return null;
  if (!other.tableDelimiter.test(cap[2])) return null;
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(other.tableAlignChars, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(other.tableRowBlankLine, '').split('\n') : [];
  if (headers.length !== aligns.length) return null;
  const item = {
    type: 'table',
    raw: rtrim(cap[0], '\n'),
    header: [],
    align: [],
    rows: [],
  };
  for (const align of aligns) {
    if (other.tableAlignRight.test(align)) item.align.push('right');
    else if (other.tableAlignCenter.test(align)) item.align.push('center');
    else if (other.tableAlignLeft.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    const cell = { text: headers[i], header: true, align: item.align[i] };
    queueInline(st, cell, headers[i]);
    item.header.push(cell);
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cellText, i) => {
      const cell = { text: cellText, header: false, align: item.align[i] };
      queueInline(st, cell, cellText);
      return cell;
    }));
  }
  return item;
}

function lheadingToken(src, pos, st) {
  const cap = at(lheadingRe, src, pos);
  if (!cap) return null;
  const text = cap[1].trim();
  const token = {
    type: 'heading',
    raw: rtrim(cap[0], '\n'),
    depth: cap[2].charAt(0) === '=' ? 1 : 2,
    text,
  };
  queueInline(st, token, text);
  return token;
}

function paragraphToken(src, pos, st) {
  const cap = at(paragraphRe, src, pos);
  if (!cap) return null;
  const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
  const token = { type: 'paragraph', raw: cap[0], text };
  queueInline(st, token, text);
  return token;
}

function textToken(src, pos, st) {
  const cap = at(blockTextRe, src, pos);
  if (!cap) return null;
  const token = { type: 'text', raw: cap[0], text: cap[0] };
  queueInline(st, token, cap[0]);
  return token;
}

function blockquoteToken(src, pos, st) {
  const sub = src.slice(pos);
  const cap = at(blockquoteReY, sub, 0);
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (other.blockquoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      .replace(
        other.blockquoteMarkerWhitespace,
        (_, marker, whitespace) => marker + expandTabs(whitespace, marker.length),
      )
      .replace(other.blockquoteSetextReplace, '\n    $1')
      .replace(other.blockquoteSetextReplace2, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = st.top;
    st.top = true;
    blockTokens(currentText, tokens, true, st);
    st.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr'
      || lastToken?.type === 'html' || lastToken?.type === 'table') {
      break;
    } else if (lastToken?.type === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(other.blockquoteSetextReplace2, '');
      const newToken = blockquoteToken(newText, 0, st);
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && other.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newToken = listToken(newText, 0, st);
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  return { type: 'blockquote', raw, tokens, text };
}

function listToken(src, pos, st) {
  const listSrc = src.slice(pos);
  let cap = at(listRe, listSrc, 0);
  if (!cap) return null;
  // `rest` is the offset into listSrc of the not-yet-consumed remainder.
  // The original marked code keeps slicing the remainder string, which
  // copies O(n) per line; indexing avoids that.
  let rest = 0;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = sticky(other.listItemRegex(bull));
  let endsWithBlankLine = false;
  while (rest < listSrc.length) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = at(itemRegex, listSrc, rest))) break;
    if (at(hrRe, listSrc, rest)) break;
    const itemStart = rest;
    rest += cap[0].length;
    const nl2 = cap[2].indexOf('\n');
    const firstLine = nl2 === -1 ? cap[2] : cap[2].slice(0, nl2);
    const bulletIndent = cap[1].length;
    let line = firstLine.includes('\t')
      ? firstLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws, bulletIndent))
      : firstLine;
    let nextLine = lineAt(listSrc, rest);
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(other.nonSpaceChar);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && other.blankLine.test(nextLine)) {
      rest += nextLine.length + 1;
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRegex = other.nextBulletRegex(indent);
      const hrRegex = other.hrRegex(indent);
      const fencesBeginRegex = other.fencesBeginRegex(indent);
      const headingBeginRegex = other.headingBeginRegex(indent);
      const htmlBeginRegex = other.htmlBeginRegex(indent);
      const blockquoteBeginRegex = other.blockquoteBeginRegex(indent);
      while (rest < listSrc.length) {
        const rawLine = lineAt(listSrc, rest);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.includes('\t')
          ? nextLine.replace(other.leadingSpaceTab, (ws) => expandTabs(ws))
          : nextLine;
        if (fencesBeginRegex.test(nextLine)) break;
        if (headingBeginRegex.test(nextLine)) break;
        if (htmlBeginRegex.test(nextLine)) break;
        if (blockquoteBeginRegex.test(nextLine)) break;
        if (nextBulletRegex.test(nextLine)) break;
        if (hrRegex.test(nextLine)) break;
        if (nextLineWithoutTabs.search(other.nonSpaceChar) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if ((line.includes('\t') ? line.replace(other.tabCharGlobal, '    ') : line).search(other.nonSpaceChar) >= 4) break;
          if (fencesBeginRegex.test(line)) break;
          if (headingBeginRegex.test(line)) break;
          if (htmlBeginRegex.test(line)) break;
          if (hrRegex.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && (() => { lheadingRe.lastIndex = 0; return lheadingRe.test(`${line}\n${nextLine}`); })();
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        rest += rawLine.length + 1;
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, rest);
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (other.doubleBlankLine.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      type: 'list_item',
      raw,
      task: other.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = listSrc.slice(0, rest).trimEnd();
  // First pass: tokenize items, settle looseness.
  for (const item of list.items) {
    st.top = false;
    item.tokens = blockTokens(item.text, [], false, st);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => other.anyLine.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  // Second pass: place task checkboxes using the final looseness.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(other.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(other.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(other.listReplaceTask, '');
      for (let i = st.queue.length - 1; i >= 0; i--) {
        if (other.listIsTask.test(st.queue[i].src)) {
          st.queue[i].src = st.queue[i].src.replace(other.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = other.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        item.checked = checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && item.tokens[0]._q) {
            item.tokens[0].checkbox = checked;
          } else {
            item.tokens.unshift({
              type: 'paragraph',
              raw: taskRaw[0] + ' ',
              text: taskRaw[0] + ' ',
              checkboxOnly: true,
              checkbox: checked,
            });
          }
        } else {
          item.tokens.unshift({ type: 'checkbox', raw: taskRaw[0] + ' ', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return list;
}

// ---------------------------------------------------------------------------
// The block loop
// ---------------------------------------------------------------------------

/** Could a table start here? Its delimiter row (2nd line) needs a `-`. */
function tableGate(src, pos) {
  const nl1 = src.indexOf('\n', pos);
  if (nl1 === -1) return false;
  const nl2 = src.indexOf('\n', nl1 + 1);
  const dash = src.indexOf('-', nl1 + 1);
  return dash !== -1 && (nl2 === -1 || dash < nl2);
}

function blockTokens(src, tokens, lastParagraphClipped, st) {
  let pos = 0;
  const n = src.length;
  let srcLength = Infinity;
  while (pos < n) {
    const remaining = n - pos;
    if (remaining < srcLength) {
      srcLength = remaining;
    } else {
      throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    }
    let token = null;
    // First content char after up to three leading spaces; most block
    // types can only start with one of a few characters, so skip the
    // regexes (and the whole-remainder slices in list/blockquote) that
    // cannot match here.
    const c0 = src.charCodeAt(pos);
    let p0 = pos;
    let sp = 0;
    while (sp < 3 && src.charCodeAt(p0) === 32) { p0++; sp++; }
    const fc = src.charCodeAt(p0);
    if ((c0 === 10 || c0 === 32 || c0 === 9) && (token = spaceToken(src, pos))) {
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (token.raw.length === 1 && lastToken !== undefined) lastToken.raw += '\n';
      else tokens.push(token);
      continue;
    }
    if ((c0 === 32 || c0 === 9) && (token = codeToken(src, pos))) {
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        st.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
    if ((fc === 96 || fc === 126) && (token = fencesToken(src, pos))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if (fc === 35 && (token = headingToken(src, pos, st))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if ((fc === 45 || fc === 95 || fc === 42) && (token = hrToken(src, pos))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if (fc === 62 && (token = blockquoteToken(src, pos, st))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if ((fc === 45 || fc === 43 || fc === 42 || (fc >= 48 && fc <= 57)) && (token = listToken(src, pos, st))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if (fc === 60 && (token = htmlToken(src, pos))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if (fc === 91 && (token = defToken(src, pos))) {
      pos += token.raw.length;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.raw;
        st.queue.at(-1).src = lastToken.text;
      } else {
        if (!st.links[token.tag]) st.links[token.tag] = { href: token.href, title: token.title };
        tokens.push(token);
      }
      continue;
    }
    if (tableGate(src, pos) && (token = tableToken(src, pos, st))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if ((token = lheadingToken(src, pos, st))) {
      pos += token.raw.length;
      tokens.push(token);
      continue;
    }
    if (st.top && (token = paragraphToken(src, pos, st))) {
      const lastToken = tokens.at(-1);
      if (lastParagraphClipped && lastToken?.type === 'paragraph') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        st.queue.pop();
        st.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      lastParagraphClipped = false;
      pos += token.raw.length;
      continue;
    }
    if ((token = textToken(src, pos, st))) {
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        st.queue.pop();
        st.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      pos += token.raw.length;
      continue;
    }
    throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
  }
  st.top = true;
  return tokens;
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isEmailCharCode(c) {
  return isAlnumCode(c)
    || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39
    || c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95
    || c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

function isLocalCharCode(c) {
  return isAlnumCode(c) || c === 46 || c === 95 || c === 43 || c === 45;
}

function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

/** Does `s` hold an email address starting at `p` (local part + `@`)? */
function isEmailAt(s, p) {
  let j = p;
  const n = s.length;
  while (j < n && isEmailCharCode(s.charCodeAt(j))) j++;
  return j > p && j < n && s.charCodeAt(j) === 64;
}

/** Is there a hard break (`  \n`) starting at `p`? */
function isHardBreakAt(s, p) {
  if (s.charCodeAt(p) !== 32) return false;
  let j = p;
  const n = s.length;
  while (j < n && s.charCodeAt(j) === 32) j++;
  return j - p >= 2 && j < n && s.charCodeAt(j) === 10;
}

function matchIgnoreCase(s, p, lower) {
  if (p + lower.length > s.length) return false;
  for (let k = 0; k < lower.length; k++) {
    let c = s.charCodeAt(p + k);
    if (c >= 65 && c <= 90) c += 32;
    if (c !== lower.charCodeAt(k)) return false;
  }
  return true;
}

function isProtocolAt(s, p) {
  const c = s.charCodeAt(p);
  if (c === 104 || c === 72) return matchIgnoreCase(s, p, 'http://') || matchIgnoreCase(s, p, 'https://');
  if (c === 102 || c === 70) return matchIgnoreCase(s, p, 'ftp://');
  return false;
}

const WS_BEFORE_WWW = /[\s*_~(]/;
function isWwwAt(s, p) {
  if (!s.startsWith('www.', p)) return false;
  if (p === 0) return true;
  return WS_BEFORE_WWW.test(s[p - 1]);
}

/**
 * Where the text run starting at `i` ends: it stops before `\`, `<`, `!`,
 * `[`, backtick, `*`, `~`, `_`, a URL or email start, and a hard break, and
 * takes one character past a character that introduces one.
 */
/** Next stop of a text run: a stop char, a URL start, or a hard break. */
const textStopRe = /[\\<!\[`*~_]|(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|(?<=[\s*_~(])www\.|(?= {2,}\n)|(?<![A-Za-z0-9])(?:mailto:|xmpp:)/g;

/**
 * First email start at or after `from`: find the next `@`, then scan the
 * local part backwards. (The lookahead form in the stop regex re-scans
 * every word; `@` is rare, so anchoring on it is far cheaper.)
 */
function findEmailStart(s, from) {
  const n = s.length;
  let at = s.indexOf('@', from);
  while (at !== -1) {
    let q = at - 1;
    while (q >= from && isEmailCharCode(s.charCodeAt(q))) q--;
    q++;
    if (q < at) return q;
    at = s.indexOf('@', at + 1);
  }
  return -1;
}

function scanTextEnd(s, i) {
  const n = s.length;
  if (!isAlnumCode(s.charCodeAt(i))
    && (s.startsWith('mailto:', i + 1) || s.startsWith('xmpp:', i + 1))) {
    return i + 1;
  }
  let p = i;
  const c0 = s.charCodeAt(p);
  if (c0 === 96 || c0 === 126) {
    while (p < n && s.charCodeAt(p) === c0) p++;
  } else {
    p = i + 1;
  }
  if (p < n) {
    if (s.charCodeAt(p) === 96 || s.charCodeAt(p) === 126) return p;
    if (isHardBreakAt(s, p)) return p;
    if (isEmailAt(s, p)) return p;
  }
  textStopRe.lastIndex = p;
  let m = textStopRe.exec(s);
  let stop = m ? m.index : n;
  // A mailto:/xmpp: stop at the head position is not a stop when the head
  // was a backtick/tilde run (the loop only checks mailto: after a
  // non-alphanumeric character it has already consumed).
  if (m && m.index === p && p > i + 1 && (m[0] === 'mailto:' || m[0] === 'xmpp:')) {
    textStopRe.lastIndex = p + 1;
    m = textStopRe.exec(s);
    stop = m ? m.index : n;
  }
  const email = findEmailStart(s, p);
  if (email !== -1 && email < stop) return email;
  return stop;
}

const brRe = sticky(/^( {2,}|\\)\n(?!\s*$)[ \t]*/);
function tryBr(src, i) {
  const cap = at(brRe, src, i);
  return cap ? cap[0].length : 0;
}

function tryTag(src, i, st) {
  const cap = at(tagRe, src, i);
  if (!cap) return null;
  if (!st.inLink && other.startATag.test(cap[0])) st.inLink = true;
  else if (st.inLink && other.endATag.test(cap[0])) st.inLink = false;
  if (!st.inRawBlock && other.startPreScriptTag.test(cap[0])) st.inRawBlock = true;
  else if (st.inRawBlock && other.endPreScriptTag.test(cap[0])) st.inRawBlock = false;
  return { html: cap[0], len: cap[0].length };
}

function tryCodespan(src, i, textMode) {
  const cap = at(codespanRe, src, i);
  if (!cap) return null;
  let text = cap[2].replace(other.newLineCharGlobal, ' ');
  const hasNonSpaceChars = other.nonSpaceChar.test(text);
  const hasSpaceCharsOnBothEnds = other.startingSpaceChar.test(text) && other.endingSpaceChar.test(text);
  if (hasNonSpaceChars && hasSpaceCharsOnBothEnds) text = text.substring(1, text.length - 1);
  return { html: textMode ? text : `<code>${escapeHtml(text, true)}</code>`, len: cap[0].length };
}

function isLabelEndInsideToken(src, label, labelStart, st) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') {
      i++;
      continue;
    }
    if (label[i] === '`') {
      const code = at(codespanRe, label, i);
      if (code) {
        i += code[0].length - 1;
        continue;
      }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = at(tagRe, tokenSrc, 0) || at(autolinkRe, tokenSrc, 0);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

function linkInText(text, st) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(blockSkipRe)) {
    linkRe.lastIndex = 0;
    if (linkRe.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(reflinkSearchRe)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(st.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(match0.slice(1, refStart - 1), st)) continue;
    return true;
  }
  return false;
}

/** Mask links, code, HTML and escapes so emphasis does not see inside them. */
function maskSrc(src, st) {
  let masked = src;
  if (src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(st.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(text, st)) {
          return '[' + text.replace(reflinkSearchRe, maskReflink)
            + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearchRe, maskReflink);
  }
  if (src.includes('`') || src.includes('\\')) {
    masked = masked.replace(anyPunctuationOutsideCodeRe, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(blockSkipRe, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

/** Last delimiter runs that can close emphasis, strong or strikethrough. */
function scanClosers(masked) {
  let star = -1;
  let und = -1;
  let tilde = -1;
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') tilde = i;
      else if (ch === '*') star = i;
      else und = i;
    }
    i = j - 1;
  }
  return { star, und, tilde };
}

function tryEmStrong(src, i, masked, hints, prevChar, st, textMode) {
  const match = at(emStrongLDelimRe, src, i);
  if (!match) return null;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return null;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = i;
  let runStart = srcStart;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_'
    || punctuationRe.test(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : punctuationRe.test(prevChar);
  if (match[4] && unicodeAlphaNumericRe.test(prevChar)) return null;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim()
      && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? emStrongRDelimAstRe : emStrongRDelimUndRe;
    const lastCloser = delimChar === '*' ? hints.star : hints.und;
    const windowStart = i + lLength;
    if (lastCloser < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(window)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      } else if (m[5] || m[6] || openerCanClose) {
        if (midRun && (m[5] || m[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(i, i + lLength + m.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        const text = raw.slice(1, -1);
        const inner = renderInline(text, st, textMode);
        return { html: textMode ? inner : `<em>${inner}</em>`, len: raw.length };
      }
      const text = raw.slice(2, -2);
      const inner = renderInline(text, st, textMode);
      return { html: textMode ? inner : `<strong>${inner}</strong>`, len: raw.length };
    }
  }
  return null;
}

function tryDel(src, i, masked, hints, prevChar, st, textMode) {
  const match = at(delLDelimRe, src, i);
  if (!match) return null;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || punctuationRe.test(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let delimTotal = lLength;
    const endReg = delRDelimRe;
    const lastCloser = hints.tilde;
    const windowStart = i + lLength;
    if (lastCloser < windowStart) return null;
    const window = masked.slice(windowStart);
    const lastInWindow = lastCloser - windowStart;
    endReg.lastIndex = 0;
    let m;
    while ((m = endReg.exec(window)) !== null) {
      if (m.index > lastInWindow) break;
      const rDelim = m[1] || m[2] || m[3] || m[4] || m[5] || m[6];
      if (!rDelim) continue;
      let rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (m[3] || m[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...m[0]][0].length;
      const raw = src.slice(i, i + lLength + m.index + lastCharLength + rLength);
      const text = raw.slice(lLength, -lLength);
      const inner = renderInline(text, st, textMode);
      return { html: textMode ? inner : `<del>${inner}</del>`, len: raw.length };
    }
  }
  return null;
}

function outputLink(cap, href, title, raw, st, textMode) {
  const text = cap[1].replace(other.outputLinkReplace, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = st.inLink;
  const outerLinkEmitted = st.linkEmitted;
  const outerInRawBlock = st.inRawBlock;
  st.inLink = true;
  st.linkEmitted = false;
  const inner = renderInline(text, st, isImage ? true : textMode);
  const textHasLink = st.linkEmitted;
  st.linkEmitted = outerLinkEmitted;
  st.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      st.inRawBlock = outerInRawBlock;
      return null;
    }
    st.linkEmitted = true;
  }
  if (textMode) return { html: inner, len: raw.length };
  if (isImage) {
    const cleanHref = cleanUrl(href);
    if (cleanHref === null) return { html: escapeHtml(inner), len: raw.length };
    let out = `<img src="${escapeHtml(cleanHref)}" alt="${escapeHtml(inner)}"`;
    if (title) out += ` title="${escapeHtml(title)}"`;
    out += '>';
    return { html: out, len: raw.length };
  }
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: inner, len: raw.length };
  let out = '<a href="' + escapeHtml(cleanHref) + '"';
  if (title) out += ' title="' + escapeHtml(title) + '"';
  out += '>' + inner + '</a>';
  return { html: out, len: raw.length };
}

function tryLink(src, i, st, textMode) {
  if (st.linkParenPossible === false) return null;
  const cap = at(linkRe, src, i);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], i + labelStart, st)) return null;
  const trimmedUrl = cap[2].trim();
  let href = cap[2];
  let title = '';
  let raw = cap[0];
  let titleCleared = false;
  if (other.startAngleBracket.test(trimmedUrl)) {
    if (!other.endAngleBracket.test(trimmedUrl)) return null;
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    const lastParenIndex = findClosingBracket(cap[2], '()');
    if (lastParenIndex === -2) return null;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      href = cap[2].substring(0, lastParenIndex);
      raw = cap[0].substring(0, linkLen).trim();
      titleCleared = true;
    }
  }
  const unescaped = rtrim(raw.slice(0, -1), '\\');
  if ((raw.length - unescaped.length) % 2 === 0) return null;
  if (!titleCleared) title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (other.startAngleBracket.test(href)) href = href.slice(1, -1);
  return outputLink(cap, href ? href.replace(anyPunctuationRe, '$1') : href,
    title ? title.replace(anyPunctuationRe, '$1') : title, raw, st, textMode);
}

function tryReflink(src, i, st, textMode) {
  let cap = at(reflinkRe, src, i);
  if (!cap) cap = at(nolinkRe, src, i);
  if (!cap) return null;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src, cap[1], i + labelStart, st)) return null;
  const link = st.links[normalizeLabel(cap[2] || cap[1])];
  if (!link) {
    const ch = cap[0].charAt(0);
    return { html: textMode ? ch : escapeHtml(ch), len: 1, singleText: true };
  }
  return outputLink(cap, link.href, link.title, cap[0], st, textMode);
}

function tryAutolink(src, i, st, textMode) {
  const cap = at(autolinkRe, src, i);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[1];
    href = 'mailto:' + text;
  } else {
    text = cap[1];
    href = text;
  }
  if (textMode) return { html: text, len: cap[0].length };
  const parsedText = escapeHtml(text, true);
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: parsedText, len: cap[0].length };
  return { html: `<a href="${escapeHtml(cleanHref, true)}">${parsedText}</a>`, len: cap[0].length };
}

function tryUrl(src, i, st, textMode) {
  const cap = at(urlRe, src, i);
  if (!cap) return null;
  let text;
  let href;
  if (cap[2] === '@') {
    text = cap[0];
    href = 'mailto:' + text;
  } else {
    let prevCapZero;
    let c0 = cap[0];
    do {
      prevCapZero = c0;
      const m = backpedalRe.exec(c0);
      c0 = m ? m[0] : '';
    } while (prevCapZero !== c0);
    text = c0;
    href = cap[1] === 'www.' ? 'http://' + c0 : c0;
  }
  if (textMode) return { html: text, len: text.length };
  const parsedText = escapeHtml(text, true);
  const cleanHref = cleanUrl(href);
  if (cleanHref === null) return { html: parsedText, len: text.length };
  return { html: `<a href="${escapeHtml(cleanHref, true)}">${parsedText}</a>`, len: text.length };
}

/** Could an extended autolink start here? A cheap pre-check for `url`. */
function maybeUrl(src, i) {
  const c = src.charCodeAt(i);
  if (c === 119) {
    if (src.startsWith('www.', i)) return true;
  } else if (c === 104 || c === 72 || c === 102 || c === 70) {
    if (isProtocolAt(src, i)) return true;
  } else if (c === 109 || c === 77 || c === 120 || c === 88) {
    if (src.startsWith('mailto:', i) || src.startsWith('xmpp:', i)) return true;
  }
  if (isLocalCharCode(c)) {
    let j = i;
    const n = src.length;
    while (j < n && isLocalCharCode(src.charCodeAt(j))) j++;
    if (j > i && j < n && src.charCodeAt(j) === 64) return true;
  }
  return false;
}

function renderInline(src, st, textMode) {
  const prevLinkParenPossible = st.linkParenPossible;
  st.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return renderInlineInner(src, st, textMode);
  } finally {
    st.linkParenPossible = prevLinkParenPossible;
  }
}

/** Anything that would make an inline run more than escaped plain text. */
const markupRe = /[\\<!\[`*~_]|:\/\/|www\.|@|mailto:|xmpp:| {2,}\n/;

function renderInlineInner(src, st, textMode) {
  // Fast path: no inline markup, URL, email or hard break in the whole run.
  // (No `<` means no tag can change inLink/inRawBlock, and no delimiter
  // means maskSrc/scanClosers have nothing to do.)
  if (!markupRe.test(src)) {
    if (st.inRawBlock) return src;
    if (textMode) return decodeNumericRefs(src);
    return escapeHtml(decodeNumericRefs(src));
  }
  const n = src.length;
  let out = '';
  let i = 0;
  let keepPrevChar = false;
  let prevChar = '';
  let masked = null;
  let hints = null;
  if (src.includes('*') || src.includes('_') || src.includes('~')) {
    masked = maskSrc(src, st);
    hints = scanClosers(masked);
  }
  while (i < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const c = src.charCodeAt(i);
    let res = null;
    if (c === 92) {
      if (i + 1 < n && isAsciiPunctCode(src.charCodeAt(i + 1))) {
        const ch = src[i + 1];
        out += textMode ? ch : (ESCAPE_MAP[ch] || ch);
        i += 2;
        continue;
      }
      const brLen = tryBr(src, i);
      if (brLen) {
        if (!textMode) out += '<br>';
        i += brLen;
        continue;
      }
    } else if (c === 60) {
      res = tryTag(src, i, st);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
      res = tryAutolink(src, i, st, textMode);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
    } else if (c === 91 || (c === 33 && src.charCodeAt(i + 1) === 91)) {
      res = tryLink(src, i, st, textMode);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
      res = tryReflink(src, i, st, textMode);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
    } else if (c === 42 || c === 95) {
      if (masked !== null) {
        res = tryEmStrong(src, i, masked, hints, prevChar, st, textMode);
        if (res) {
          out += res.html;
          i += res.len;
          continue;
        }
      }
    } else if (c === 96) {
      res = tryCodespan(src, i, textMode);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
    } else if (c === 32) {
      const brLen = tryBr(src, i);
      if (brLen) {
        if (!textMode) out += '<br>';
        i += brLen;
        continue;
      }
    } else if (c === 126) {
      if (masked !== null) {
        res = tryDel(src, i, masked, hints, prevChar, st, textMode);
        if (res) {
          out += res.html;
          i += res.len;
          continue;
        }
      }
    } else if (!st.inLink && maybeUrl(src, i)) {
      res = tryUrl(src, i, st, textMode);
      if (res) {
        out += res.html;
        i += res.len;
        continue;
      }
    }
    const end = scanTextEnd(src, i);
    const chunk = src.slice(i, end);
    if (textMode) {
      out += st.inRawBlock ? chunk : decodeNumericRefs(chunk);
    } else {
      out += st.inRawBlock ? chunk : escapeHtml(decodeNumericRefs(chunk));
    }
    if (chunk.charCodeAt(chunk.length - 1) !== 95) prevChar = chunk.slice(-1);
    keepPrevChar = true;
    i = end;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering
// ---------------------------------------------------------------------------

function renderCheckbox(token) {
  return '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

function renderCode(token) {
  const langString = (token.lang || '').match(other.notSpaceStart)?.[0];
  const code = token.text ? token.text.replace(other.endingNewline, '') + '\n' : '';
  const esc = escapeHtml(code, true);
  if (!langString) return '<pre><code>' + esc + '</code></pre>\n';
  return '<pre><code class="language-' + escapeHtml(langString) + '">' + esc + '</code></pre>\n';
}

/** A top-level inline run: an unclosed raw block does not carry over. */
function topInline(src, st) {
  st.inRawBlock = false;
  return renderInline(src, st, false);
}

function renderTableCell(cell, st) {
  const content = topInline(cell._q.src, st);
  const type = cell.header ? 'th' : 'td';
  const tag = cell.align ? `<${type} align="${cell.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderTable(token, st) {
  let header = '';
  for (const cell of token.header) header += renderTableCell(cell, st);
  let body = '';
  for (const row of token.rows) {
    let cellHtml = '';
    for (const cell of row) cellHtml += renderTableCell(cell, st);
    body += `<tr>\n${cellHtml}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + `<tr>\n${header}</tr>\n` + '</thead>\n' + body + '</table>\n';
}

function renderList(token, st) {
  let body = '';
  for (const item of token.items) body += `<li>${renderBlocks(item.tokens, st)}</li>\n`;
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderBlocks(tokens, st) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'space':
        break;
      case 'hr':
        out += '<hr>\n';
        break;
      case 'heading':
        out += `<h${token.depth}>${topInline(token._q.src, st)}</h${token.depth}>\n`;
        break;
      case 'code':
        out += renderCode(token);
        break;
      case 'table':
        out += renderTable(token, st);
        break;
      case 'blockquote':
        out += `<blockquote>\n${renderBlocks(token.tokens, st)}</blockquote>\n`;
        break;
      case 'list':
        out += renderList(token, st);
        break;
      case 'checkbox':
        out += renderCheckbox(token);
        break;
      case 'html':
        out += token.text;
        break;
      case 'def':
        break;
      case 'paragraph': {
        if (token.checkboxOnly) {
          out += `<p>${renderCheckbox(token)}</p>\n`;
          break;
        }
        let inner = topInline(token._q.src, st);
        if (token.checkbox !== undefined) inner = renderCheckbox({ checked: token.checkbox }) + inner;
        out += `<p>${inner}</p>\n`;
        break;
      }
      case 'text': {
        let inner = topInline(token._q.src, st);
        if (token.checkbox !== undefined) inner = renderCheckbox({ checked: token.checkbox }) + inner;
        out += inner;
        break;
      }
      default:
        throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * The HTML marked 18.1.3 renders for `markdown`, with marked's defaults.
 */
export function parse(markdown) {
  if (typeof markdown !== 'string') {
    throw new Error(
      'marked(): input parameter is of type ' + Object.prototype.toString.call(markdown)
      + ', string expected',
    );
  }
  const src = markdown.replace(other.carriageReturn, '\n');
  const st = freshState();
  st.queue = [];
  const tokens = blockTokens(src, [], false, st);
  return renderBlocks(tokens, st);
}
