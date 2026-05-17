/**
 * Regressions-Guard für die Endpoint-Profile.
 *
 * Sichert die Refactor-Disziplin ab: bestehende Profile dürfen durch AP2/AP3/AP4
 * nicht verändert werden — insbesondere darf kein bestehendes Profil einen
 * Betriebskontrakt (operatingRules) tragen; der ist allein dem App-Directory-
 * Profil vorbehalten.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { getEndpointProfile, ENDPOINT_PROFILES, resolveHostConfig } from "./endpoint-profiles.js";

test("amtsschimmel-Profil unverändert", () => {
  const p = getEndpointProfile("amtsschimmel");
  assert.equal(p.contactMail, "kontakt@amtsschimmel.ai");
  assert.match(p.systemMessage, /amtsschimmel\.ai/);
  assert.equal(p.operatingRules, undefined);
});

test("brandmeister-Profil unverändert", () => {
  const p = getEndpointProfile("brandmeister");
  assert.equal(p.contactMail, "kontakt@brandmeister.ai");
  assert.equal(p.operatingRules, undefined);
});

test("all-Profil (paragrafenreiter) unverändert", () => {
  const p = getEndpointProfile("all");
  assert.equal(p.contactMail, "kontakt@paragrafenreiter.ai");
  assert.equal(p.operatingRules, undefined);
});

test("unbekannter Slug fällt auf default zurück", () => {
  const p = getEndpointProfile("gibtsnicht");
  assert.equal(p.contactMail, "info@ragsource.ai");
  assert.equal(p.operatingRules, undefined);
});

test("undefined fällt auf default zurück", () => {
  const p = getEndpointProfile(undefined);
  assert.equal(p.contactMail, "info@ragsource.ai");
});

test("bestehende Profile tragen keinen Betriebskontrakt", () => {
  for (const slug of ["amtsschimmel", "brandmeister", "all", "default"]) {
    assert.equal(
      ENDPOINT_PROFILES[slug].operatingRules,
      undefined,
      `Profil '${slug}' darf keine operatingRules tragen`,
    );
  }
});

test("App-Profile tragen Betriebskontrakt und Picker-Branding", () => {
  for (const slug of ["amtsschimmel-app", "brandmeister-app", "paragrafenreiter-app"]) {
    const p = ENDPOINT_PROFILES[slug];
    assert.ok(p, `Profil '${slug}' fehlt`);
    assert.ok(p.operatingRules && p.operatingRules.length > 0, `${slug}: operatingRules fehlt`);
    assert.ok(p.pickerBranding, `${slug}: pickerBranding fehlt`);
    assert.ok(p.pickerBranding.name.length > 0 && p.pickerBranding.accent.startsWith("#"));
  }
});

test("resolveHostConfig — App-Hosts: Marken-Tenancy, eigenes App-Profil", () => {
  assert.deepEqual(resolveHostConfig("app.amtsschimmel.ai"), { tenancy: "amtsschimmel", profile: "amtsschimmel-app" });
  assert.deepEqual(resolveHostConfig("app.brandmeister.ai"), { tenancy: "brandmeister", profile: "brandmeister-app" });
  assert.deepEqual(resolveHostConfig("app.paragrafenreiter.ai"), { tenancy: "all", profile: "paragrafenreiter-app" });
});

test("resolveHostConfig — Bestands-Hosts unverändert, unbekannter Host undefined", () => {
  assert.deepEqual(resolveHostConfig("mcp.amtsschimmel.ai"), { tenancy: "amtsschimmel", profile: "amtsschimmel" });
  assert.deepEqual(resolveHostConfig("mcp.brandmeister.ai"), { tenancy: "brandmeister", profile: "brandmeister" });
  assert.equal(resolveHostConfig("example.com"), undefined);
});
