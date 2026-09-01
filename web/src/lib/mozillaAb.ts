import type { ContactCard, JSContactAddress, JSContactAddressComponent } from "@/jmap/types";
import { buildName, newKey } from "@/lib/contacts";
import type { LdifRecord } from "@/lib/ldif";

/**
 * Mozilla's LDAP address book schema, turned into a contact card.
 *
 * LDIF is only a syntax: it says how to write `name: value` and nothing about
 * what any name means, so an address book in it is only readable against a
 * schema. There are as many schemas as there are directories, and this handles
 * one -- [Mozilla's][1], which Thunderbird, SOGo and most things that export
 * "an address book as LDIF" write, and which issue #174 asks for by name.
 * Attributes outside it are left where they are rather than guessed at.
 *
 * [1]: https://wiki.mozilla.org/MailNews:Mozilla_LDAP_Address_Book_Schema
 */

/** The work and home address, which the schema keeps in two separate sets of attributes. */
const ADDRESSES: { context: "work" | "private"; parts: Array<[kind: string, attr: string]> }[] = [
  {
    context: "work",
    parts: [
      // Street lines land in one `name` component, which is where the contact
      // editor puts a street and so where it looks for one.
      ["name", "street"],
      ["name", "mozillaworkstreet2"],
      ["postOfficeBox", "postofficebox"],
      ["locality", "l"],
      ["region", "st"],
      ["postcode", "postalcode"],
      ["country", "c"],
    ],
  },
  {
    context: "private",
    parts: [
      ["name", "mozillahomestreet"],
      ["name", "mozillahomestreet2"],
      ["locality", "mozillahomelocalityname"],
      ["region", "mozillahomestate"],
      ["postcode", "mozillahomepostalcode"],
      ["country", "mozillahomecountryname"],
    ],
  },
];

/** Every phone attribute, and what kind of phone it is. */
const PHONES: Array<{ attr: string; features?: Record<string, boolean>; contexts?: Record<string, boolean> }> = [
  { attr: "telephonenumber", contexts: { work: true } },
  { attr: "homephone", contexts: { private: true } },
  { attr: "mobile", features: { mobile: true } },
  { attr: "facsimiletelephonenumber", features: { fax: true } },
  { attr: "pager", features: { pager: true } },
];

function address(rec: LdifRecord, spec: (typeof ADDRESSES)[number]): JSContactAddress | null {
  const components: JSContactAddressComponent[] = [];
  for (const [kind, attr] of spec.parts) {
    for (const value of rec.attrs[attr] ?? []) {
      if (value.trim()) components.push({ "@type": "AddressComponent", kind, value: value.trim() });
    }
  }
  if (!components.length) return null;
  return { "@type": "Address", components, contexts: { [spec.context]: true } };
}

/**
 * One entry as a card, or `null` when there is not enough of it to be a person.
 *
 * An entry with neither a name nor an address to reach it by would import as a
 * blank row: present in the list, impossible to identify, and tedious to find
 * again to delete. Better not to make it.
 */
export function cardFromLdif(rec: LdifRecord): Partial<ContactCard> | null {
  const first = (attr: string) => rec.attrs[attr]?.[0]?.trim() ?? "";
  const all = (attr: string) => (rec.attrs[attr] ?? []).map((v) => v.trim()).filter(Boolean);

  const given = first("givenname");
  const surname = first("sn");
  const full = first("displayname") || first("cn");
  const emails = [...all("mail"), ...all("mozillasecondemail")];
  if (!given && !surname && !full && !emails.length) return null;

  const card: Partial<ContactCard> = { kind: "individual" };

  // `cn` is the name as the directory renders it, which is not always the parts
  // put back together -- "Doe, Jane", or a name with no surname attribute at
  // all. Keep it as the full name when it disagrees, so the card reads the way
  // the export did.
  const name = buildName({ given, surname });
  if (name) card.name = full && full !== name.full ? { ...name, full } : name;
  else if (full) card.name = { "@type": "Name", full };

  const nickname = first("mozillanickname");
  if (nickname) card.nicknames = { [newKey("n")]: { "@type": "Nickname", name: nickname } };

  const org = first("o");
  const units = all("ou");
  if (org || units.length) {
    card.organizations = {
      [newKey("o")]: {
        "@type": "Organization",
        ...(org ? { name: org } : {}),
        ...(units.length ? { units: units.map((name) => ({ "@type": "OrgUnit" as const, name })) } : {}),
      },
    };
  }

  const title = first("title");
  if (title) card.titles = { [newKey("t")]: { "@type": "Title", name: title, kind: "title" } };

  if (emails.length) {
    card.emails = {};
    emails.forEach((address, i) => {
      // The first is `mail`, which the schema means as the address to use.
      card.emails![newKey("e")] = { "@type": "EmailAddress", address, ...(i === 0 ? { pref: 1 } : {}) };
    });
  }

  const phones: NonNullable<ContactCard["phones"]> = {};
  for (const spec of PHONES) {
    for (const number of all(spec.attr)) {
      phones[newKey("p")] = { "@type": "Phone", number, ...(spec.features ? { features: spec.features } : {}), ...(spec.contexts ? { contexts: spec.contexts } : {}) };
    }
  }
  if (Object.keys(phones).length) card.phones = phones;

  const addresses: NonNullable<ContactCard["addresses"]> = {};
  for (const spec of ADDRESSES) {
    const a = address(rec, spec);
    if (a) addresses[newKey("a")] = a;
  }
  if (Object.keys(addresses).length) card.addresses = addresses;

  const links: NonNullable<ContactCard["links"]> = {};
  for (const uri of [...all("mozillaworkurl"), ...all("mozillahomeurl")]) {
    links[newKey("l")] = { "@type": "Link", uri };
  }
  if (Object.keys(links).length) card.links = links;

  const aim = first("nsaimid");
  if (aim) card.onlineServices = { [newKey("s")]: { "@type": "OnlineService", service: "AIM", user: aim } };

  /*
   * The four custom fields have nowhere of their own to go: JSContact has no
   * equivalent, and the schema does not say what they hold -- they are whatever
   * their owner decided. Appending them to the note keeps them, labelled the
   * way Thunderbird labels them, which is worth more than the tidiness of
   * dropping something somebody chose to write down.
   */
  const notes = all("description");
  [1, 2, 3, 4].forEach((n) => {
    for (const value of all(`mozillacustom${n}`)) notes.push(`Custom ${n}: ${value}`);
  });
  if (notes.length) card.notes = { [newKey("x")]: { "@type": "Note", note: notes.join("\n") } };

  return card;
}
