import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  optimizeTerminalInstance,
  parseSpanOpening,
  updateRowPartsInPlace,
} from "./terminalOptimizations.ts";

function makePart(className, style, text) {
  const classAttr = className ? ` class="${className}"` : "";
  const styleAttr = style ? ` style="${style}"` : "";
  const opening = `<span${classAttr}${styleAttr}>`;
  return {
    html: `${opening}${text}</span>`,
    opening,
    text,
  };
}

function makeFakeRow() {
  const doc = {
    createElement(tag) {
      return {
        nodeType: 1,
        nodeName: tag.toUpperCase(),
        className: "",
        style: { cssText: "" },
        childNodes: [],
        get firstChild() {
          return this.childNodes[0] ?? null;
        },
        appendChild(child) {
          this.childNodes.push(child);
          child.parentNode = this;
          return child;
        },
        remove() {
          if (!this.parentNode) return;
          const idx = this.parentNode.childNodes.indexOf(this);
          if (idx >= 0) this.parentNode.childNodes.splice(idx, 1);
          this.parentNode = null;
        },
      };
    },
    createTextNode(text) {
      return { nodeType: 3, nodeValue: text, parentNode: null };
    },
    createDocumentFragment() {
      return {
        isFragment: true,
        childNodes: [],
        appendChild(child) {
          this.childNodes.push(child);
          return child;
        },
      };
    },
  };

  return {
    ownerDocument: doc,
    childNodes: [],
    innerHTMLCalls: 0,
    set innerHTML(_val) {
      this.innerHTMLCalls++;
      this.childNodes = [];
    },
    insertBefore(node, refNode) {
      const items = node.isFragment ? [...node.childNodes] : [node];
      const idx = refNode ? this.childNodes.indexOf(refNode) : this.childNodes.length;
      const insertAt = idx >= 0 ? idx : this.childNodes.length;
      for (const item of items) item.parentNode = this;
      this.childNodes.splice(insertAt, 0, ...items);
      return node;
    },
  };
}

test("parseSpanOpening extracts class and style attributes", () => {
  assert.deepEqual(parseSpanOpening("<span>"), { className: "", style: "" });
  assert.deepEqual(
    parseSpanOpening('<span class="term-cursor" style="--term-span-cols:4;color:#fff;">'),
    { className: "term-cursor", style: "--term-span-cols:4;color:#fff;" },
  );
  assert.deepEqual(
    parseSpanOpening('<span style="--term-span-cols:12;">'),
    { className: "", style: "--term-span-cols:12;" },
  );
});

test("updateRowPartsInPlace updates spans in place without innerHTML or HTML parsing", () => {
  const row = makeFakeRow();
  const map = new WeakMap();

  const initial = [
    makePart("", "--term-span-cols:4;", "PID "),
    makePart("", "--term-span-cols:6;color:green;", "||||  "),
    makePart("", "--term-span-cols:5;", " 34% "),
    makePart("", "--term-span-cols:8;", "htop -d "),
  ];
  updateRowPartsInPlace(row, initial, map);
  assert.equal(row.innerHTMLCalls, 0);
  assert.equal(row.childNodes.length, 4);
  const originalNodes = [...row.childNodes];

  // Change style on span 1 and text on span 2 while keeping span 0 and span 3 unchanged.
  const next = [
    makePart("", "--term-span-cols:4;", "PID "),
    makePart("", "--term-span-cols:7;color:green;", "||||| "),
    makePart("", "--term-span-cols:5;", " 42% "),
    makePart("", "--term-span-cols:8;", "htop -d "),
  ];
  updateRowPartsInPlace(row, next, map);
  assert.equal(row.innerHTMLCalls, 0);
  assert.equal(row.childNodes.length, 4);
  // Every existing span DOM node is preserved in place!
  for (let i = 0; i < 4; i++) {
    assert.equal(row.childNodes[i], originalNodes[i]);
  }
  assert.equal(row.childNodes[1].style.cssText, "--term-span-cols:7;color:green;");
  assert.equal(row.childNodes[1].firstChild.nodeValue, "||||| ");
  assert.equal(row.childNodes[2].firstChild.nodeValue, " 42% ");

  // Insert an extra span in the middle and then shrink back.
  const expanded = [
    makePart("", "--term-span-cols:4;", "PID "),
    makePart("term-cursor", "--term-span-cols:1;", "|"),
    makePart("", "--term-span-cols:6;color:green;", "|||| "),
    makePart("", "--term-span-cols:5;", " 42% "),
    makePart("", "--term-span-cols:8;", "htop -d "),
  ];
  updateRowPartsInPlace(row, expanded, map);
  assert.equal(row.innerHTMLCalls, 0);
  assert.equal(row.childNodes.length, 5);
  assert.equal(row.childNodes[1].className, "term-cursor");
  assert.equal(row.childNodes[1].firstChild.nodeValue, "|");
  assert.equal(row.childNodes[4], originalNodes[3], "retained suffix node is preserved");

  updateRowPartsInPlace(row, next, map);
  assert.equal(row.innerHTMLCalls, 0);
  assert.equal(row.childNodes.length, 4);
  assert.equal(row.childNodes[1].firstChild.nodeValue, "||||| ");
  assert.equal(row.childNodes[3], originalNodes[3]);
});

test("optimizeTerminalInstance skips redundant scrollHeight layouts in _scrollToBottom", () => {
  let scrollHeightReads = 0;
  let scrollTopReads = 0;
  let scrollTopValue = 0;
  let scrollbackCount = 0;
  let scrollListener = null;
  const element = {
    get scrollTop() {
      scrollTopReads++;
      return scrollTopValue;
    },
    set scrollTop(val) {
      scrollTopValue = val;
    },
    get scrollHeight() {
      scrollHeightReads++;
      return 600;
    },
    addEventListener(type, fn) {
      if (type === "scroll") scrollListener = fn;
    },
  };
  const wt = {
    element,
    rows: 30,
    _rowHeight: 16,
    _programmaticScrollTop: 0,
    _setScrollTop(val) {
      this.element.scrollTop = val;
      this._programmaticScrollTop = val;
    },
    _scrollToBottom() {
      this._setScrollTop(this.element.scrollHeight);
    },
    bridge: {
      getScrollbackCount: () => scrollbackCount,
    },
    renderer: {
      hasImageFlow: false,
      rowParts: new WeakMap(),
      updateRowParts() {},
    },
  };

  optimizeTerminalInstance(wt);

  // With 0 scrollback lines (e.g. htop in a fresh terminal), scrollHeight is never read,
  // and scrollTop is only checked once to pin "0" (never on subsequent frames).
  wt._scrollToBottom();
  wt._scrollToBottom();
  wt._scrollToBottom();
  assert.equal(scrollHeightReads, 0);
  assert.equal(scrollTopReads, 1);

  // When scrollback grows to 25 lines, _scrollToBottom reads scrollHeight once and caches the pin.
  scrollbackCount = 25;
  wt._scrollToBottom();
  assert.equal(scrollHeightReads, 1);
  assert.equal(element.scrollTop, 600);

  // Subsequent frames with the same scrollbackCount/rows/rowHeight skip reading scrollHeight.
  wt._scrollToBottom();
  wt._scrollToBottom();
  assert.equal(scrollHeightReads, 1);

  // If the user scrolls up manually, the next _scrollToBottom re-pins.
  element.scrollTop = 200;
  scrollListener?.();
  wt._scrollToBottom();
  assert.equal(scrollHeightReads, 2);
});

test("terminal rows and side-tab-panel are strict CSS relayout boundaries", () => {
  const css = readFileSync(new URL("./theme.css", import.meta.url), "utf8");
  assert.ok(/\.terminal-panel-term\s+\.term-row\s*\{[^}]*contain:\s*strict/.test(css));
  assert.ok(/\.side-tab-panel\s*\{[^}]*contain:\s*strict/.test(css));
});
