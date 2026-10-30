import assert from 'node:assert/strict';
import { deriveOfficialPostingReadOnlyAjaxRequest as derive, validateOfficialPostingReadOnlyAjaxResponse as validate } from '../../electron/ipc/officialPostingReadOnlyAjax.js';

const documentUrl = 'https://synthetic.test/careers/index.html';
const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' };
const request = (name, body, options = {}) => derive({ url: `https://synthetic.test/careers/${name}`, documentUrl, headers, body, ...options });
const response = (plan, data, options = {}) => ({ url: plan.url, body: JSON.stringify(data), statusCode: 200, contentType: 'text/html', ...options });
const board = '<div class="jobs_wrapper"><div class="single_job_wrapper"><h3>Software Engineer</h3><a href="single-job.html?job_id=12345">View details</a></div></div>';
const detail = { success: true, title: 'Software Engineer', content: '&lt;p&gt;Build product software.&lt;/p&gt;', location: 'Example City', link: 'https://job-boards.greenhouse.io/synthetic/jobs/12345' };

export default [
  { name: 'read-only AJAX derives only exact observed public careers GETs with bounded known form fields', run() {
    assert.deepEqual(request('greenhouse_api.php', 'limit=-1'), { url: 'https://synthetic.test/careers/greenhouse_api.php?limit=-1', type: 'board', jobId: '' });
    assert.deepEqual(request('fetch-single-job.php', 'job_id=12345'), { url: 'https://synthetic.test/careers/fetch-single-job.php?job_id=12345', type: 'detail', jobId: '12345' });
    for (const body of ['job_id=12345&job_id=456', 'job_id=12345&email=private', 'job_id=-1', 'job_id=1.5', 'job_id=0123', 'job_id=1e5', 'job_id=1&x=2']) assert.equal(request('fetch-single-job.php', body), null);
    assert.equal(request('greenhouse_api.php', 'limit=1'), null); assert.equal(request('greenhouse_api.php', 'limit=-1&location=Canada'), null);
    assert.equal(request('fetch-single-job.php', 'x'.repeat(2_049)), null);
  } },
  { name: 'read-only AJAX rejects foreign origins arbitrary endpoints credential URLs and wrong content types', run() {
    for (const url of ['https://foreign.test/careers/fetch-single-job.php', 'https://user@synthetic.test/careers/fetch-single-job.php',
      'https://synthetic.test/careers/fetch-single-job.php?job_id=12345', 'https://synthetic.test/careers/apply.php',
      'https://synthetic.test/products/fetch-single-job.php']) assert.equal(request('fetch-single-job.php', 'job_id=12345', { url }), null);
    assert.equal(request('fetch-single-job.php', 'job_id=12345', { documentUrl: 'https://synthetic.test/products' }), null);
    assert.equal(request('fetch-single-job.php', 'job_id=12345', { headers: { 'content-type': 'application/json' } }), null);
    assert.equal(request('fetch-single-job.php', 'job_id=12345', { headers: { 'content-type': headers['content-type'], 'Content-Type': headers['content-type'] } }), null);
  } },
  { name: 'read-only AJAX validates public board HTML and preserves its string response type', run() {
    const plan = request('greenhouse_api.php', 'limit=-1'); const page = response(plan, { success: true, jobs: board });
    assert.deepEqual(validate(plan, page), page);
    for (const jobs of [board + '<script>mustNotRun()</script>', board.replace('single-job.html', 'https://foreign.test/single-job.html'),
      board.replace('job_id=12345', 'email=private'), board + '<form><input name="email"></form>', board.replace('<h3>', '<h3 onclick="alert(1)">'),
      board + '<meta http-equiv="refresh" content="0;url=https://foreign.test">', board + '<div srcdoc="anything"></div>', '<p>Unknown response</p>']) assert.equal(validate(plan, response(plan, { success: true, jobs })), null);
  } },
  { name: 'read-only AJAX binds exact Greenhouse numeric posting identity and rejects failed or redirected responses', run() {
    const plan = request('fetch-single-job.php', 'job_id=12345');
    assert.equal(validate(plan, response(plan, detail)).contentType, 'text/html');
    for (const values of [{ ...detail, link: detail.link.replace('12345', '67890') }, { ...detail, link: detail.link.replace('greenhouse.io', 'evil.test') },
      { ...detail, success: false }, { ...detail, content: null }, { ...detail, location: {} }]) assert.equal(validate(plan, response(plan, values)), null);
    assert.equal(validate(plan, response(plan, detail, { url: 'https://foreign.test/detail' })), null);
    assert.equal(validate(plan, response(plan, detail, { statusCode: 404 })), null);
    assert.equal(validate(plan, response(plan, detail, { body: 'x'.repeat(3 * 1024 * 1024 + 1) })), null);
  } },
];
