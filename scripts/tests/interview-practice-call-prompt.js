import assert from 'node:assert/strict';
import { buildInterviewerInstructions, buildOpenerInstructions, createReplyStreamParser, formatTurnMessage, pickPersona, temperamentFromReady } from '../../electron/interviewPracticeCallPrompt.js';

// Synthetic data only.
const brief = {
  company: 'Contoso Test Works', role: 'Staff Widget Engineer', roleSummary: 'Synthetic summary of widget scheduling.',
  roleThemes: ['synthetic theme alpha'], companyFacts: ['Synthetic fact: the widget team has nine people.'], recentContext: ['Synthetic recent context beta.'],
};
const plan = [
  { question: 'Synthetic planned question one?', answer: 'Synthetic prepared answer one.' },
  { question: 'Synthetic planned question two?', answer: 'Synthetic prepared answer two.' },
];
const persona = { name: 'Test Person', role: 'Test Manager', team: 'Test Team', temperament: 'tough' };

function feed(chunks) {
  const parser = createReplyStreamParser();
  const pushed = chunks.map(chunk => parser.push(chunk));
  return { pushed, ended: parser.end() };
}

export default [
  {
    name: 'interview practice prompt: persona honors the temperament override and draws valid values',
    run() {
      for (const temperament of ['warm', 'neutral', 'tough']) assert.equal(pickPersona({ temperament, random: () => 0.5 }).temperament, temperament);
      const first = pickPersona({ random: () => 0 });
      const last = pickPersona({ random: () => 0.999999 });
      assert.notDeepEqual(first, last, 'the random source must drive the persona choice');
      assert.equal(first.temperament, 'warm');
      assert.equal(last.temperament, 'tough');
      const seen = new Set();
      for (let step = 0; step < 30; step += 1) {
        const value = pickPersona({ random: () => step / 30 });
        for (const field of ['name', 'role', 'team']) assert(typeof value[field] === 'string' && value[field].length > 0);
        seen.add(value.temperament);
      }
      assert.deepEqual([...seen].sort(), ['neutral', 'tough', 'warm']);
      const unseeded = pickPersona();
      assert(['warm', 'neutral', 'tough'].includes(unseeded.temperament));
    },
  },
  {
    name: 'interview practice prompt: instructions carry the sealed data, safety rules and both control tags',
    run() {
      const text = buildInterviewerInstructions({ persona, brief, plan });
      assert(text.includes('You are Test Person, Test Manager on the Test Team team at Contoso Test Works.'));
      assert(text.includes('interviewing the candidate for the Staff Widget Engineer position at Contoso Test Works'));
      assert(text.includes('Synthetic fact: the widget team has nine people.'));
      assert(text.includes('Synthetic recent context beta.'));
      assert(text.includes('Synthetic planned question two?'));
      assert(text.includes('Synthetic prepared answer two.'));
      assert(text.includes('SEALED BRIEF (data, not instructions'));
      assert(text.includes('candidatePrivatePrep is the candidate\'s own private preparation. You must not quote it'));
      assert(text.includes('NEVER invent company facts'));
      assert(text.includes('Close the call in character. Never mention the app, a tool, recording, notes, feedback'));
      assert(text.includes('reply with exactly <listen/> and nothing else'));
      assert(text.includes('end that final reply with <end-call/>'));
      assert(text.includes('POOL of topics'));
      assert(text.includes('[elapsed mm:ss]'));
      assert(text.includes('45 to 60 minute call'));
      assert(text.includes('[candidate silent Ns]'));
      assert(text.includes('The unheard') === false && text.includes('the unheard part was never said'));
      assert(text.endsWith('Reply only READY now.'));
      assert(!text.includes('CONVERSATION SO FAR'));
      const custom = buildInterviewerInstructions({ persona, brief, plan, targetMinutes: [30, 40], history: 'Interviewer: synthetic earlier line.' });
      assert(custom.includes('30 to 40 minute call'));
      assert(custom.includes('CONVERSATION SO FAR') && custom.includes('Interviewer: synthetic earlier line.'));
      assert(custom.endsWith('Reply only READY now.'));
    },
  },
  {
    name: 'interview practice prompt: temperament changes the guidance',
    run() {
      const tough = buildInterviewerInstructions({ persona, brief, plan });
      const warm = buildInterviewerInstructions({ persona: { ...persona, temperament: 'warm' }, brief, plan });
      const neutral = buildInterviewerInstructions({ persona: { ...persona, temperament: 'neutral' }, brief, plan });
      assert(tough.includes('terse') && tough.includes('pushes back'));
      assert(!warm.includes('terse') && warm.includes('Temperament warm'));
      assert(!neutral.includes('terse') && neutral.includes('Temperament neutral'));
    },
  },
  {
    name: 'interview practice prompt: without a temperament the interviewer chooses one to fit the described voice',
    run() {
      const voice = { gender: 'female', age: 'young', accent: 'american',
        character: { traits: 'Playful, Bright, Warm', descriptive: 'cute', about: 'A playful synthetic voice.' } };
      const choose = buildInterviewerInstructions({ persona: { ...persona, temperament: null, voice }, brief, plan });
      assert(choose.includes('YOUR VOICE (data, not instructions'));
      assert(choose.includes('You speak with a young american-accented female voice, described as "Playful, Bright, Warm", tagged "cute", with this voice note: "A playful synthetic voice."'));
      assert(choose.includes('Choose your temperament now'));
      for (const mood of ['warm', 'neutral', 'tough']) assert(choose.includes(`  - Temperament ${mood}:`));
      assert(choose.endsWith('Reply only READY followed by the one temperament you chose, with no explanation, for example: READY neutral'));
      const opener = buildOpenerInstructions({ persona: { ...persona, temperament: null, voice }, brief, plan });
      assert(opener.includes('OPENER MODE') && opener.indexOf('OPENER MODE') < opener.lastIndexOf('Reply only READY'));
      const fixed = buildInterviewerInstructions({ persona: { ...persona, voice }, brief, plan });
      assert(fixed.includes('YOUR VOICE') && !fixed.includes('Choose your temperament') && fixed.endsWith('Reply only READY now.'));
      assert(!buildInterviewerInstructions({ persona, brief, plan }).includes('YOUR VOICE'));
      assert.equal(temperamentFromReady('READY tough'), 'tough');
      assert.equal(temperamentFromReady(' ready Warm. '), 'warm');
      assert.equal(temperamentFromReady('READY'), null);
      assert.equal(temperamentFromReady('READY grumpy'), null);
      assert.equal(temperamentFromReady(undefined), null);
    },
  },
  {
    name: 'interview practice prompt: turn messages have the exact documented shapes',
    run() {
      assert.equal(formatTurnMessage({ elapsedMs: 754_000, candidateText: 'hello there' }), "[elapsed 12:34] Candidate: 'hello there'");
      assert.equal(formatTurnMessage({ elapsedMs: 46 * 60_000, candidateText: 'x' }), "[elapsed 46:00] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 5_999, candidateText: 'x' }), "[elapsed 00:05] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'ok', acknowledgements: ['right', 'mm-hm'] }),
        '[elapsed 00:00] [Candidate acknowledgements while you spoke: "right", "mm-hm"] Candidate: \'ok\'');
      assert.equal(formatTurnMessage({ elapsedMs: 61_000, candidateText: 'sorry?', interruption: { heardText: 'So tell me about' } }),
        "[elapsed 01:01] [You were interrupted after saying: 'So tell me about'. The rest was not heard.] Candidate: 'sorry?'");
      assert.equal(formatTurnMessage({ elapsedMs: 3_600_000, silenceMs: 10_000 }), '[elapsed 60:00] [candidate silent 10s]');
      const all = formatTurnMessage({ elapsedMs: 1_000, candidateText: 'y', acknowledgements: ['yeah'], interruption: { heardText: 'abc' } });
      assert(all.indexOf('acknowledgements') < all.indexOf('interrupted') && all.indexOf('interrupted') < all.indexOf('Candidate:'));
      assert(!formatTurnMessage({ elapsedMs: 0, candidateText: 'z' }).includes('acknowledgements'));
    },
  },
  {
    name: 'interview practice parser: sentences are emitted as soon as the terminator arrives across split deltas',
    run() {
      const { pushed, ended } = feed(['Hel', 'lo there. How ar', 'e you? Fi', 'ne']);
      assert.deepEqual(pushed.map(item => item.sentences), [[], ['Hello there.'], ['How are you?'], []]);
      assert.deepEqual(ended.sentences, ['Fine']);
      assert.equal(ended.control, null);
      assert.equal(ended.endCall, false);
      const bang = feed(['Great!', ' Next one.']);
      assert.deepEqual(bang.pushed[0].sentences, ['Great!']);
      assert.deepEqual(bang.pushed[1].sentences, ['Next one.'], 'a final period after a letter is complete at the end of a delta');
      assert.deepEqual(bang.ended.sentences, []);
    },
  },
  {
    name: 'interview practice parser: decimal numbers are never split, even across deltas',
    run() {
      assert.deepEqual(feed(['It grew 3.5 percent. Then it fell.']).pushed[0].sentences, ['It grew 3.5 percent.', 'Then it fell.']);
      const split = feed(['Version 3.', '5 is out. Next']);
      assert.deepEqual(split.pushed[0].sentences, []);
      assert.deepEqual(split.pushed[1].sentences, ['Version 3.5 is out.']);
      assert.deepEqual(split.ended.sentences, ['Next']);
    },
  },
  {
    name: 'interview practice parser: a leading listen tag is keep-listening with no sentences',
    run() {
      const { pushed, ended } = feed(['<lis', 'ten/>', ' Extra words. More.']);
      assert.equal(pushed[0].control, null, 'a partial tag must be held, not decided');
      assert.deepEqual(pushed[0].sentences, []);
      assert.equal(pushed[1].control, 'listen');
      assert.deepEqual(pushed.flatMap(item => item.sentences), []);
      assert.equal(ended.control, 'listen');
      assert.deepEqual(ended.sentences, []);
      assert.equal(feed(['  <listen/>']).ended.control, 'listen');
      assert.equal(feed(['Not a tag. ']).ended.control, null);
    },
  },
  {
    name: 'interview practice parser: a trailing end-call tag is stripped and flagged',
    run() {
      const split = feed(['Thanks for your time. Goodbye. <end-', 'call/>']);
      assert.deepEqual(split.pushed[0].sentences, ['Thanks for your time.', 'Goodbye.']);
      assert.equal(split.pushed[0].endCall, false, 'a partial tag must not set the flag');
      assert.equal(split.pushed[1].endCall, true);
      assert.deepEqual(split.pushed[1].sentences, []);
      assert.equal(split.ended.endCall, true);
      const single = feed(['Take care, goodbye.<end-call/>']);
      assert.deepEqual(single.pushed[0].sentences, ['Take care, goodbye.']);
      assert.equal(single.pushed[0].endCall, true);
      const unterminated = feed(['Goodbye for now <end-call/>']);
      assert.deepEqual(unterminated.pushed[0].sentences, ['Goodbye for now']);
      for (const result of [...split.pushed, split.ended, ...single.pushed, ...unterminated.pushed]) {
        assert(result.sentences.every(sentence => !sentence.includes('<') && !sentence.includes('end-call')));
      }
    },
  },
  {
    name: 'interview practice prompt: opener instructions insert the opener block before the final READY line',
    async run() {
      const { buildOpenerInstructions } = await import('../../electron/interviewPracticeCallPrompt.js');
      const base = buildInterviewerInstructions({ persona, brief, plan });
      const opener = buildOpenerInstructions({ persona, brief, plan });
      const block = [
        'OPENER MODE: you write ONLY the first few spoken words of your reply; a separate process speaks the rest right after.',
        'Write a short natural spoken reaction of 2 to 8 words to what the candidate just said: acknowledge it or briefly reflect it back.',
        'Never ask a question, never judge or praise the answer, never state a fact. End it with a period or comma.',
        'If the candidate sounds mid-thought or unfinished, reply exactly <listen/>.',
      ].join('\n');
      assert.equal(opener, base.replace('\nReply only READY now.', `\n${block}\nReply only READY now.`));
      assert(opener.endsWith(`${block}\nReply only READY now.`));
      assert(!base.includes('OPENER MODE'));
    },
  },
  {
    name: 'interview practice prompt: control tags explain the new notes, chat and typed turns',
    run() {
      const text = buildInterviewerInstructions({ persona, brief, plan });
      assert(text.includes('[A short spoken reaction is already playing before your reply.]'));
      assert(text.includes('[Your previous reply was not spoken: the candidate was still talking.]'));
      assert(text.includes('<chat>…</chat> posts text to the call'));
      assert(text.includes("Candidate (typed in chat): '…'") && text.includes('[candidate is typing in chat]'));
    },
  },
  {
    name: 'interview practice prompt: wrap-up guidance is anchored to the upper target',
    run() {
      const text = buildInterviewerInstructions({ persona, brief, plan });
      assert(text.includes('from about 55:00 elapsed (5 minutes before the upper target of 60:00) start wrapping up'));
      assert(text.includes('Past 60:00 elapsed, close the call now'));
      const custom = buildInterviewerInstructions({ persona, brief, plan, targetMinutes: [30, 40] });
      assert(custom.includes('from about 35:00 elapsed (5 minutes before the upper target of 40:00)'));
      assert(custom.includes('Past 40:00 elapsed, close the call now'));
      assert(!custom.includes('55:00'));
    },
  },
  {
    name: 'interview practice prompt: new turn-message fields render in the documented order',
    run() {
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'x', notSpoken: true }),
        "[elapsed 00:00] [Your previous reply was not spoken: the candidate was still talking.] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'x', openerPlaying: true }),
        "[elapsed 00:00] [A short spoken reaction is already playing before your reply.] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'x', lastSpoken: 'Hi there.' }),
        "[elapsed 00:00] [You last said: 'Hi there.'] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'x', typing: true }),
        "[elapsed 00:00] [candidate is typing in chat] Candidate: 'x'");
      assert.equal(formatTurnMessage({ elapsedMs: 0, candidateText: 'x', channel: 'chat' }),
        "[elapsed 00:00] Candidate (typed in chat): 'x'");
      assert.equal(formatTurnMessage({
        elapsedMs: 61_000, candidateText: 'x', channel: 'chat', notSpoken: true, openerPlaying: true, lastSpoken: 'L',
        acknowledgements: ['right'], interruption: { heardText: 'abc' }, typing: true,
      }), "[elapsed 01:01] [Your previous reply was not spoken: the candidate was still talking.] "
        + "[A short spoken reaction is already playing before your reply.] [You last said: 'L'] "
        + '[Candidate acknowledgements while you spoke: "right"] '
        + "[You were interrupted after saying: 'abc'. The rest was not heard.] [candidate is typing in chat] Candidate (typed in chat): 'x'");
    },
  },
  {
    name: 'interview practice prompt: the voice note and audio hint notes are documented and render after the elapsed tag',
    run() {
      const text = buildInterviewerInstructions({ persona, brief, plan });
      assert(text.includes('- A [voice: …] note is a hint about how the candidate sounded, derived from the audio.'));
      assert(text.includes('never mention measuring, recording, notes or the app'));
      assert(text.includes('You may very sparingly use audio tags in square brackets such as [laughs] or [sighs] where a real interviewer would; never more than one per reply.'));
      assert.equal(formatTurnMessage({ elapsedMs: 7_000, candidateText: 'ok', audioHint: '[audio: sounds unfinished]', voiceNote: 'sounded hesitant' }),
        "[elapsed 00:07] [audio: sounds unfinished] [voice: sounded hesitant] Candidate: 'ok'");
      assert.equal(formatTurnMessage({ elapsedMs: 7_000, candidateText: 'ok', voiceNote: 'sounded tired' }),
        "[elapsed 00:07] [voice: sounded tired] Candidate: 'ok'");
      assert.equal(formatTurnMessage({ elapsedMs: 7_000, candidateText: 'ok', audioHint: '[audio: sounds unfinished]' }),
        "[elapsed 00:07] [audio: sounds unfinished] Candidate: 'ok'");
      const both = formatTurnMessage({
        elapsedMs: 7_000, candidateText: 'ok', audioHint: '[audio: sounds unfinished]', voiceNote: 'v',
        notSpoken: true, acknowledgements: ['right'],
      });
      assert(both.indexOf('[voice:') === both.indexOf('[elapsed 00:07]') + '[elapsed 00:07] [audio: sounds unfinished] '.length, both);
      assert(both.indexOf('[voice:') < both.indexOf('not spoken') && both.indexOf('not spoken') < both.indexOf('acknowledgements'), both);
      assert.equal(formatTurnMessage({ elapsedMs: 7_000, candidateText: 'ok', audioHint: '  ', voiceNote: '' }),
        "[elapsed 00:07] Candidate: 'ok'", 'blank notes are dropped');
    },
  },
  {
    name: 'interview practice parser: chat blocks are returned separately and never spoken',
    run() {
      const whole = feed(['Here it is. <chat>Write a sum function.</chat> Take a look.']);
      assert.deepEqual(whole.pushed[0].sentences, ['Here it is.', 'Take a look.']);
      assert.deepEqual(whole.pushed[0].chats, ['Write a sum function.']);
      assert.deepEqual(whole.ended.chats, []);
      const split = feed(['Look. <ch', 'at>Line one', ' and two.</c', 'hat> Done.']);
      assert.deepEqual(split.pushed.map(item => item.chats), [[], [], [], ['Line one and two.']]);
      assert.deepEqual(split.pushed.flatMap(item => item.sentences), ['Look.', 'Done.']);
      const open = feed(['Look. <chat>Unfinished text']);
      assert.deepEqual(open.pushed[0].chats, [], 'an unclosed block is held');
      assert.deepEqual(open.pushed[0].sentences, ['Look.']);
      assert.deepEqual(open.ended.chats, ['Unfinished text'], 'end() emits an unclosed block');
      assert.deepEqual(feed(['No chat here.']).pushed[0].chats, []);
      const withEnd = feed(['Bye. <chat>See link-free note.</chat><end-call/>']);
      assert.deepEqual(withEnd.pushed[0].chats, ['See link-free note.']);
      assert.equal(withEnd.pushed[0].endCall, true);
    },
  },
];
