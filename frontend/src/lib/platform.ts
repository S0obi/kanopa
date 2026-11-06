export type Platform = "mac" | "windows";

/** 'mac' on macOS, 'windows' everywhere else (Kanopa ships on those two). */
export function detectPlatform(): Platform {
  try {
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const p = nav.userAgentData?.platform || navigator.platform || "";
    return /mac/i.test(p) ? "mac" : "windows";
  } catch {
    return "windows";
  }
}

/** Where the OS keeps secrets, as the UI names it. */
export function credentialStoreName(platform: Platform): string {
  return platform === "mac" ? "macOS Keychain" : "Windows Credential Manager";
}

/** True when the platform's primary modifier (⌘ on macOS, Ctrl on Windows) is held. */
export function isMod(e: { metaKey: boolean; ctrlKey: boolean }, platform: Platform): boolean {
  return platform === "mac" ? e.metaKey : e.ctrlKey;
}
