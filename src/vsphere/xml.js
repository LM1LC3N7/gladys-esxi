// -----------------------------------------------------------------------------
// A small XML parser for the SOAP answers of vSphere (pure). No dependency:
// the parser of the author's Linn integration (LM1LC3N7/gladys-linn,
// Apache-2.0), with its texts kept as pieces (joined once, never
// concatenated piece by piece).
//
// Safety: one linear pass with indexOf (no backtracking regex); a document
// with a DOCTYPE is refused outright (vSphere never sends one: no internal
// subset, no external entity, no "billion laughs"); only the five XML
// entities and numeric references are decoded; depth and node count are
// bounded; attribute maps have no prototype. The input is bounded by the
// HTTP layer (MAX_BYTES). Tolerant otherwise: a closing tag matching nothing
// is ignored, an element left open at the end is kept.
//
// The tree: { name, attrs, children } for an element (`name` and attribute
// names without their namespace prefix), a plain string for a text piece.
// -----------------------------------------------------------------------------

const MAX_DEPTH = 32;
const MAX_NODES = 200_000;
const MAX_LENGTH = 8 * 1024 * 1024;

export class XmlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'XmlError';
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function codePoint(n) {
  try {
    return Number.isInteger(n) && n > 0 ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/** The five XML entities and the numeric references; anything else stays as is. */
export function decodeEntities(text) {
  if (!text.includes('&')) return text;
  const out = [];
  let pos = 0;
  for (;;) {
    const amp = text.indexOf('&', pos);
    if (amp === -1) {
      out.push(text.slice(pos));
      return out.join('');
    }
    out.push(text.slice(pos, amp));
    // The `;` is looked for in the next 11 characters only: a long run of `&`
    // without one stays linear.
    const near = text.slice(amp + 1, amp + 12).indexOf(';');
    const semi = near === -1 ? -1 : amp + 1 + near;
    const body = semi === -1 ? '' : text.slice(amp + 1, semi);
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const digits = body.slice(hex ? 2 : 1);
      const valid = hex ? /^[0-9a-fA-F]{1,6}$/.test(digits) : /^\d{1,7}$/.test(digits);
      out.push(valid ? codePoint(parseInt(digits, hex ? 16 : 10)) : text.slice(amp, semi + 1));
      pos = semi + 1;
    } else if (body && Object.hasOwn(ENTITIES, body)) {
      out.push(ENTITIES[body]);
      pos = semi + 1;
    } else {
      out.push('&');
      pos = amp + 1;
    }
  }
}

/** For the SOAP arguments: the five characters XML gives a meaning to. */
export function escapeXml(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c],
  );
}

const isSpace = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r';
const NAME_START = /[A-Za-z_]/;
const localName = (qualified) => qualified.slice(qualified.indexOf(':') + 1);

/** A start tag at `lt`: { name, attrs, selfClosing, end }, or undefined if cut. */
function readStartTag(text, lt) {
  let i = lt + 1;
  while (i < text.length && !isSpace(text[i]) && text[i] !== '>' && text[i] !== '/') i += 1;
  const name = text.slice(lt + 1, i);
  const attrs = Object.create(null);
  while (i < text.length) {
    while (isSpace(text[i])) i += 1;
    const c = text[i];
    if (c === undefined) return undefined;
    if (c === '>') return { name, attrs, selfClosing: false, end: i + 1 };
    if (c === '/') {
      if (text[i + 1] === '>') return { name, attrs, selfClosing: true, end: i + 2 };
      i += 1;
      continue;
    }
    const start = i;
    while (
      i < text.length &&
      !isSpace(text[i]) &&
      text[i] !== '=' &&
      text[i] !== '>' &&
      text[i] !== '/'
    ) {
      i += 1;
    }
    const attr = text.slice(start, i);
    while (isSpace(text[i])) i += 1;
    let value = '';
    if (text[i] === '=') {
      i += 1;
      while (isSpace(text[i])) i += 1;
      const quote = text[i];
      if (quote === '"' || quote === "'") {
        const close = text.indexOf(quote, i + 1);
        if (close === -1) return undefined;
        value = text.slice(i + 1, close);
        i = close + 1;
      } else {
        const from = i;
        while (i < text.length && !isSpace(text[i]) && text[i] !== '>') i += 1;
        value = text.slice(from, i);
      }
    }
    // `xsi:type` and `type` both become `type`: the first one wins (vSphere
    // writes xsi:type first; a moref has only `type`).
    const key = localName(attr);
    if (key && !(key in attrs)) attrs[key] = decodeEntities(value);
  }
  return undefined;
}

/** Parse a document into its root element; throws an XmlError without one. */
export function parseXml(input, { maxLength = MAX_LENGTH } = {}) {
  const text = String(input ?? '');
  if (text.length > maxLength) throw new XmlError('document too large');
  const doc = { name: '#document', attrs: Object.create(null), children: [] };
  const stack = [doc];
  let nodes = 0;
  let pos = 0;
  const addText = (value) => {
    const parent = stack[stack.length - 1];
    if (parent === doc || value === '') return; // text outside the root is not content
    parent.children.push(value);
  };

  while (pos < text.length) {
    const lt = text.indexOf('<', pos);
    if (lt === -1) {
      addText(decodeEntities(text.slice(pos)));
      break;
    }
    if (lt > pos) addText(decodeEntities(text.slice(pos, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      pos = end === -1 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      addText(text.slice(lt + 9, end === -1 ? text.length : end));
      pos = end === -1 ? text.length : end + 3;
    } else if (text.startsWith('<!', lt)) {
      // <!DOCTYPE, <!ENTITY...: never in vSphere, refused rather than skipped.
      throw new XmlError('DOCTYPE and entity declarations are refused');
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      pos = end === -1 ? text.length : end + 2;
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt + 2);
      const name = localName(text.slice(lt + 2, end === -1 ? text.length : end).trim());
      pos = end === -1 ? text.length : end + 1;
      // Only the open elements are searched: at most MAX_DEPTH steps.
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i].name === name) {
          stack.length = i;
          break;
        }
      }
    } else if (!NAME_START.test(text[lt + 1] ?? '')) {
      addText('<'); // a lone `<` in a text
      pos = lt + 1;
    } else {
      const tag = readStartTag(text, lt);
      if (!tag) break; // a tag cut by the end of the answer
      pos = tag.end;
      nodes += 1;
      if (nodes > MAX_NODES) throw new XmlError('too many elements');
      const element = { name: localName(tag.name), attrs: tag.attrs, children: [] };
      stack[stack.length - 1].children.push(element);
      if (!tag.selfClosing) {
        if (stack.length > MAX_DEPTH) throw new XmlError('the answer is nested too deeply');
        stack.push(element);
      }
    }
  }
  const root = doc.children.find((c) => typeof c === 'object');
  if (!root) throw new XmlError('no XML element found');
  return root;
}

// --- Reading the tree ---------------------------------------------------------

/** The element children of `el` named `name` (any namespace prefix). */
export function childrenOf(el, name) {
  return (el?.children ?? []).filter((c) => typeof c === 'object' && c.name === name);
}

export function childOf(el, name) {
  return (el?.children ?? []).find((c) => typeof c === 'object' && c.name === name);
}

/** The element children of `el`. */
export function elementsOf(el) {
  return (el?.children ?? []).filter((c) => typeof c === 'object');
}

/** The text of an element and its descendants (iterative: no deep recursion), joined once. */
export function textOf(el) {
  if (!el) return '';
  const out = [];
  const stack = [el];
  while (stack.length > 0) {
    const node = stack.pop();
    if (typeof node === 'string') {
      out.push(node);
    } else {
      for (let i = node.children.length - 1; i >= 0; i -= 1) stack.push(node.children[i]);
    }
  }
  return out.join('');
}

/** The trimmed text of the child `name`, or undefined when there is no such child. */
export function childText(el, name) {
  const child = childOf(el, name);
  return child ? textOf(child).trim() : undefined;
}
