import { z } from "zod";
import { parseLdapUrl, type Security } from "./url";
import { isDnSyntax } from "@/lib/dn";
import type { ConnectionParams, SavedConnection, SaveRequest } from "@/api/backend";


/**
 * What a simple bind accepts as a name: a DN, or the two forms Active Directory adds:
 * DOMAIN\user (the NetBIOS name) and user@example.org (the user principal name).
 */
export function isBindName(v: string): boolean {
  const s = v.trim();
  return isDnSyntax(s) || /^[A-Za-z0-9._-]+\\[^\\/[\]:;|=,+*?<>"@]+$/.test(s) || /^[^@\s,=\\]+@[A-Za-z0-9.-]+$/.test(s);
}

export const connectionFormSchema = z
  .object({
    name: z.string(),
    url: z.string().refine((v) => parseLdapUrl(v) !== null, "Enter an LDAP URL such as ldaps://ldap.example.org:636."),
    security: z.enum(["ldaps", "starttls", "none"]),
    baseDn: z.string().refine((v) => v.trim() === "" || isDnSyntax(v), "Invalid DN syntax (34) — a base DN looks like dc=example,dc=org."),
    bind: z.enum(["simple", "anonymous"]),
    bindDn: z.string(),
    password: z.string(),
    savePassword: z.boolean(),
    timeoutSeconds: z.number({ error: "Enter a number of seconds." }).int("Enter whole seconds.").min(1, "Use at least 1 second.").max(300, "Use at most 300 seconds."),
    pageSize: z.number({ error: "Enter a page size." }).int("Enter a whole number.").min(1, "Use at least 1.").max(10000, "Use at most 10,000."),
    referrals: z.enum(["follow", "show", "ignore"]),
    readOnly: z.boolean(),
    verifyCert: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.bind !== "simple") return;
    if (!v.bindDn.trim()) ctx.addIssue({ code: "custom", path: ["bindDn"], message: "Enter a bind DN, or choose Anonymous." });
    else if (!isBindName(v.bindDn))
      ctx.addIssue({ code: "custom", path: ["bindDn"], message: "Invalid DN syntax (34) — a bind name looks like cn=admin,dc=example,dc=org, DOMAIN\\user or user@example.org." });
  });

/** Saving also needs a name; testing does not. */
export const saveFormSchema = connectionFormSchema.superRefine((v, ctx) => {
  if (!v.name.trim()) ctx.addIssue({ code: "custom", path: ["name"], message: "Enter a name for this connection." });
});

export type ConnectionForm = z.infer<typeof connectionFormSchema>;

export const emptyConnectionForm: ConnectionForm = {
  name: "",
  url: "",
  security: "ldaps" satisfies Security,
  baseDn: "",
  bind: "simple",
  bindDn: "",
  password: "",
  savePassword: true,
  timeoutSeconds: 10,
  pageSize: 500,
  referrals: "show",
  readOnly: false,
  verifyCert: true,
};

/** The form for a saved connection. The password field starts empty: empty keeps the saved one. */
export function formFromSaved(c: SavedConnection): ConnectionForm {
  return {
    name: c.name,
    url: c.url,
    security: c.security as Security,
    baseDn: c.baseDn,
    bind: c.bind === "anonymous" ? "anonymous" : "simple",
    bindDn: c.bindDn,
    password: "",
    savePassword: c.bind === "anonymous" ? true : c.savePassword,
    timeoutSeconds: c.timeoutSeconds,
    pageSize: c.pageSize,
    referrals: c.referrals === "ignore" ? "ignore" : "show",
    readOnly: c.readOnly,
    verifyCert: c.verifyCert,
  };
}

/** What Go needs to test the connection. With a connection ID, an empty password uses the saved one. */
export function toParams(f: ConnectionForm, connectionId = ""): ConnectionParams {
  return {
    url: f.url.trim(),
    security: f.security,
    bind: f.bind,
    bindDn: f.bind === "simple" ? f.bindDn.trim() : "",
    password: f.bind === "simple" ? f.password : "",
    timeoutSeconds: f.timeoutSeconds,
    verifyCert: f.verifyCert,
    connectionId,
  };
}

export function toSaveRequest(f: ConnectionForm, id = ""): SaveRequest {
  const simple = f.bind === "simple";
  return {
    id,
    name: f.name.trim(),
    url: f.url.trim(),
    security: f.security,
    baseDn: f.baseDn.trim(),
    bind: f.bind,
    bindDn: simple ? f.bindDn.trim() : "",
    password: simple && f.savePassword ? f.password : "",
    savePassword: simple && f.savePassword,
    timeoutSeconds: f.timeoutSeconds,
    pageSize: f.pageSize,
    referrals: f.referrals,
    readOnly: f.readOnly,
    verifyCert: f.verifyCert,
  };
}

/** "timeout 10 s · page size 500 · referrals shown" — the Advanced section's summary. */
export function advancedSummary(f: Pick<ConnectionForm, "timeoutSeconds" | "pageSize" | "referrals">): string {
  const ref = f.referrals === "follow" ? "followed" : f.referrals === "show" ? "shown" : "ignored";
  return `timeout ${f.timeoutSeconds} s · page size ${f.pageSize.toLocaleString("en-US")} · referrals ${ref}`;
}
