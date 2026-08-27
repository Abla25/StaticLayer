# StaticLayer — Privacy Policy Template

> Template for the privacy policy of a website using StaticLayer. The system is
> BYOC (Bring Your Own Cloud): **all comment data lives exclusively in your
> Cloudflare account** (Worker + D1 database). No data passes through or is
> stored by StaticLayer (the software provider).

---

## 1. Who processes the data

Comments published on this site are handled **entirely by the site owner**
through their own Cloudflare account. StaticLayer only provides the software
(a Worker running on Cloudflare infrastructure chosen by the owner) and does
not collect, store or process any personal data.

## 2. Data collected and purposes

- **Nickname** and **comment text** (plain text, no HTML/Markdown): displayed
  publicly under the article and stored in the owner's D1 database for
  moderation and publication.
- **Article path** and domain: used to associate comments with the correct page.
- **No application-level IP persistence:** the application does **not** store
  the visitor's IP address in its database, nor does it collect browser
  fingerprints, tracking cookies, geolocation data or visitor session
  identifiers. The public widget sets no cookies and uses no
  `localStorage`/`sessionStorage`.
- Transparency note: Cloudflare's network infrastructure (data processor for
  hosting) handles network metadata — including the visitor's IP — solely for
  routing and connection security, under Cloudflare's terms of service. That
  metadata is not used by the StaticLayer software and is never written to the
  application database.

## 3. Legal basis

- Consent of the user (voluntary publication of the comment with a nickname).
- Legitimate interest of the owner in moderating and preventing spam/abuse
  (client-side proof-of-work and rate limiting).

## 4. Retention

- Comments remain in the D1 database until the owner deletes them.
- Anti-replay challenge identifiers are automatically deleted every 24 hours.

## 5. Data sharing

- **Cloudflare** acts as **data processor** for hosting the Worker and the
  database, exclusively on the owner's instructions, under
  [Cloudflare's terms of service](https://www.cloudflare.com/terms/).
- **StaticLayer** (the software provider) receives no data: the runtime makes
  no calls to StaticLayer servers.

## 6. User rights

Users may ask the owner for access, rectification or deletion of their comment
at any time (e.g. by writing to the site's contact address).

## 7. Contact

Data controller: [NAME / LEGAL ENTITY] — [CONTACT EMAIL] — [ADDRESS / PEC].
