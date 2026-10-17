// Runtime DOM & scroll optimizations for @wterm terminal instances.
//
// Chrome DevTools traces of `htop -d 0.5` showed 95% of animation-frame time
// spent in two places inside @wterm:
//   1. `WTerm._scrollToBottom()` reading `this.element.scrollHeight` on every
//      rendered frame right after DOM mutations, forcing 61 synchronous full-
//      document layouts even when scrollback count and row geometry were
//      unchanged (a 100% no-op scrollTop assignment).
//   2. `DomRenderer.updateRowParts()` falling back to `innerHTML` /
//      `Range.createContextualFragment()` (2,456 `ParseHTML` calls in 3.78s)
//      whenever any single span in a row changed its `--term-span-cols` or
//      color style, destroying and recreating all spans in the row.

export type RowPart = {
  html: string;
  opening?: string;
  text?: string;
};

type ParsedSpanOpening = {
  className: string;
  style: string;
};

const spanOpeningCache = new Map<string, ParsedSpanOpening>();

export function parseSpanOpening(opening: string): ParsedSpanOpening {
  let cached = spanOpeningCache.get(opening);
  if (cached !== undefined) return cached;
  const classMatch = opening.match(/ class="([^"]*)"/);
  const styleMatch = opening.match(/ style="([^"]*)"/);
  cached = {
    className: classMatch ? classMatch[1]! : "",
    style: styleMatch ? styleMatch[1]! : "",
  };
  if (spanOpeningCache.size > 2048) spanOpeningCache.clear();
  spanOpeningCache.set(opening, cached);
  return cached;
}

function isFlatSpanNode(node: ChildNode | undefined): node is HTMLSpanElement {
  return (
    node !== undefined &&
    node.nodeType === 1 &&
    node.nodeName === "SPAN" &&
    node.childNodes.length === 1 &&
    node.firstChild?.nodeType === 3
  );
}

export function updateRowPartsInPlace(
  row: HTMLElement,
  parts: RowPart[],
  rowPartsMap: WeakMap<HTMLElement, RowPart[]>,
  fallback?: (row: HTMLElement, parts: RowPart[]) => void,
): void {
  const previous = rowPartsMap.get(row);
  let start = 0;
  let oldEnd = previous?.length ?? 0;
  let newEnd = parts.length;
  if (previous) {
    while (start < oldEnd && start < newEnd && previous[start]!.html === parts[start]!.html) {
      start++;
    }
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1]!.html === parts[newEnd - 1]!.html) {
      oldEnd--;
      newEnd--;
    }
  }
  if (start === oldEnd && start === newEnd) return;

  let canPatchInPlace = previous !== undefined || row.childNodes.length === 0;
  for (let i = start; canPatchInPlace && i < newEnd; i++) {
    const part = parts[i]!;
    if (part.opening === undefined || part.text === undefined) {
      canPatchInPlace = false;
    }
  }
  for (let i = start; canPatchInPlace && i < oldEnd; i++) {
    if (!isFlatSpanNode(row.childNodes[i])) {
      canPatchInPlace = false;
    }
  }

  if (!canPatchInPlace) {
    if (fallback) {
      fallback(row, parts);
      return;
    }
    row.innerHTML = parts.map((part) => part.html).join("");
    rowPartsMap.set(row, parts);
    return;
  }

  const commonEnd = Math.min(oldEnd, newEnd);
  for (let i = start; i < commonEnd; i++) {
    const prev = previous![i]!;
    const next = parts[i]!;
    if (prev.html === next.html) continue;
    const span = row.childNodes[i] as HTMLSpanElement;
    if (prev.opening !== next.opening) {
      const nextAttrs = parseSpanOpening(next.opening!);
      const prevAttrs = prev.opening !== undefined ? parseSpanOpening(prev.opening) : null;
      if (!prevAttrs || prevAttrs.className !== nextAttrs.className) {
        span.className = nextAttrs.className;
      }
      if (!prevAttrs || prevAttrs.style !== nextAttrs.style) {
        span.style.cssText = nextAttrs.style;
      }
    }
    if (prev.text !== next.text) {
      span.firstChild!.nodeValue = next.text!;
    }
  }

  if (newEnd > commonEnd) {
    const doc = row.ownerDocument;
    const refNode = row.childNodes[oldEnd] ?? null;
    const frag = newEnd - commonEnd > 1 ? doc.createDocumentFragment() : null;
    for (let i = commonEnd; i < newEnd; i++) {
      const next = parts[i]!;
      const attrs = parseSpanOpening(next.opening!);
      const span = doc.createElement("span");
      if (attrs.className) span.className = attrs.className;
      if (attrs.style) span.style.cssText = attrs.style;
      span.appendChild(doc.createTextNode(next.text!));
      if (frag) {
        frag.appendChild(span);
      } else {
        row.insertBefore(span, refNode);
      }
    }
    if (frag) row.insertBefore(frag, refNode);
  } else if (oldEnd > commonEnd) {
    for (let count = oldEnd - commonEnd; count > 0; count--) {
      row.childNodes[commonEnd]?.remove();
    }
  }

  rowPartsMap.set(row, parts);
}

type OptimizableWTerm = {
  element?: HTMLElement;
  rows?: number;
  _rowHeight?: number;
  _programmaticScrollTop?: number;
  _setScrollTop?: (value: number) => void;
  _scrollToBottom?: () => void;
  bridge?: {
    getScrollbackCount?: () => number;
  } | null;
  renderer?: {
    hasImageFlow?: boolean;
    rowParts?: WeakMap<HTMLElement, RowPart[]>;
    updateRowParts?: (row: HTMLElement, parts: RowPart[]) => void;
  } | null;
};

export function optimizeTerminalInstance(wt: unknown): void {
  const instance = wt as OptimizableWTerm | null;
  if (!instance || typeof instance !== "object") return;

  const renderer = instance.renderer;
  if (renderer && renderer.rowParts instanceof WeakMap && typeof renderer.updateRowParts === "function") {
    const originalUpdateRowParts = renderer.updateRowParts.bind(renderer);
    const rowPartsMap = renderer.rowParts;
    renderer.updateRowParts = (row: HTMLElement, parts: RowPart[]) => {
      updateRowPartsInPlace(row, parts, rowPartsMap, originalUpdateRowParts);
    };
  }

  if (instance.element && typeof instance._scrollToBottom === "function" && typeof instance._setScrollTop === "function") {
    const element = instance.element;
    const originalScrollToBottom = instance._scrollToBottom.bind(instance);
    let pinnedKey: string | null = null;
    element.addEventListener(
      "scroll",
      () => {
        if (element.scrollTop !== instance._programmaticScrollTop) {
          pinnedKey = null;
        }
      },
      { passive: true },
    );
    instance._scrollToBottom = () => {
      if (instance.renderer?.hasImageFlow) {
        pinnedKey = null;
        originalScrollToBottom();
        return;
      }
      const scrollbackCount = instance.bridge?.getScrollbackCount?.() ?? 0;
      if (scrollbackCount === 0) {
        if (pinnedKey === "0") return;
        if (element.scrollTop !== 0) {
          instance._setScrollTop!(0);
        }
        pinnedKey = "0";
        return;
      }
      const key = `${scrollbackCount}:${instance.rows ?? 0}:${instance._rowHeight ?? 0}`;
      if (pinnedKey === key) return;
      originalScrollToBottom();
      pinnedKey = key;
    };
  }
}
