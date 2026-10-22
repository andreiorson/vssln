/** An element of an XML document: its attributes, child elements and the text directly inside it. */
export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  text: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const ATTRIBUTE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

export function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi, (m, name: string) => {
    const lower = name.toLowerCase();
    if (!lower.startsWith('#')) return ENTITIES[lower] ?? m;
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    // A reference to no character is kept as written rather than failing the whole file.
    return code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
}

/**
 * The root element of an XML document, read leniently: an unclosed element ends with its parent or the document,
 * and a stray closing tag is ignored. Undefined when there is no element at all.
 */
export function parseXml(text: string): XmlElement | undefined {
  const root: XmlElement = { name: '', attributes: {}, children: [], text: '' };
  const stack: XmlElement[] = [root];
  const top = () => stack[stack.length - 1];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    const textEnd = lt < 0 ? text.length : lt;
    if (textEnd > i) top().text += decodeXml(text.slice(i, textEnd));
    if (lt < 0) break;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      top().text += text.slice(lt + 9, end < 0 ? text.length : end);
      i = end < 0 ? text.length : end + 3;
    } else if (text.startsWith('<?', lt) || text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt);
      i = end < 0 ? text.length : end + 1;
    } else {
      // The end of the tag: the first '>' outside quoted attribute values.
      let j = lt + 1;
      let quote = '';
      while (j < text.length && (quote || text[j] !== '>')) {
        if (quote) {
          if (text[j] === quote) quote = '';
        } else if (text[j] === '"' || text[j] === "'") {
          quote = text[j];
        }
        j++;
      }
      const tag = text.slice(lt + 1, j);
      i = j + 1;
      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim();
        const at = stack.map(e => e.name).lastIndexOf(name);
        if (at > 0) stack.length = at;
        continue;
      }
      const selfClosing = tag.endsWith('/');
      const body = selfClosing ? tag.slice(0, -1) : tag;
      const name = /^[^\s/>]+/.exec(body)?.[0];
      if (!name) continue;
      const attributes: Record<string, string> = {};
      for (const m of body.slice(name.length).matchAll(ATTRIBUTE)) attributes[m[1]] = decodeXml(m[2] ?? m[3]);
      const element: XmlElement = { name, attributes, children: [], text: '' };
      top().children.push(element);
      if (!selfClosing) stack.push(element);
    }
  }
  return root.children[0];
}
