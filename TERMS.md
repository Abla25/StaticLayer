# StaticLayer — Terms of Use, Disclaimer & Liability

**Effective date:** 2026-08-27 · **Applies to:** the StaticLayer software
(code, widgets, installer, CLI, documentation, and the hosted installer at
`*.workers.dev`).

> **Short version:** StaticLayer is provided **"AS IS"** and **"as available"**,
> with **no warranty and no liability** of any kind. You operate everything on
> **your own Cloudflare account** (BYOC — bring your own Cloudflare). You are
> responsible for your content, your moderation, your infrastructure, your
> security configuration and your legal compliance. Nothing here is legal
> advice — for binding terms, consult a qualified professional.

---

## 1. License

The software is licensed under the **Elastic License 2.0** (see `LICENSE`).
You may read, modify and self-host it. You may **not** resell it or offer it
to third parties as a hosted/managed service. Commercial licenses may be
granted separately by the copyright holder.

## 2. Bring Your Own Cloudflare (BYOC)

StaticLayer is a **self-hosted tool**: the runtime (Worker + D1) is deployed
into **your** Cloudflare account, on **your** infrastructure, under **your**
credentials. StaticLayer (the project) does not host, store, transmit or
process your data or your visitors' data. There is **no** centralized comment
database.

## 3. No Warranty

THE SOFTWARE IS PROVIDED **"AS IS"**, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, ACCURACY, COMPLETENESS, SECURITY AND
NONINFRINGEMENT. The software may contain defects, may not meet your
requirements, and may not operate uninterrupted or error-free.

## 4. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL THE
AUTHORS, COPYRIGHT HOLDERS, CONTRIBUTORS OR ANY RELATED PARTY BE LIABLE FOR
ANY CLAIM, DAMAGES OR OTHER LIABILITY (WHETHER IN AN ACTION OF CONTRACT, TORT
OR OTHERWISE) ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR ITS
USE, INCLUDING WITHOUT LIMITATION: DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
CONSEQUENTIAL OR PUNITIVE DAMAGES; LOSS OF DATA, COMMENTS, REVENUE, PROFITS,
BUSINESS OR GOODWILL; SERVICE INTERRUPTION; UNAUTHORIZED ACCESS; OR DAMAGES
RESULTING FROM THE ACTIONS OF THIRD PARTIES.

**Specifically, StaticLayer is not liable for:**
- loss of comments, reactions, or other data stored in **your** D1 database;
- downtime or data loss caused by **your** Cloudflare account, limits, or
  configuration;
- content posted on **your** site by visitors, whether moderated or not;
- abuse, spam, hacking, or unauthorized access to **your** deployment;
- the availability, security or policies of Cloudflare or any third party.

## 5. Your Responsibilities

You agree that you are solely responsible for:

1. **Content:** everything published through your deployment, including
   visitor comments and reactions. You operate the moderation tools provided;
   they do not make you immune to liability for content you choose to publish.
2. **Moderation:** approving, rejecting or deleting comments as required by
   law, by your own policies, or by common sense. StaticLayer provides tools —
   you make the decisions.
3. **Security configuration:** setting strong secrets (`ADMIN_SECRET`,
   `SESSION_SECRET`, `POW_SECRET`), restricting `ALLOWED_ORIGINS`, keeping the
   admin URL protected, and rotating credentials when needed.
4. **Infrastructure:** your Cloudflare account, billing, quotas, limits,
   domain configuration and Workers Routes.
5. **Compliance:** ensuring your use of the software complies with all
   applicable laws and regulations in your jurisdiction (data protection,
   privacy, e-commerce, accessibility, etc.). StaticLayer is designed to
   minimize data processing, but that does **not** automatically make your
   deployment compliant.

## 6. Third-Party Services

StaticLayer runs on Cloudflare Workers, D1 and edge infrastructure. Cloudflare
is an independent third party with its own terms, privacy policy and service
limits. StaticLayer has no control over, and accepts no responsibility for,
Cloudflare's availability, performance, security, or its handling of
connection metadata (such as IP addresses at the network layer). Your use of
Cloudflare is governed by Cloudflare's own terms.

## 7. No Service-Level Agreement

StaticLayer is provided **without any SLA**. There is no guarantee of
availability, uptime, response time, or data durability. Deployments are
operated by you; you accept the risk of interruptions.

## 8. No Endorsement or Affiliation

StaticLayer is an independent project and is **not affiliated with,
endorsed by, or sponsored by** Cloudflare. "Cloudflare" is a trademark of its
respective owner and is used only to describe the target platform.

## 9. Future of the Project

The project may change licensing, features, availability or direction at any
time, for any reason (including closing the source of future releases or
offering paid licenses). This does not affect your right to keep using and
self-hosting the version you already have, subject to the license terms.

## 10. Changes to These Terms

These terms may be updated from time to time. Continued use of the software
after changes constitutes acceptance of the updated terms.

## 11. Governing Law

These terms are governed by the laws of the jurisdiction of the copyright
holder, without regard to conflict-of-law rules. Any disputes shall be subject
to the exclusive jurisdiction of the competent courts of that jurisdiction.

## 12. Legal Notice

This document is a **general template**, not legal advice. Licensing, liability
and compliance requirements vary by jurisdiction and by use case. If you need
terms that are binding and tailored to your situation, consult a qualified
legal professional.
