import assert from 'node:assert/strict';
import { __runWithIpcRequestContextForTests } from '../../electron/ipc/ipcUtils.js';
import {
  formatScrapePaceLine,
  getManualScraperTelemetry,
  notePacePanelInterrupt,
  recordManualScraperTelemetry,
  resetManualScraperTelemetry,
  resetScrapePace,
} from '../../electron/ipc/browser/manualScraper.js';
import { buildJobsPipelineSnapshot } from '../../electron/ipc/bugReport/jobsSnapshot.js';
import {
  classifyPanelWalkInterrupt,
  describePanelWalkInterrupt,
  readPanelWalkCover,
} from '../../electron/ipc/browser/panelWalkInterrupt.js';

const SOURCE = 'ziprecruiter';
const sender = { id: 71719, getURL: () => 'file:///synthetic/index.html' };
const report = () => __runWithIpcRequestContextForTests(
  { sender, nodeId: null, channel: 'bug-report' },
  () => buildJobsPipelineSnapshot(new Set(), sender.id, null, [], false, new Set(), new Set()),
);
const paceOf = (sourceId = SOURCE) => getManualScraperTelemetry().pace[sourceId];

// Mirrors production: the run-level reset, a source-start event (which is what
// makes the report render its Active Browser Scrape block at all), then the
// per-source pace reset that a source start performs.
function startPace(meta = {}) {
  resetManualScraperTelemetry();
  recordManualScraperTelemetry({ phase: 'source-start', sourceId: SOURCE, srcName: 'ZipRecruiter' });
  resetScrapePace(SOURCE, { srcName: 'ZipRecruiter', queryIndex: 1, queryTotal: 11, ...meta });
}

// Minimal stand-in for the handful of DOM methods readPanelWalkCover touches.
function fakeNode({
  tag = 'div',
  id = '',
  classes = [],
  text = '',
  attrs = {},
  rects = 1,
  position = 'static',
  parent = null,
} = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    id,
    classList: classes,
    textContent: text,
    parentElement: parent,
    style: { position },
    getClientRects: () => (rects > 0 ? [{}] : []),
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null),
    closest(selector) {
      if (selector !== '[aria-hidden="true"]') return null;
      let current = node;
      while (current) {
        if (current.getAttribute?.('aria-hidden') === 'true') return current;
        current = current.parentElement;
      }
      return null;
    },
  };
  return node;
}

function fakeRoot({ dialogs = [], frames = [], centre = null, width = 800, height = 600 } = {}) {
  return {
    querySelectorAll: (selector) => (String(selector).includes('iframe') ? frames : dialogs),
    getElementById: () => null,
    elementFromPoint: () => centre,
    defaultView: {
      innerWidth: width,
      innerHeight: height,
      getComputedStyle: (el) => ({ position: el?.style?.position || 'static' }),
    },
  };
}

export default [{
  name: 'classify names a challenge, a popup, a pinned cover, nothing, or unreadable',
  run() {
    // Nothing could be read at all — not the same as "nothing was there".
    assert.equal(classifyPanelWalkInterrupt(null), 'unknown');
    assert.equal(classifyPanelWalkInterrupt({}), 'unknown');
    assert.equal(classifyPanelWalkInterrupt({ signals: null, cover: null }), 'unknown');

    // A detected check wins even when it renders inside a dialog element: a
    // Cloudflare interstitial in a modal must not be reported as a popup.
    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: true, reason: 'cloudflare-challenge' },
      cover: { dialogs: 1, dialogText: 'Verify', checkFrames: 0, position: 'fixed' },
    }), 'check');
    // A challenge iframe with no challenge heuristics on the body text.
    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false },
      cover: { dialogs: 0, checkFrames: 2, position: 'other' },
    }), 'check');
    // Signals unavailable, but a captcha frame was visible.
    assert.equal(classifyPanelWalkInterrupt({ signals: null, cover: { dialogs: 0, checkFrames: 1 } }), 'check');

    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false },
      cover: { dialogs: 1, checkFrames: 0, position: 'other' },
    }), 'popup');
    // A popup outranks a pinned header: it is the thing that blocked the walk.
    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false },
      cover: { dialogs: 2, checkFrames: 0, position: 'fixed' },
    }), 'popup');

    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false },
      cover: { dialogs: 0, checkFrames: 0, position: 'fixed' },
    }), 'covered');
    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false },
      cover: { dialogs: 0, checkFrames: 0, position: 'sticky' },
    }), 'covered');

    assert.equal(classifyPanelWalkInterrupt({
      signals: { isChallenge: false, bodyTextLength: 900 },
      cover: { dialogs: 0, dialogText: '', checkFrames: 0, cover: 'body', position: 'other' },
    }), 'none');
  },
}, {
  name: 'describe renders one clause per verdict and names the evidence it rests on',
  run() {
    assert.equal(
      describePanelWalkInterrupt('check', {
        signals: { isChallenge: true, reason: 'cloudflare-challenge', hasCloudflareChallengeFrame: true },
        cover: { checkFrames: 1 },
      }),
      'a verification check covered the page (Cloudflare frame)',
    );
    assert.equal(
      describePanelWalkInterrupt('check', {
        signals: { isChallenge: true, reason: 'verification-text', hasCloudflareChallengeFrame: false, hasCloudflareTurnstileWidget: false, visibleRecaptchaFrames: 0, visibleHCaptchaFrames: 0, hasDataDomeFrame: false, hasPerimeterXBlock: false },
        cover: { checkFrames: 0 },
      }),
      'a verification check covered the page (verification-text)',
    );
    assert.equal(
      describePanelWalkInterrupt('check', { signals: null, cover: { checkFrames: 1 } }),
      'a verification check covered the page (verification frame)',
    );
    assert.equal(
      describePanelWalkInterrupt('popup', { cover: { dialogs: 1, dialogText: 'Sign in to continue', dialogLabel: '' } }),
      'a popup was open: "Sign in to continue"',
    );
    assert.equal(
      describePanelWalkInterrupt('popup', { cover: { dialogs: 1, dialogText: '', dialogLabel: 'Sign in' } }),
      'a popup was open: "Sign in"',
    );
    assert.equal(
      describePanelWalkInterrupt('covered', { cover: { position: 'fixed', cover: 'div#gate.overlay' } }),
      'a fixed element covered the page centre (div#gate.overlay)',
    );
    assert.equal(
      describePanelWalkInterrupt('covered', { cover: { position: 'sticky', cover: 'header#top' } }),
      'a sticky element covered the page centre (header#top)',
    );
    assert.equal(describePanelWalkInterrupt('none', {}), 'nothing unusual was on screen');
    assert.equal(describePanelWalkInterrupt('unknown', {}), 'the page could not be read');
  },
}, {
  name: 'readPanelWalkCover counts only visible dialogs and challenge frames and describes the page centre',
  run() {
    const ariaHiddenParent = fakeNode({ tag: 'div', attrs: { 'aria-hidden': 'true' } });
    const visibleDialog = fakeNode({
      tag: 'div',
      text: 'Sign in to continue '.repeat(20),
      attrs: { role: 'dialog', 'aria-label': 'Sign in to continue '.repeat(6) },
    });
    const hiddenDialog = fakeNode({ tag: 'div', rects: 0, attrs: { role: 'alertdialog' } });
    const ariaHiddenDialog = fakeNode({ tag: 'div', parent: ariaHiddenParent, attrs: { 'aria-modal': 'true' } });
    const challengeFrame = fakeNode({
      tag: 'iframe',
      attrs: { src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile' },
    });
    const hiddenChallengeFrame = fakeNode({
      tag: 'iframe',
      rects: 0,
      attrs: { src: 'https://www.google.com/recaptcha/api2/anchor?k=synthetic' },
    });
    const adFrame = fakeNode({ tag: 'iframe', attrs: { src: 'https://example.test/ad.html' } });
    const centre = fakeNode({ tag: 'div', id: 'gate', classes: ['overlay', 'scrim'], position: 'fixed' });
    const cover = readPanelWalkCover(fakeRoot({
      dialogs: [visibleDialog, hiddenDialog, ariaHiddenDialog],
      frames: [challengeFrame, hiddenChallengeFrame, adFrame],
      centre,
    }));

    // Two of the three dialogs are invisible (no layout, aria-hidden ancestor).
    assert.equal(cover.dialogs, 1);
    assert.equal(cover.dialogText.length, 120);
    assert.equal(cover.dialogText, 'Sign in to continue '.repeat(6));
    assert.equal(cover.dialogLabel.length, 80);
    assert.equal(cover.dialogLabel, 'Sign in to continue '.repeat(4));
    // Only the laid-out challenge iframe counts; the ad and the hidden one do not.
    assert.equal(cover.checkFrames, 1);
    assert.equal(cover.cover, 'div#gate.overlay');
    assert.equal(cover.position, 'fixed');

    // Nothing URL-shaped, query-shaped or value-shaped may leak out of the probe.
    const serialized = JSON.stringify(cover);
    assert.equal(serialized.includes('?'), false);
    assert.equal(serialized.includes('http'), false);
    assert.equal(serialized.includes('challenges.cloudflare.com'), false);
    assert.equal(serialized.includes('recaptcha'), false);
    assert.equal(serialized.includes('synthetic'), false);
    assert.deepEqual(Object.keys(cover).sort(), ['checkFrames', 'cover', 'dialogLabel', 'dialogText', 'dialogs', 'position']);

    // The probe's own verdict feeds the classifier: the visible challenge frame wins.
    assert.equal(classifyPanelWalkInterrupt({ signals: { isChallenge: false }, cover }), 'check');

    const plain = readPanelWalkCover(fakeRoot({
      centre: fakeNode({ tag: 'span', classes: ['sheet'], position: 'static' }),
    }));
    assert.equal(plain.dialogs, 0);
    assert.equal(plain.checkFrames, 0);
    assert.equal(plain.cover, 'span.sheet');
    assert.equal(plain.position, 'other');
    assert.equal(classifyPanelWalkInterrupt({ signals: { isChallenge: false }, cover: plain }), 'none');

    // A root that is missing everything is unreadable, never a crash.
    assert.deepEqual(readPanelWalkCover(undefined), {
      dialogs: 0, dialogText: '', dialogLabel: '', checkFrames: 0, cover: '', position: '',
    });

    // The probe must survive Puppeteer's function serialization: its source,
    // rebuilt with no module scope around it, has to produce the same reading.
    const rebuilt = new Function(`return (${readPanelWalkCover.toString()});`)();
    assert.deepEqual(rebuilt(fakeRoot({
      dialogs: [visibleDialog, hiddenDialog, ariaHiddenDialog],
      frames: [challengeFrame, hiddenChallengeFrame, adFrame],
      centre,
    })), cover);
  },
}, {
  name: 'first-of-streak interruptions are counted per verdict and printed only when non-zero',
  run() {
    startPace();
    assert.equal(formatScrapePaceLine(paceOf()).includes('panel walk interruptions'), false);

    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'check' });
    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'check' });
    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'popup' });
    // 'none' and 'unknown' are counted but never printed: nothing was wrong there.
    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'none' });
    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'not-a-verdict' });
    assert.deepEqual(paceOf().panelInterrupts, { check: 2, popup: 1, covered: 0, none: 1, unknown: 1 });

    const line = formatScrapePaceLine(paceOf());
    assert.equal(line.includes('panel walk interruptions: 2 check(s), 1 popup(s)'), true);
    assert.equal(line.includes('0 check(s)'), false);
    assert.equal(line.includes('covered'), false);
    assert.equal(line.includes('unknown'), false);

    notePacePanelInterrupt(SOURCE, { srcName: 'ZipRecruiter', verdict: 'covered' });
    assert.equal(
      formatScrapePaceLine(paceOf()).includes('panel walk interruptions: 2 check(s), 1 popup(s), 1 covered'),
      true,
    );
  },
}, {
  name: 'a panel-walk-interrupt anomaly renders verdict, failure, card, stage, dialog, cover and frames once',
  run() {
    resetManualScraperTelemetry();
    recordManualScraperTelemetry({ phase: 'source-start', sourceId: SOURCE, srcName: 'ZipRecruiter' });
    recordManualScraperTelemetry({
      phase: 'panel-walk-interrupt',
      sourceId: SOURCE,
      srcName: 'ZipRecruiter',
      itemIndex: 2,
      itemTotal: 20,
      failure: 'panel-timeout',
      stage: 'first',
      verdict: 'check',
      challengeReason: 'cloudflare-challenge',
      title: null,
      dialogText: '',
      dialogLabel: '',
      checkFrames: 1,
      cover: 'div#gate.overlay',
      coverPosition: 'fixed',
    }, { updateActive: false });
    recordManualScraperTelemetry({
      phase: 'panel-walk-interrupt',
      sourceId: SOURCE,
      srcName: 'ZipRecruiter',
      itemIndex: 19,
      itemTotal: 20,
      failure: 'click',
      stage: 'stop',
      verdict: 'popup',
      challengeReason: null,
      title: null,
      // Dialog text is untrusted page content: the report keeps its presence only.
      dialogText: 'Sign in to continue',
      dialogLabel: 'Sign in',
      checkFrames: 0,
      cover: 'div#signin',
      coverPosition: 'fixed',
    }, { updateActive: false });

    const text = report();
    assert.match(
      text,
      /- ⚠️ panel-walk-interrupt ZipRecruiter verdict=check failure=panel-timeout card=2\/20 stage=first dialog="none" cover=div#gate\.overlay checkFrames=1 -\d+s/u,
    );
    assert.match(
      text,
      /- ⚠️ panel-walk-interrupt ZipRecruiter verdict=popup failure=click card=19\/20 stage=stop dialog="recorded" cover=div#signin checkFrames=0 -\d+s/u,
    );
    // Rendered once, in the retained anomaly list — not again as a bare recent phase.
    assert.equal(text.match(/panel-walk-interrupt/gu).length, 2);
    // The interrupt formatter owns card=i/n; the generic field must not repeat it.
    assert.equal(text.match(/card=2\/20/gu).length, 1);
    assert.equal(text.includes('title=captured'), false);
  },
}];
