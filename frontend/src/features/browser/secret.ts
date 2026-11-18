import { useEffect, useRef, useState } from "react";
import { useBackend } from "@/api/backend";
import { useToasts } from "@/ui";

/** How long a copied password stays on the clipboard. Go clears it; the page only counts down. */
export const CLIPBOARD_SECONDS = 60;

/**
 * Copies a password that clears itself from the clipboard, and counts the seconds left for the
 * hint. Go does the clearing, and only while the clipboard still holds the password.
 */
export function useSecretCopy() {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const [left, setLeft] = useState(0);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(timer.current), []);

  const stop = () => {
    clearInterval(timer.current);
    setLeft(0);
  };

  /** Resolves true when the password is on the clipboard. */
  async function copy(text: string): Promise<boolean> {
    try {
      await backend.copySecret(text, CLIPBOARD_SECONDS);
    } catch {
      toast("Kanopa couldn't copy the password.", "danger");
      return false;
    }
    clearInterval(timer.current);
    setLeft(CLIPBOARD_SECONDS);
    timer.current = setInterval(() => {
      setLeft((n) => {
        if (n <= 1) clearInterval(timer.current);
        return Math.max(n - 1, 0);
      });
    }, 1000);
    return true;
  }

  return { left, copy, stop };
}

/** What the hint says while a copied password is on the clipboard. */
export const clipboardNote = (left: number) => `Copied. Clears from the clipboard in ${left} s. Clipboard history or sync may keep a copy.`;
