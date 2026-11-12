import { useBackend } from "@/api/backend";
import { MenuButton, type ButtonProps, type MenuItem } from "@/ui";
import { THEMES, isChoice, useTheme } from "./theme";

/** The theme switch: System, Clearing or Night forest, with the current one ticked. */
export function ThemeMenu({ size }: { size?: ButtonProps["size"] }) {
  const backend = useBackend();
  const choice = useTheme((s) => s.choice);
  const resolved = useTheme((s) => s.resolved);
  const choose = useTheme((s) => s.choose);
  const items: MenuItem[] = THEMES.map((t) => ({ id: t.id, label: t.label, icon: t.id === choice ? "check" : undefined }));
  return (
    <MenuButton
      label="Theme"
      icon={resolved === "dark" ? "moon" : "sun"}
      size={size}
      items={items}
      onSelect={(id) => {
        if (isChoice(id)) void choose(backend, id);
      }}
    />
  );
}
