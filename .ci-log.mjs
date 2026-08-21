import { writeFile } from 'node:fs/promises';
const repo = 'yuanchilin/dsh-mailbox';
const runId = 32486956643;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
async function api(p) {
  const r = await fetch('https://api.github.com/repos/' + repo + p, {
    headers: { 'User-Agent': UA, 'Accept': 'application/vnd.github+json' },
  });
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
}
const jobs = await api(`/actions/runs/${runId}/jobs`);
for (const job of jobs.jobs) {
  console.log('JOB', job.id, job.name, job.conclusion);
  if (job.conclusion !== 'failure') continue;
  const url = `https://api.github.com/repos/${repo}/actions/jobs/${job.id}/logs`;
  let r = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'manual' });
  console.log('logs status:', r.status, 'location:', r.headers.get('location'));
  if (r.status >= 300 && r.status < 400) {
    const loc = r.headers.get('location');
    if (loc) {
      const r2 = await fetch(loc, { headers: { 'User-Agent': UA } });
      console.log('signed fetch:', r2.status);
      if (r2.ok) {
        const buf = Buffer.from(await r2.arrayBuffer());
        await writeFile(`D:/Downloads/Agent/dsh-mailbox/.ci-logs-${job.id}.zip`, buf);
        console.log('saved', buf.length);
      }
    }
  } else {
    const txt = await r.text();
    console.log('body head:', txt.slice(0, 300));
  }
}