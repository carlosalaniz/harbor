// Browser side of the IP Lookup page. Response data is rendered with textContent only.
const doc = globalThis.document;
const form = doc.getElementById('lookup');
const input = doc.getElementById('ip');
const out = doc.getElementById('out');

const LABELS = {
  country: 'Country',
  region: 'Region',
  city: 'City',
  asn: 'Network (ASN)',
  org: 'Organisation',
  hostname: 'Host name',
  abuseScore: 'Abuse score',
  reports: 'Reports (90 days)',
  lastReportedAt: 'Last reported',
  usage: 'Usage',
  flags: 'Flags',
};
const SOURCES = { ipinfo: 'ipinfo', abuseipdb: 'AbuseIPDB' };

function el(tag, text, className) {
  const node = doc.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function render(data) {
  out.replaceChildren();
  if (data.error) {
    out.append(el('p', data.error, 'error'));
    return;
  }
  if (data.note) out.append(el('p', data.note));
  for (const r of data.results || []) {
    const section = el('section', undefined, 'result');
    section.append(el('h2', SOURCES[r.source] || r.source));
    if (!r.ok) {
      section.append(el('p', `Failed: ${r.error}`, 'error'));
    } else {
      const dl = el('dl');
      for (const [key, label] of Object.entries(LABELS)) {
        let v = r[key];
        if (Array.isArray(v)) v = v.length ? v.join(', ') : undefined;
        if (key === 'abuseScore' && v !== undefined) v = `${v} / 100`;
        if (v === undefined || v === null || v === '') continue;
        dl.append(el('dt', label), el('dd', v));
      }
      section.append(dl);
    }
    out.append(section);
  }
  if (data.cached) out.append(el('p', 'From the last 24 hours (cached).'));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const ip = input.value.trim();
  if (!ip) return;
  out.replaceChildren(el('p', 'Looking up…'));
  try {
    const res = await fetch(`/v1/lookup?ip=${encodeURIComponent(ip)}`, { headers: { Accept: 'application/json' } });
    render(await res.json());
  } catch {
    render({ error: 'The lookup did not answer.' });
  }
});
