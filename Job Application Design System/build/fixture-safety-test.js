/* ============================================================
   build/fixture-safety-test.js — authoring-fixture provenance gate
   ----------------------------------------------------------
   Handoff and upload examples are committed developer references, not
   private application archives. Keep one explicit synthetic identity
   across both HTML copies, and keep the application-sync shape without
   retaining a usable endpoint or bearer capability.
   ============================================================ */

'use strict';

var fs = require('fs');
var path = require('path');
var H = require('./harness.js');
var header = H.header, assert = H.assert;
var DIM = H.DIM, RESET = H.RESET;

var ROOT = path.join(__dirname, '..');
var FIXTURES = [
  'uploads/Application.html',
  'handoff/Application-paginated-example.html'
];
var SYNTHETIC = {
  name: 'Jordan Lee',
  email: 'jordan.lee@example.test',
  telephoneHref: 'tel:+12025550147',
  telephoneText: '(202) 555-0147',
  token: 'INERT_FIXTURE_TOKEN'
};

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function bundleData(html) {
  var match = /<script\b[^>]*id="ic-application-bundle-data"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!match) return null;
  try { return JSON.parse(match[1]); } catch { return null; }
}

header(DIM + 'fixture safety' + RESET);

FIXTURES.forEach(function (rel) {
  var html = read(rel);
  var payload = bundleData(html);
  var emails = html.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  var telHrefs = html.match(/tel:[^"'\s<]+/gi) || [];

  assert(emails.length > 0 && emails.every(function (email) {
    return email.toLowerCase() === SYNTHETIC.email;
  }), rel + ' contains only the reserved synthetic email', emails.join(', '));
  assert(telHrefs.length > 0 && telHrefs.every(function (href) {
    return href === SYNTHETIC.telephoneHref;
  }), rel + ' contains only the synthetic telephone link', telHrefs.join(', '));
  assert(html.indexOf(SYNTHETIC.telephoneText) !== -1,
    rel + ' renders the synthetic telephone number');
  assert((html.match(new RegExp(SYNTHETIC.name, 'g')) || []).length >= 3,
    rel + ' uses the synthetic identity in résumé, letter, and metadata');
  assert(!!payload, rel + ' carries parseable application bundle metadata');
  if (payload) {
    assert(payload.candidateName === SYNTHETIC.name,
      rel + ' metadata names the synthetic candidate');
    assert(payload.sync && payload.sync.endpoint === '',
      rel + ' application-sync endpoint is deliberately disabled');
    assert(payload.sync && payload.sync.token === SYNTHETIC.token,
      rel + ' keeps only the visibly inert fixture token');
  }
  assert(!/"token"\s*:\s*"[a-f0-9]{32,}"/i.test(html),
    rel + ' contains no production-looking hex bearer token');
});

assert(!fs.existsSync(path.join(ROOT, 'uploads', 'Resume.pdf')),
  'uploads/ contains no private candidate résumé PDF');

H.report();
