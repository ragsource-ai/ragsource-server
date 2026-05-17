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
import { getEndpointProfile, ENDPOINT_PROFILES } from "./endpoint-profiles.js";

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
