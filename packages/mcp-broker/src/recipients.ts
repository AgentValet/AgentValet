// Recipient allow-list: the "recipient_domains" obligation (domains and/or exact addresses).
//
// A policy source attaches this obligation to a decision for a tool that sends
// something (email, invites, shares). The pipeline enforces it against the
// call's arguments before approval and before the handler runs. A violation is
// a hard deny, never an approval prompt.
//
// The server author names which arguments hold recipients. The broker cannot
// know that for an arbitrary tool, so it fails closed on everything it cannot
// read: a recipient value that is not a string (or array of strings), a
// recipient with no '@', or a call where none of the named arguments carries a
// recipient at all (usually a misnamed argument, which would otherwise pass
// every call silently).
//
// Semantics match the hosted plane's recipient constraints. Domains: exact match
// after lower-casing, trailing-dot stripping and IDNA normalisation; subdomains
// do NOT match unless listed, so "acme.com" does not admit "mail.acme.com".
// Addresses: exact match after lower-casing the local part and normalising the
// domain. The two lists are a UNION: a recipient passes if its domain is listed
// OR its full address is listed.

export interface RecipientDomainsObligation {
  type: "recipient_domains";
  // Argument names to read recipients from. Dotted paths ("message.to") reach
  // into nested objects.
  args: string[];
  allowedDomains: string[];
  // Exact addresses, admitted even when their domain is not listed.
  allowedAddresses?: string[];
}

export type RecipientCheck =
  | { ok: true }
  // `domains` holds only the offending domains (never full addresses), so it is
  // safe to put in the audit event and the error text the agent sees.
  | { ok: false; reason: string; domains: string[] };

export function normaliseDomain(raw: string): string {
  let d = raw.trim().toLowerCase();
  if (d.endsWith(".")) d = d.slice(0, -1);
  try {
    // URL.domainToASCII is the IDNA path available in Node and browsers.
    const ascii = new URL(`http://${d}`).hostname;
    if (ascii) d = ascii;
  } catch {
    // leave as-is; it will not match any listed domain
  }
  return d;
}

// "Bob@Acme.COM" -> "bob@acme.com". Local part lower-cased (as the hosted plane
// does), domain normalised like allowed_domains.
export function normaliseAddress(raw: string): string {
  const at = raw.lastIndexOf("@");
  if (at < 0) return raw.trim().toLowerCase();
  return raw.slice(0, at).trim().toLowerCase() + "@" + emailDomain(raw);
}

// Domain part of an address: after the LAST '@' (a quoted local part may itself
// contain '@'). "" when there is no '@'.
export function emailDomain(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return normaliseDomain(address.slice(at + 1));
}

// Split an address-list string on ',' or ';' outside double quotes and angle
// brackets, so '"Smith, Bob" <bob@acme.com>' stays one entry.
function splitAddressList(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const c of value) {
    if (c === '"' && !inAngle) inQuote = !inQuote;
    else if (c === "<" && !inQuote) inAngle = true;
    else if (c === ">" && !inQuote) inAngle = false;
    if ((c === "," || c === ";") && !inQuote && !inAngle) {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

// 'Bob <bob@acme.com>' -> 'bob@acme.com'. A bare address is returned trimmed.
function addressOf(entry: string): string {
  const m = /<([^<>]*)>\s*$/.exec(entry);
  return (m ? m[1] : entry).trim();
}

function readPath(root: unknown, path: string): unknown {
  let cur: unknown = root;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function checkRecipientDomains(args: unknown, ob: RecipientDomainsObligation): RecipientCheck {
  const addressList = ob.allowedAddresses ?? [];
  if (
    !Array.isArray(ob.args) || ob.args.length === 0 ||
    !Array.isArray(ob.allowedDomains) || !Array.isArray(addressList) ||
    ob.allowedDomains.length + addressList.length === 0
  ) {
    return { ok: false, reason: "malformed recipient_domains obligation", domains: [] };
  }
  const allowed = new Set(ob.allowedDomains.map(normaliseDomain));
  const allowedAddresses = new Set(addressList.map(normaliseAddress));

  const addresses: string[] = [];
  for (const path of ob.args) {
    const value = readPath(args, path);
    if (value === undefined || value === null) continue;
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== "string") {
        return { ok: false, reason: `recipient argument "${path}" is not a string or list of strings`, domains: [] };
      }
      for (const entry of splitAddressList(item)) addresses.push(addressOf(entry));
    }
  }

  if (addresses.length === 0) {
    return { ok: false, reason: `no recipients found in ${ob.args.map((a) => `"${a}"`).join(", ")}`, domains: [] };
  }

  const violating = new Set<string>();
  for (const address of addresses) {
    const domain = emailDomain(address);
    if (!domain) violating.add("(no domain)");
    else if (!allowed.has(domain) && !allowedAddresses.has(normaliseAddress(address))) violating.add(domain);
  }
  if (violating.size > 0) {
    const domains = [...violating].sort();
    return { ok: false, reason: `recipient domain not allowed: ${domains.join(", ")}`, domains };
  }
  return { ok: true };
}
