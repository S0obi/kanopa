import { afterEach, describe, expect, it } from "vitest";
import { blockBrowserMenu, wantsBrowserMenu } from "./contextmenu";

const fire = (el: Element) => {
  const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e.defaultPrevented;
};

afterEach(() => {
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

describe("the browser's own menu", () => {
  it("is kept on text fields and selected text only", () => {
    document.body.innerHTML = `<input id="t" type="text"><input id="c" type="checkbox"><textarea id="a"></textarea><p id="p">Some text</p><div id="d">x</div>`;
    const $ = (id: string) => document.getElementById(id)!;
    expect(wantsBrowserMenu($("t"))).toBe(true);
    expect(wantsBrowserMenu($("a"))).toBe(true);
    expect(wantsBrowserMenu($("c"))).toBe(false);
    expect(wantsBrowserMenu($("p"))).toBe(false);
    window.getSelection()!.selectAllChildren($("p"));
    expect(wantsBrowserMenu($("p"))).toBe(true);
    expect(wantsBrowserMenu($("d"))).toBe(false);
    expect(wantsBrowserMenu(document.body)).toBe(false);
  });

  it("is blocked everywhere else once installed", () => {
    document.body.innerHTML = `<input id="t"><div id="d">x</div>`;
    const off = blockBrowserMenu();
    expect(fire(document.getElementById("d")!)).toBe(true);
    expect(fire(document.getElementById("t")!)).toBe(false);
    off();
    expect(fire(document.getElementById("d")!)).toBe(false);
  });
});
