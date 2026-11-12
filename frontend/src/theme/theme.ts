import { create } from "zustand";
import { errorText, type Backend, type ThemeChoice, type ThemeName } from "@/api/backend";
import { useToasts } from "@/ui";

/** The choices, in the order the menu lists them. Clearing is the light theme, Night forest the dark one. */
export const THEMES: { id: ThemeChoice; label: string }[] = [
  { id: "system", label: "System" },
  { id: "light", label: "Clearing" },
  { id: "dark", label: "Night forest" },
];

export const isChoice = (v: unknown): v is ThemeChoice => v === "system" || v === "light" || v === "dark";

/** The theme the page shows for a choice: System follows the operating system. */
export const resolveTheme = (choice: ThemeChoice, osDark: boolean): ThemeName => (choice === "system" ? (osDark ? "dark" : "light") : choice);

const QUERY = "(prefers-color-scheme: dark)";
const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

interface ThemeState {
  choice: ThemeChoice;
  resolved: ThemeName;
  /** Reads the saved choice, shows it, and follows the operating system while the choice is System. */
  start(b: Backend): Promise<void>;
  /** Shows and saves a choice. It applies even when it can't be saved, and says so. */
  choose(b: Backend, choice: ThemeChoice): Promise<void>;
}

export const useTheme = create<ThemeState>((set, get) => {
  let backend: Backend | null = null;
  let stopWatching: (() => void) | null = null;

  /** Puts the theme on the page and tells the window, so its frame matches. */
  const show = (choice: ThemeChoice) => {
    const resolved = resolveTheme(choice, media()?.matches ?? false);
    const root = document.documentElement;
    root.dataset.theme = resolved;
    root.dataset.themeChoice = choice;
    set({ choice, resolved });
    // Told every time, not only when the theme changed: a system change can repaint the frame by itself.
    void backend?.setAppearance(resolved).catch(() => {});
  };

  return {
    choice: "system",
    resolved: "light",
    async start(b) {
      backend = b;
      let choice: ThemeChoice = "system";
      try {
        const saved = await b.theme();
        if (isChoice(saved)) choice = saved;
      } catch {
        // Unreadable settings: System, as if nothing was saved.
      }
      show(choice);
      stopWatching?.();
      const m = media();
      if (m) {
        const onChange = () => show(get().choice);
        m.addEventListener("change", onChange);
        stopWatching = () => m.removeEventListener("change", onChange);
      }
    },
    async choose(b, choice) {
      backend = b;
      show(choice);
      try {
        await b.setTheme(choice);
      } catch (e) {
        useToasts.getState().show(`Kanopa could not save the theme. ${errorText(e)}`, "warning");
      }
    },
  };
});
