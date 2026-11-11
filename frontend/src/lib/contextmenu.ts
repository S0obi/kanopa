const TEXT_INPUTS = /^(text|search|email|url|tel|password|number|)$/;

/** True when the right-click is on a text field, or on selected text: the browser's Copy/Paste menu helps there. */
export function wantsBrowserMenu(target: EventTarget | null, selection: Selection | null = window.getSelection()): boolean {
  const el = target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return TEXT_INPUTS.test(el.type);
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  if (!selection || selection.isCollapsed) return false;
  // On the selection itself: inside it, not on a container around it.
  for (let i = 0; i < selection.rangeCount; i++) {
    const r = selection.getRangeAt(i);
    if (r.commonAncestorContainer.contains(el) && r.intersectsNode(el)) return true;
  }
  return false;
}

/**
 * The webview's own menu (Back, Reload, Print, Inspect) means nothing in Kanopa. Release builds
 * of Wails hide it already; dev builds show it everywhere. This hides it in every build, except
 * on text fields and selected text. Returns the uninstaller.
 */
export function blockBrowserMenu(): () => void {
  const onMenu = (e: MouseEvent) => {
    if (!wantsBrowserMenu(e.target)) e.preventDefault();
  };
  window.addEventListener("contextmenu", onMenu);
  return () => window.removeEventListener("contextmenu", onMenu);
}
