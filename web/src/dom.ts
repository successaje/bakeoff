/**
 * Element building without HTML parsing: every string becomes a text node,
 * so account names and reasons from the chain cannot inject markup.
 */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | boolean | ((event: Event) => void) | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (typeof value === "function") element.addEventListener(name.replace(/^on/, ""), value);
    else if (value === true) element.setAttribute(name, "");
    else element.setAttribute(name, value);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    element.append(child instanceof Node ? child : String(child));
  }
  return element;
}

export function link(href: string, text: string, external = true): HTMLAnchorElement {
  return h("a", external ? { href, target: "_blank", rel: "noopener noreferrer" } : { href }, text);
}
