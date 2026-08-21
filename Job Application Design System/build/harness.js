/* ============================================================
   build/harness.js — the assertion harness every Node test in this
   folder shares.
   ----------------------------------------------------------
   This block used to be copy-pasted, byte-identical, into each test
   file (colour codes, counters, ok/fail/header/assert, the report +
   exit footer). One copy now: a change to the report format, the exit
   contract, or the failure summary lands in every suite at once.

   Usage:
     var H = require('./harness.js');
     var ok = H.ok, fail = H.fail, header = H.header, assert = H.assert;
     var GREEN = H.GREEN, RED = H.RED, DIM = H.DIM, RESET = H.RESET;
     ... assertions ...
     H.report();          // prints the summary, exits 1 if anything failed
   ============================================================ */

'use strict';

var GREEN = '\x1b[32m', RED = '\x1b[31m', DIM = '\x1b[2m', RESET = '\x1b[0m';
var passed = 0, failed = 0, failures = [];

function ok(name)      { console.log('  ' + GREEN + '\u2713' + RESET + ' ' + name); passed++; }
function fail(name, m) { console.log('  ' + RED + '\u2717' + RESET + ' ' + name + ' \u2014 ' + (m || 'assertion failed')); failed++; failures.push(name); }
function header(s)     { console.log('\n' + s); }
function assert(cond, name, msg) { if (cond) ok(name); else fail(name, msg); }

/* Counts, for a suite that needs to branch on them. */
function counts() { return { passed: passed, failed: failed, failures: failures.slice() }; }

/* The footer every suite ends with. Exits 1 on any failure so the npm
   test chain stops at the first broken gate. */
function report() {
  console.log('\n' + (failed === 0 ? GREEN : RED) + passed + ' passed, ' + failed + ' failed' + RESET);
  if (failed > 0) {
    console.log(RED + 'Failures: ' + failures.join(', ') + RESET);
    process.exit(1);
  }
}

module.exports = {
  ok: ok, fail: fail, header: header, assert: assert,
  counts: counts, report: report,
  GREEN: GREEN, RED: RED, DIM: DIM, RESET: RESET
};
