import assert from 'node:assert/strict';
import { snapshotOfficialPostingLeads } from '../../electron/ipc/officialPostingSnapshot.js';
import { eightfoldPostingRoute } from '../../electron/ipc/officialPostingEightfold.js';

const PAGE_URL = 'https://careers.northwind.test/careers/job/1970393556866289';
const DETAILS = 'https://careers.northwind.test/api/pcsx/position_details?position_id=1970393556866289&domain=northwind.test&hl=en';
const RECORD = 'https://careers.northwind.test/api/apply/v2/jobs/1970393556866289?domain=northwind.test';
// The page as the platform sends it: settings as HTML-escaped JSON, no posting anywhere in the markup.
const shell = settings => `<html><head><title> | Northwind Careers</title><link href="https://static.vscdn.net/eightfold.css"></head>
  <body><div data-props="${settings.replace(/"/gu, '&#34;')}"></div></body></html>`;
const SHELL = shell('{"domain": "northwind.test", "pcsxConfig": {"enabled": true}, "domains": ["other.example"]}');
const lead = { id: 'P1', url: PAGE_URL, kind: 'posting', employer: 'Northwind' };
const board = (extra = {}) => JSON.stringify({ status: 200, data: { id: 1970393556866289, name: 'Dispatch Engineer', location: 'Lakeview',
  locations: ['Canada, Ontario, Lakeview'], jobDescription: '<b>Overview</b><p>Build routing services.</p>',
  publicUrl: PAGE_URL, ...extra } });
const record = (extra = {}) => JSON.stringify({ id: 1970393556866289, name: 'Dispatch Engineer', location: 'Lakeview',
  locations: ['Canada, Ontario, Lakeview', 'Canada, Ontario, Lakeview'], job_description: '<p>Build routing services.</p>', ...extra });
const notFound = () => Object.assign(new Error('gone'), { code: 'closed', statusCode: 404 });
const failed = statusCode => Object.assign(new Error('failed'), { code: 'fetch-failed', statusCode });
const fetchFrom = routes => {
  const seen = [];
  const fetch = async url => {
    seen.push(url);
    const answer = routes[url];
    if (answer === undefined) throw failed(500);
    if (answer instanceof Error) throw answer;
    return { url, contentType: url === PAGE_URL ? 'text/html' : 'application/json', body: answer };
  };
  return { fetch, seen };
};
const snapshot = async routes => {
  const { fetch, seen } = fetchFrom({ [PAGE_URL]: SHELL, ...routes });
  return { snap: (await snapshotOfficialPostingLeads([lead], { fetch }))[0], seen };
};

export default [
  {
    name: 'Eightfold shell: a posting the current board answers for is listed, with its fields',
    async run() {
      const { snap, seen } = await snapshot({ [DETAILS]: board() });
      assert.equal(snap.source, 'board-data');
      assert.equal(snap.read, true);
      assert.equal(snap.listedInBoardData, true);
      assert.equal(snap.postingsInData, 1);
      assert.equal(snap.title, 'Dispatch Engineer');
      assert.equal(snap.location, 'Canada, Ontario, Lakeview');
      assert.match(snap.description, /Build routing services\./u);
      assert.equal(snap.pageText, undefined, 'the shell\'s settings text is not sent to the judges');
      assert.deepEqual(seen, [PAGE_URL, DETAILS], 'an open posting needs no second record');
    },
  },
  {
    name: 'Eightfold shell: a posting gone from the board but kept on record is not listed, and still identifiable',
    async run() {
      const { snap } = await snapshot({ [DETAILS]: notFound(), [RECORD]: record() });
      assert.equal(snap.source, 'board-data');
      assert.equal(snap.listedInBoardData, false);
      assert.equal(snap.postingsInData, 1);
      assert.equal(snap.title, 'Dispatch Engineer');
      assert.equal(snap.location, 'Canada, Ontario, Lakeview', 'duplicate places collapse');
      assert.match(snap.description, /Build routing services\./u);
    },
  },
  {
    name: 'Eightfold shell: a board record without a public address is not listed',
    async run() {
      const { snap } = await snapshot({ [DETAILS]: board({ publicUrl: null }) });
      assert.equal(snap.listedInBoardData, false);
      assert.equal(snap.title, 'Dispatch Engineer');
    },
  },
  {
    name: 'Eightfold shell: nothing says closed unless the board said not found and the record is this posting',
    async run() {
      const cases = {
        'board refused': { [DETAILS]: failed(403), [RECORD]: record() },
        'board rate limited': { [DETAILS]: failed(429), [RECORD]: record() },
        'board server error': { [DETAILS]: failed(503), [RECORD]: record() },
        'board answered another posting': { [DETAILS]: board({ id: 111111 }), [RECORD]: record() },
        'board answered nonsense': { [DETAILS]: '<html>maintenance</html>', [RECORD]: record() },
        'no record': { [DETAILS]: notFound(), [RECORD]: notFound() },
        'record failed': { [DETAILS]: notFound(), [RECORD]: failed(500) },
        'record is another posting': { [DETAILS]: notFound(), [RECORD]: record({ id: 222222 }) },
      };
      for (const [label, routes] of Object.entries(cases)) {
        const { snap } = await snapshot(routes);
        assert.equal(snap.source, 'page', label);
        assert.equal(snap.listedInBoardData, undefined, label);
      }
    },
  },
  {
    name: 'Eightfold shell: unclosed inline tags still give the whole description, line by line',
    async run() {
      const nested = `${'<u><b>'.repeat(40)}<p>First line.</p><p>Second&nbsp;line.</p><script>hidden()</script>Last line.`;
      const { snap } = await snapshot({ [DETAILS]: board({ jobDescription: nested }) });
      assert.equal(snap.description, 'First line.\nSecond line.\nLast line.');
    },
  },
  {
    name: 'Eightfold data is requested only for a job page whose own markup shows the platform\'s current board',
    run() {
      assert.ok(eightfoldPostingRoute(SHELL, PAGE_URL));
      assert.equal(eightfoldPostingRoute(SHELL, 'https://careers.northwind.test/careers'), null, 'not a job page');
      assert.equal(eightfoldPostingRoute(SHELL, 'http://careers.northwind.test/careers/job/1970393556866289'), null, 'not https');
      assert.equal(eightfoldPostingRoute('<html>{"domain": "northwind.test", "pcsxConfig": {"enabled": true}}</html>', PAGE_URL), null, 'another platform');
      assert.equal(eightfoldPostingRoute(shell('{"domain": "northwind.test"}'), PAGE_URL), null, 'an older site without this board');
      assert.equal(eightfoldPostingRoute(shell('{"domain": "northwind.test", "pcsxConfig": {"enabled": false}}'), PAGE_URL), null, 'board switched off');
      assert.equal(eightfoldPostingRoute(shell('{"pcsxConfig": {"enabled": true}}'), PAGE_URL), null, 'no site domain');
      const route = eightfoldPostingRoute(SHELL, `${PAGE_URL}-dispatch-engineer?hl=en`);
      assert.equal(route.boardUrl, DETAILS, 'a title slug and a query do not change the address');
      assert.equal(route.recordUrl, RECORD);
    },
  },
];
