import { z } from "zod";
import { parseLdapUrl, type Security } from "./url";
import type { ConnectionParams } from "@/api/backend";

const DN_RE = /^\s*[A-Za-z][\w-]*=[^,]+(,\s*[A-Za-z][\w-]*=[^,]+)*\s*$/;

export const connectionFormSchema = z
  .object({
    url: z.string().refine((v) => parseLdapUrl(v) !== null, "Enter an LDAP URL such as ldaps://ldap.example.org:636."),
    security: z.enum(["ldaps", "starttls", "none"]),
    baseDn: z.string().refine((v) => v.trim() === "" || DN_RE.test(v), "Invalid DN syntax (34) — a base DN looks like dc=example,dc=org."),
    bind: z.enum(["simple", "anonymous"]),
    bindDn: z.string(),
    password: z.string(),
    timeoutSeconds: z.number({ error: "Enter a number of seconds." }).int("Enter whole seconds.").min(1, "Use at least 1 second.").max(300, "Use at most 300 seconds."),
    pageSize: z.number({ error: "Enter a page size." }).int("Enter a whole number.").min(1, "Use at least 1.").max(10000, "Use at most 10,000."),
    referrals: z.enum(["follow", "show", "ignore"]),
    readOnly: z.boolean(),
    verifyCert: z.boolean(),
  })
  .superRefine((v, ctx) => {
    if (v.bind !== "simple") return;
    if (!v.bindDn.trim()) ctx.addIssue({ code: "custom", path: ["bindDn"], message: "Enter a bind DN, or choose Anonymous." });
    else if (!DN_RE.test(v.bindDn))
      ctx.addIssue({ code: "custom", path: ["bindDn"], message: "Invalid DN syntax (34) — a bind DN looks like cn=admin,dc=example,dc=org." });
  });

export type ConnectionForm = z.infer<typeof connectionFormSchema>;

export const emptyConnectionForm: ConnectionForm = {
  url: "",
  security: "ldaps" satisfies Security,
  baseDn: "",
  bind: "simple",
  bindDn: "",
  password: "",
  timeoutSeconds: 10,
  pageSize: 500,
  referrals: "show",
  readOnly: false,
  verifyCert: true,
};

/** What Go needs to test the connection. */
export function toParams(f: ConnectionForm): ConnectionParams {
  return {
    url: f.url.trim(),
    security: f.security,
    bind: f.bind,
    bindDn: f.bind === "simple" ? f.bindDn.trim() : "",
    password: f.bind === "simple" ? f.password : "",
    timeoutSeconds: f.timeoutSeconds,
    verifyCert: f.verifyCert,
  };
}

/** "timeout 10 s · page size 500 · referrals shown" — the Advanced section's summary. */
export function advancedSummary(f: Pick<ConnectionForm, "timeoutSeconds" | "pageSize" | "referrals">): string {
  const ref = f.referrals === "follow" ? "followed" : f.referrals === "show" ? "shown" : "ignored";
  return `timeout ${f.timeoutSeconds} s · page size ${f.pageSize.toLocaleString("en-US")} · referrals ${ref}`;
}
