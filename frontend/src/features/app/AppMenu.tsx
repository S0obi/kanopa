import { useState } from "react";
import { errorText, useBackend } from "@/api/backend";
import { useUpdates } from "@/stores/updates";
import { THEMES, isChoice, useTheme } from "@/theme/theme";
import { MenuButton, useToasts, type ButtonProps, type MenuItem } from "@/ui";
import { AboutDialog } from "./AboutDialog";

/** Kanopa's own menu, a gear in the header: the theme, updates, About, and the log folder. */
export function AppMenu({ size }: { size?: ButtonProps["size"] }) {
  const backend = useBackend();
  const toast = useToasts((s) => s.show);
  const choice = useTheme((s) => s.choice);
  const choose = useTheme((s) => s.choose);
  const [about, setAbout] = useState(false);
  const updates = useUpdates((s) => s.status);
  const askByHand = useUpdates((s) => s.askByHand);
  const setUpdates = useUpdates((s) => s.set);

  const items: MenuItem[] = [
    { heading: "Theme" },
    ...THEMES.map((t): MenuItem => ({ id: `theme:${t.id}`, label: t.label, icon: t.id === choice ? "check" : undefined })),
    { separator: true },
    ...(updates?.supported
      ? [
          { id: "update:check", label: "Check for updates…", icon: "download" } as MenuItem,
          { id: "update:auto", label: "Check for updates automatically", icon: updates.auto ? "check" : undefined } as MenuItem,
          { separator: true } as MenuItem,
        ]
      : []),
    { id: "about", label: "About Kanopa…", icon: "info" },
    { id: "logs", label: "Open log folder", icon: "folder" },
  ];

  async function onSelect(id: string) {
    if (id.startsWith("theme:")) {
      const t = id.slice("theme:".length);
      if (isChoice(t)) void choose(backend, t);
    } else if (id === "update:check") {
      void askByHand(backend);
    } else if (id === "update:auto") {
      try {
        setUpdates(await backend.setAutoUpdate(!updates?.auto));
      } catch (e) {
        toast(errorText(e), "danger");
      }
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
