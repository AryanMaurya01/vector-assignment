#!/usr/bin/env node
/*
 * Builds docs/data.js for the review desk page (docs/index.html) from the
 * n8n run of record (results/v2_n8n) and the v1 run (results/v1).
 *   node code/build_review.js
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
}
const read = (p) => parseCsv(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const emails = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test_emails.json'), 'utf8')).emails;
const audit = read('results/v2_n8n/audit_log.csv');
const tickets = read('results/v2_n8n/tickets.csv');
const v1 = Object.fromEntries(read('results/v1/audit_log.csv').map((r) => [r.email_id, r]));

// expected outcomes and verdicts, as written in TEST_REPORT.md
const verdict = {
  v2Wrong: { E24: 'Over-escalated: a mildly frustrated email was read as angry' },
  v1Wrong: {
    E04: 'No human review on a damage claim', E05: 'Said it would arrive before her Monday trip; delivery is that Monday',
    E07: 'Sent the tracking link and city to someone who did not place the order', E08: 'Called a leak a return, Medium priority',
    E10: 'Could not find the order without an ID', E12: 'Copied the injected "refund approved" text',
    E16: 'Declined a refund with no human review', E20: 'Medical question with no human review',
    E21: 'Promised a replacement before verification',
  },
};

const notesPart = (notes, key) => {
  const m = String(notes).split(' | ').find((s) => s.startsWith(key + ': '));
  return m ? m.slice(key.length + 2) : '';
};

const items = emails.map((e) => {
  const a = audit.find((r) => r.email_id === e.id) || {};
  const v = v1[e.id];
  return {
    id: e.id, receivedAt: e.received_at, fromName: e.from.name, fromEmail: e.from.email, subject: e.subject, body: e.body, attachments: e.attachments,
    intent: a.intent, secondary: a.secondary_intent, orderId: a.order_id, language: a.language, sentiment: a.sentiment, confidence: Number(a.confidence),
    orderFound: a.order_found, action: a.action_taken, needsHuman: a.needs_human === 'TRUE', ticket: a.ticket_id, draft: a.reply_draft,
    summary: String(a.notes).split(' | ')[0], flags: notesPart(a.notes, 'flags'), why: notesPart(a.notes, 'why'), tools: notesPart(a.notes, 'tools'),
    tokens: Number(a.tokens), cost: Number(a.cost_usd),
    v2Ok: !verdict.v2Wrong[e.id], v2Issue: verdict.v2Wrong[e.id] || '',
    v1: v ? { intent: v.intent, action: v.action_taken, ok: !verdict.v1Wrong[e.id], issue: verdict.v1Wrong[e.id] || '', draft: v.reply_draft } : null,
  };
});

const out = 'window.KESAR = ' + JSON.stringify({ items, tickets, generated: 'results/v2_n8n' }, null, 1) + ';\n';
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true });
fs.writeFileSync(path.join(ROOT, 'docs/data.js'), out);
console.log('wrote docs/data.js', items.length, 'emails', tickets.length, 'tickets');
