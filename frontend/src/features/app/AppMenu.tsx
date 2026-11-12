import { useState } from "react";
import { errorText, useBackend } from "@/api/backend";
import { THEMES, isChoice, useTheme } from "@/theme/theme";
import { MenuButton, useToasts, type ButtonProps, type MenuItem } from "@/ui";
import { AboutDialog } from "./AboutDialog";

/** Kanopa's own menu, a gear in the header: the theme, About, and the log folder. */
export function AppMenu({ size }: { size?: ButtonProps["size"] }) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const choice = useTheme((s) => s.choice);
  const choose = useTheme((s) => s.choose);
  const [about, setAbout] = useState(false);

  const items: MenuItem[] = [
    { heading: "Theme" },
    ...THEMES.map((t): MenuItem => ({ id: `theme:${t.id}`, label: t.label, icon: t.id === choice ? "check" : undefined })),
    { separator: true },
    { id: "about", label: "About Kanopa…", icon: "info" },
    { id: "logs", label: "Open log folder", icon: "folder" },
  ];

  async function onSelect(id: string) {
    if (id.startsWith("theme:")) {
      const t = id.slice("theme:".length);
      if (isChoice(t)) void choose(backend, t);
    } else if (id === "about") {
      // The menu gives focus back to its button as it closes: open the dialog after that.
      setTimeout(() => setAbout(true), 0);
    } else if (id === "logs") {
      try {
        await backend.openLogFolder();
      } catch (e) {
        toast(errorText(e), "danger");
      }
    }
  }

  return (
    <>
      <MenuButton label="Menu" icon="settings" size={size} items={items} onSelect={(id) => void onSelect(id)} />
      {about && <AboutDialog onClose={() => setAbout(false)} />}
    </>
  );
}
