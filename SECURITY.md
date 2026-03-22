# Sicherheitsrichtlinie / Security Policy

## Unterstützte Versionen / Supported Versions

| Version | Unterstützt / Supported |
|---------|------------------------|
| `main` (aktuell / latest) | ✅ |
| ältere Branches / older branches | ❌ |

---

## Sicherheitslücke melden / Reporting a Vulnerability

**Bitte melde Sicherheitslücken NICHT als öffentliches GitHub Issue.**
**Please do NOT report security vulnerabilities as a public GitHub issue.**

### DE

Sende eine E-Mail an **security@amtsschimmel.ai** mit:

- Beschreibung der Schwachstelle
- Schritt-für-Schritt-Reproduktion (falls möglich)
- Betroffene Version / betroffener Endpunkt
- Geschätzter Schweregrad (niedrig / mittel / hoch / kritisch)

Wir bestätigen den Eingang innerhalb von **48 Stunden** und melden uns mit einem voraussichtlichen Zeitplan zur Behebung.

### EN

Send an email to **security@amtsschimmel.ai** with:

- Description of the vulnerability
- Step-by-step reproduction (if possible)
- Affected version / endpoint
- Estimated severity (low / medium / high / critical)

We will acknowledge receipt within **48 hours** and follow up with an expected remediation timeline.

---

## Geltungsbereich / Scope

**Im Scope / In scope:**
- `ragsource-api-v2.ragsource.workers.dev` — öffentlicher MCP-Endpunkt
- `mcp.amtsschimmel.ai` — öffentlicher MCP-Endpunkt
- Gesamter Code in diesem Repository

**Außerhalb des Scope / Out of scope:**
- Drittanbieter-Dienste (Cloudflare, GitHub)
- Denial-of-Service-Angriffe (kein Rate-Limiting-SLA)
- Inhalte aus `ragsource-content` (öffentliche Rechtstexte, kein Angriffspotenzial)

---

## Offenlegungsrichtlinie / Disclosure Policy

Wir folgen dem Prinzip der **koordinierten Offenlegung**: Wir bitten um eine angemessene Sperrfrist (max. 90 Tage) vor öffentlicher Bekanntgabe, um die Schwachstelle beheben und deployen zu können.

We follow **coordinated disclosure**: we ask for a reasonable embargo (max. 90 days) before public disclosure, to give us time to fix and deploy.
