/*
 * Kesar & Co. Support Copilot — deterministic core logic.
 *
 * This file is the single source of truth for every rule that must NOT depend
 * on the LLM (validation, order lookup, privacy, date maths, eligibility,
 * risk flags, routing, guardrails, ticket de-duplication).
 *
 * It is plain ES2020 with no imports so that `code/build_workflow.js` can
 * inline it verbatim into n8n Code nodes, and `code/run_local.js` can
 * require() it. Same code runs in both places.
 */

const INTENTS = ['order_status', 'product_query', 'return_refund', 'complaint', 'other'];
const SENTIMENTS = ['positive', 'neutral', 'negative', 'angry'];
const LANGS = ['en', 'hi', 'hinglish'];
const ISSUE_TYPES = ['none', 'delay', 'change_of_mind', 'not_suitable', 'damaged', 'leaking', 'wrong_item', 'missing_item', 'cancellation', 'other'];
const CONDITIONS = ['unopened', 'opened_or_used', 'unknown'];

// Confidence below this goes to a human. See README §5 for the reasoning.
const CONFIDENCE_THRESHOLD = 0.75;

/* ------------------------------------------------------------------ */
/* 1. Classification output: parse, validate, repair, fall back        */
/* ------------------------------------------------------------------ */

function parseJsonLoose(text) {
  if (text && typeof text === 'object') return text;
  if (typeof text !== 'string') return null;
  let t = text.trim();
  // strip ```json fences
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) { try { return JSON.parse(t.slice(s, e + 1)); } catch (err) { return null; } }
  return null;
}

/** Validates against schemas/llm_output.schema.json (required fields + types). */
function validateClassification(obj) {
  const errors = [];
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return ['not a JSON object'];
  if (!INTENTS.includes(obj.intent)) errors.push('intent must be one of ' + INTENTS.join('|'));
  if (!(obj.secondary_intent === null || INTENTS.includes(obj.secondary_intent))) errors.push('secondary_intent must be an intent or null');
  if (!(obj.order_id === null || (typeof obj.order_id === 'string' && /^KC-[0-9]{4}$/.test(obj.order_id)))) errors.push('order_id must match ^KC-[0-9]{4}$ or be null');
  if (!SENTIMENTS.includes(obj.sentiment)) errors.push('sentiment invalid');
  if (!LANGS.includes(obj.language)) errors.push('language invalid');
  if (typeof obj.confidence !== 'number' || obj.confidence < 0 || obj.confidence > 1) errors.push('confidence must be number 0..1');
  if (typeof obj.summary !== 'string' || obj.summary.length === 0 || obj.summary.length > 200) errors.push('summary must be a 1-200 char string');
  return errors;
}

/** Cheap, safe, non-LLM repairs for common near-misses. */
function repairClassification(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const o = Object.assign({}, obj);
  const lc = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
  o.intent = lc(o.intent);
  o.secondary_intent = (o.secondary_intent === undefined || o.secondary_intent === '' || lc(o.secondary_intent) === 'null' || lc(o.secondary_intent) === 'none') ? null : lc(o.secondary_intent);
  if (o.secondary_intent === o.intent) o.secondary_intent = null;
  o.sentiment = lc(o.sentiment);
  o.language = lc(o.language);
  if (o.language === 'english') o.language = 'en';
  if (o.language === 'hindi') o.language = 'hi';
  if (typeof o.order_id === 'string') {
    const m = o.order_id.toUpperCase().match(/KC[-\s]?(\d{4})/);
    o.order_id = m ? 'KC-' + m[1] : null;
  } else if (o.order_id === undefined || o.order_id === '') o.order_id = null;
  if (typeof o.confidence === 'string') o.confidence = parseFloat(o.confidence);
  if (typeof o.confidence === 'number' && o.confidence > 1 && o.confidence <= 100) o.confidence = o.confidence / 100;
  if (typeof o.summary === 'string' && o.summary.length > 200) o.summary = o.summary.slice(0, 197) + '...';
  if (!ISSUE_TYPES.includes(o.issue_type)) o.issue_type = 'other';
  if (!CONDITIONS.includes(o.item_condition)) o.item_condition = 'unknown';
  return o;
}

/** Last resort when the model never produced valid JSON. Always safe. */
function fallbackClassification(email, reason) {
  return {
    intent: 'other', secondary_intent: null,
    order_id: extractOrderIds(email)[0] || null,
    sentiment: 'neutral', language: 'en', confidence: 0,
    summary: ('Classification failed (' + reason + '). Needs manual triage.').slice(0, 200),
    issue_type: 'other', item_condition: 'unknown', customer_request: 'unknown',
    _fallback: true,
  };
}

/* ------------------------------------------------------------------ */
/* 2. Deterministic extraction + risk flags (never trust the LLM alone) */
/* ------------------------------------------------------------------ */

function extractOrderIds(email) {
  const text = (email.subject || '') + '\n' + (email.body || '');
  const ids = [];
  const re = /\bKC[-\s]?(\d{4})\b/gi;
  let m;
  while ((m = re.exec(text)) !== null) { const id = 'KC-' + m[1]; if (!ids.includes(id)) ids.push(id); }
  return ids;
}

const INJECTION_PATTERNS = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules|policies)/i,
  /system (note|prompt|message|instruction)/i,
  /\bnote to (the )?(ai|assistant|bot|model)\b/i,
  /you are (now )?(a|an|the) /i,
  /reply (exactly|only) (with|:)/i,
  /mark (the )?(refund|request|ticket) as approved/i,
  /do not create (any |a )?ticket/i,
  /developer mode|jailbreak/i,
];
const MEDICAL_PATTERNS = /\b(eczema|psoriasis|dermatitis|rosacea|acne|rash|allerg\w*|reaction|burn(ing)?|itch\w*|swell\w*|pregnan\w*|breastfeed\w*|cure[sd]?|treat(s|ment)?|infection|doctor|medicine|medical|prescription)\b/i;
const ESCALATION_PATTERNS = /\b(instagram|twitter|facebook|social media|review(s)? everywhere|consumer (court|forum)|lawyer|legal action|police|fraud|scam|chargeback)\b/i;
const SENSITIVE_DATA_PATTERNS = /\b(otp|cvv|card pin|password|aadhaar|pan (card|number))\b/i;

function riskFlags(email) {
  const text = (email.subject || '') + '\n' + (email.body || '');
  const flags = [];
  if (INJECTION_PATTERNS.some((r) => r.test(text))) flags.push('prompt_injection');
  if (MEDICAL_PATTERNS.test(text)) flags.push('medical');
  if (ESCALATION_PATTERNS.test(text)) flags.push('public_escalation_threat');
  if (SENSITIVE_DATA_PATTERNS.test(text)) flags.push('sensitive_data');
  if (extractOrderIds(email).length > 1) flags.push('multiple_order_ids');
  return flags;
}

/* ------------------------------------------------------------------ */
/* 3. Order lookup + privacy                                           */
/* ------------------------------------------------------------------ */

function norm(e) { return String(e || '').trim().toLowerCase(); }

/**
 * Looks up the order by ID first, then by sender email.
 * Returns { order, lookup_method, owner_match, candidates }.
 * `order` is only the raw record; whether it may be SHARED is owner_match.
 */
function findOrder(orders, orderId, senderEmail) {
  if (orderId) {
    const o = orders.find((x) => x.order_id === orderId);
    if (!o) return { order: null, lookup_method: 'order_id_not_found', owner_match: false, candidates: 0 };
    return { order: o, lookup_method: 'order_id', owner_match: norm(o.customer_email) === norm(senderEmail), candidates: 1 };
  }
  const mine = orders.filter((x) => norm(x.customer_email) === norm(senderEmail));
  if (mine.length === 0) return { order: null, lookup_method: 'email_not_found', owner_match: false, candidates: 0 };
  // most recent order wins; >1 candidates is surfaced so a human can check
  mine.sort((a, b) => (a.order_date < b.order_date ? 1 : -1));
  return { order: mine[0], lookup_method: 'sender_email', owner_match: true, candidates: mine.length };
}

/** The ONLY view of an order the agent/customer ever sees. Owner-checked upstream. */
function publicOrderView(o) {
  if (!o) return null;
  return {
    order_id: o.order_id, customer_first_name: String(o.customer_name || '').split(' ')[0],
    order_date: o.order_date,
    items: (o.items || []).map((i) => ({ name: i.name, qty: i.qty, unit_price: i.unit_price })),
    subtotal: o.subtotal, shipping_fee: o.shipping_fee, cod_fee: o.cod_fee, total: o.total,
    payment_method: o.payment_method, status: o.status, courier: o.courier, tracking_url: o.tracking_url,
    shipped_date: o.shipped_date, estimated_delivery: o.estimated_delivery, delivered_date: o.delivered_date,
    cancelled_date: o.cancelled_date, cancellation_reason: o.cancellation_reason, refund_status: o.refund_status,
    delivery_city: o.shipping_address ? o.shipping_address.city : null,
  };
}

/* ------------------------------------------------------------------ */
/* 4. Date maths + policy (FAQ §4, §5, §6) — done in code, not the LLM */
/* ------------------------------------------------------------------ */

function dayNumber(isoDate) { // 'YYYY-MM-DD' (or ISO with offset: local date part is used)
  const [y, m, d] = String(isoDate).slice(0, 10).split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function daysBetween(fromIso, toIso) { return dayNumber(toIso) - dayNumber(fromIso); }

const DEFECT_TYPES = ['damaged', 'leaking', 'wrong_item', 'missing_item'];

/**
 * Applies the FAQ return / damage rules. Returns a structured decision that
 * the agent is told to communicate (it never decides eligibility itself).
 */
function policyDecision(cls, order, email) {
  const issue = cls.issue_type;
  const d = { policy: null, eligible: null, days_since_delivery: null, reasons: [], refund_note: null };
  if (!order) return d;
  if (order.delivered_date) d.days_since_delivery = daysBetween(order.delivered_date, email.received_at);

  if (DEFECT_TYPES.includes(issue)) {
    d.policy = 'faq_5_damaged_wrong_missing';
    if (order.status !== 'delivered') { d.eligible = false; d.reasons.push('order not marked delivered'); return d; }
    d.eligible = d.days_since_delivery <= 2;
    d.reasons.push(d.eligible ? 'reported within 48 hours of delivery' : 'reported more than 48 hours after delivery');
    const photos = (email.attachments || []).length > 0;
    d.photos_received = photos;
    if (!photos && issue !== 'missing_item') d.reasons.push('photos of product and outer box still needed');
    if (issue === 'missing_item') {
      d.reasons.push('verify against packing weight record before refund/reship');
      d.refund_note = 'Missing item: after verification we ship the missing item or refund its value (unit price as listed in the order).';
    } else if (issue === 'wrong_item') {
      d.refund_note = 'Wrong item: we pick up the wrong item and send the correct one at no cost (refund instead if the customer prefers).';
    } else {
      d.refund_note = 'Damaged/leaking: after verification the customer chooses a free replacement or a full refund of the amount paid.';
    }
    return d;
  }

  if (cls.intent === 'return_refund' || cls.secondary_intent === 'return_refund') {
    d.policy = 'faq_4_returns';
    if (order.status === 'cancelled') {
      d.policy = 'faq_3_cancellation'; d.eligible = null;
      d.reasons.push('order already cancelled; refund status: ' + (order.refund_status || 'unknown'));
      return d;
    }
    if (order.status !== 'delivered') { d.eligible = false; d.reasons.push('order not yet delivered; cannot return before delivery'); return d; }
    const inWindow = d.days_since_delivery <= 7;
    const sealed = cls.item_condition === 'unopened';
    const notSuitable = issue === 'not_suitable';
    if (!inWindow) d.reasons.push('outside 7-day return window (' + d.days_since_delivery + ' days since delivery)');
    if (cls.item_condition === 'opened_or_used') d.reasons.push('product opened/used — not returnable for hygiene reasons');
    if (cls.item_condition === 'unknown') d.reasons.push('item condition not stated — must be unopened with seal intact');
    if (notSuitable) d.reasons.push('"did not suit / no results" is not a return reason for opened products');
    d.eligible = inWindow && sealed && !notSuitable;
    if (d.eligible) d.reasons.push('within 7 days and unopened — eligible for free reverse pickup in 2–3 business days');
    if ((order.items || []).some((i) => /kit/i.test(i.name))) d.reasons.push('kit must be returned as a complete set');
    const fees = [];
    if (order.cod_fee) fees.push('COD fee (₹' + order.cod_fee + ')');
    if (order.shipping_fee) fees.push('shipping fee (₹' + order.shipping_fee + ')');
    const feeNote = fees.length ? ' The ' + fees.join(' and ') + ' ' + (fees.length > 1 ? 'are' : 'is') + ' non-refundable.' : ' No shipping or COD fee was charged on this order, so do not mention fees.';
    d.refund_note = (order.payment_method === 'cod'
      ? 'COD: refund via UPI or bank transfer; we ask for UPI ID / bank details AFTER pickup is completed.'
      : 'Prepaid: refund to original payment method within 5–7 business days after the returned item passes quality check.') + feeNote;
    return d;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* 5. Routing: action, ticket, priority, needs_human                   */
/* ------------------------------------------------------------------ */

function decideRoute(cls, email, lookup, flags, policy) {
  const reasons = [];
  let needsHuman = false;
  const hasOrderIntent = ['order_status', 'return_refund', 'complaint'].includes(cls.intent);
  const defect = DEFECT_TYPES.includes(cls.issue_type);

  if (cls._fallback) { needsHuman = true; reasons.push('classification fell back'); }
  if (cls.confidence < CONFIDENCE_THRESHOLD) { needsHuman = true; reasons.push('confidence ' + cls.confidence + ' < ' + CONFIDENCE_THRESHOLD); }
  if (flags.includes('prompt_injection')) { needsHuman = true; reasons.push('prompt injection attempt in email'); }
  if (flags.includes('medical') && cls.intent !== 'other') { needsHuman = true; reasons.push('medical/skin-condition question'); }
  if (flags.includes('public_escalation_threat') && cls.intent !== 'other') { needsHuman = true; reasons.push('threat of public escalation'); }
  if (cls.sentiment === 'angry') { needsHuman = true; reasons.push('angry customer'); }

  let action, template = null, ticket = false, priority = null;

  if (cls.intent === 'other') {
    action = 'log_only';
    if (cls.other_type === 'business_request') { needsHuman = true; reasons.push('business/finance request — route to the right team'); }
  } else {
    action = 'draft_reply';
    if (hasOrderIntent) {
      if (!lookup.order) {
        template = 'order_not_found'; needsHuman = true; reasons.push('order not found (' + lookup.lookup_method + ')');
      } else if (!lookup.owner_match) {
        template = 'privacy_mismatch'; needsHuman = true; reasons.push('sender is not the order owner — no order details shared');
      } else if (lookup.candidates > 1) {
        needsHuman = true; reasons.push('sender has ' + lookup.candidates + ' orders; picked most recent');
      }
    }
    if (cls.intent === 'return_refund' || cls.intent === 'complaint' || defect) {
      ticket = !!(lookup.order && lookup.owner_match);
      priority = (cls.intent === 'complaint' || defect || cls.sentiment === 'angry' || flags.includes('public_escalation_threat')) ? 'High' : 'Medium';
      if (flags.includes('prompt_injection')) priority = 'High';
      if (policy && policy.eligible === false) { needsHuman = true; reasons.push('policy says not eligible — human should confirm decline'); }
      if (policy && policy.policy === 'faq_5_damaged_wrong_missing') { needsHuman = true; reasons.push('damage/wrong/missing claim needs photo/weight verification'); }
      if (ticket && !needsHuman && policy && policy.eligible) reasons.push('eligible return — ticket opened for pickup');
    }
    if (ticket) action = 'ticket_and_draft';
  }
  return { action, template, ticket, priority, needs_human: needsHuman, reasons };
}

/* ------------------------------------------------------------------ */
/* 6. FAQ search tool (heading-split keyword retrieval)                */
/* ------------------------------------------------------------------ */

function splitFaq(faqMd) {
  const sections = [];
  const parts = faqMd.split(/\n(?=## )/);
  for (const p of parts) {
    const m = p.match(/^## (.+)/);
    if (!m) continue;
    const title = m[1].trim();
    if (/Products$/.test(title)) {
      // split product table into one chunk per product so answers stay precise
      const head = p.split('\n|')[0];
      const rows = p.split('\n').filter((l) => /^\| [A-Z]/.test(l) && !/^\| Product/.test(l));
      sections.push({ title: title + ' — general', text: head.trim() });
      for (const r of rows) sections.push({ title: title + ' — ' + r.split('|')[1].trim(), text: '| Product | Price | Key facts |\n' + r });
    } else sections.push({ title, text: p.trim() });
  }
  return sections;
}

const FAQ_SYNONYMS = {
  delivery: ['shipping', 'dispatch', 'days', 'deliver'], ship: ['shipping', 'delivery'], cod: ['cash', 'delivery', 'cod'],
  cash: ['cod'], refund: ['refunds', 'return'], return: ['returns', 'refund'], damaged: ['damaged', 'leaking', 'wrong', 'missing'],
  vegan: ['vegan'], oily: ['oily', 'skin'], eczema: ['medical', 'skin', 'condition', 'dermatologist'], cure: ['medical', 'treat', 'cure'],
  guwahati: ['north-east', 'assam'], assam: ['north-east'], northeast: ['north-east'], cancel: ['cancellation', 'cancelled'],
  partnership: ['partnerships', 'influencers'], collab: ['partnerships', 'influencers'], gst: ['invoice'], invoice: ['gst'],
  'डिलीवरी': ['delivery', 'shipping'], 'कैश': ['cod', 'cash'], 'गुवाहाटी': ['north-east', 'assam'],
};

function searchFaq(faqMd, query, k) {
  k = k || 3;
  const sections = splitFaq(faqMd);
  let terms = String(query || '').toLowerCase().split(/[^\p{L}\p{N}-]+/u).filter((t) => t.length > 2);
  const extra = [];
  for (const t of terms) for (const key of Object.keys(FAQ_SYNONYMS)) if (t.includes(key)) extra.push(...FAQ_SYNONYMS[key]);
  terms = terms.concat(extra);
  const scored = sections.map((s) => {
    const hay = (s.title + ' ' + s.text).toLowerCase();
    let score = 0;
    for (const t of terms) { if (hay.includes(t)) score += 1; if (s.title.toLowerCase().includes(t)) score += 2; }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
  if (scored.length === 0) return 'NO_MATCH: The FAQ does not cover this. Do not answer it; say a team member will follow up.';
  return scored.map((x) => '### ' + x.s.title + '\n' + x.s.text).join('\n\n');
}

/* ------------------------------------------------------------------ */
/* 7. Templates for cases where we must not let the LLM improvise       */
/* ------------------------------------------------------------------ */

const SIGN_OFF = 'Warm regards,\nTeam Kesar';
function firstName(email) { return String((email.from && email.from.name) || '').trim().split(/\s+/)[0] || 'there'; }

function templateReply(kind, email, cls) {
  const n = firstName(email);
  if (kind === 'privacy_mismatch') {
    return 'Hi ' + n + ',\n\nThank you for reaching out. For the security of our customers, we can only share order details, tracking links and delivery addresses with the person who placed the order, from the email address used at checkout. Could you please ask the account holder to write to us from that address? They can also forward the dispatch email, which contains the tracking link.\n\n' + SIGN_OFF;
  }
  if (kind === 'order_not_found') {
    const idPart = cls.order_id ? 'we could not find an order with the ID ' + cls.order_id : 'we could not find an order linked to this email address';
    return 'Hi ' + n + ',\n\nSorry for the trouble. We checked, but ' + idPart + '. Could you please share your order ID (it starts with KC-) and the email address or phone number used at checkout? A team member will look into it and get back to you within 24 business hours.\n\n' + SIGN_OFF;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 8. Output guardrails on the agent's draft                            */
/* ------------------------------------------------------------------ */

const FAQ_AMOUNTS = [999, 79, 5000, 49, 1299, 1149, 699, 899, 649, 749, 499, 3499];

function checkDraft(draft, ctx) {
  const issues = [];
  const text = String(draft || '');
  if (!text.trim()) return ['empty draft'];
  if (/^NEEDS_HUMAN/i.test(text.trim())) return ['agent declined: ' + text.trim().slice(0, 120)];
  const allowedOrder = ctx.order && ctx.owner_match ? ctx.order.order_id : null;
  for (const id of (text.match(/KC-\d{4}/g) || [])) if (id !== allowedOrder && id !== ctx.claimed_order_id) issues.push('mentions order ' + id + ' not verified for this sender');
  for (const url of (text.match(/https?:\/\/[^\s)>\]]+/g) || [])) {
    const clean = url.replace(/[.,;]+$/, '');
    if (!(ctx.order && ctx.owner_match && clean === ctx.order.tracking_url)) issues.push('URL not from verified order data: ' + clean);
  }
  const allowedAmounts = new Set(FAQ_AMOUNTS);
  if (ctx.order && ctx.owner_match) {
    const o = ctx.order;
    [o.subtotal, o.shipping_fee, o.cod_fee, o.total].forEach((a) => allowedAmounts.add(a));
    (o.items || []).forEach((i) => { allowedAmounts.add(i.unit_price); allowedAmounts.add(i.unit_price * i.qty); });
    allowedAmounts.add(o.total - o.shipping_fee - o.cod_fee);
    if (o.refund_status) (o.refund_status.match(/\d[\d,]*/g) || []).forEach((a) => allowedAmounts.add(Number(a.replace(/,/g, ''))));
  }
  const amtRe = /(?:₹|\brs\.?|\binr|रु\.?)\s?(\d[\d,]*(?:\.\d+)?)/gi;
  let m;
  while ((m = amtRe.exec(text)) !== null) {
    const a = Number(m[1].replace(/,/g, ''));
    if (!allowedAmounts.has(a)) issues.push('amount ₹' + a + ' not found in order/FAQ data');
  }
  if (/\b(will|can|may|helps?( to)?|should) (cure|treat|heal|clear up|get rid of)\b/i.test(text)) issues.push('possible medical claim');
  if (/\b(approved|has been refunded|refund (is|has been) (approved|processed))\b/i.test(text) && !(ctx.policy && ctx.policy.eligible)) issues.push('promises a refund approval the policy has not granted');
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text)) issues.push('contains emoji');
  if (!/Team Kesar\s*$/.test(text.trim())) issues.push('missing brand sign-off');
  return issues;
}

/* ------------------------------------------------------------------ */
/* 9. Ticket de-duplication (Tickets tab)                               */
/* ------------------------------------------------------------------ */

/**
 * rows: existing Tickets rows. Returns { op: 'append'|'update', row }.
 * One open ticket per order: a new email on the same order updates it.
 */
function upsertTicket(rows, t, nowIso) {
  const open = (rows || []).find((r) => r.order_id === t.order_id && String(r.status || '').toLowerCase() !== 'closed');
  if (open) {
    const ids = String(open.email_ids || '').split(/[,;\s]+/).filter(Boolean);
    if (!ids.includes(t.email_id)) ids.push(t.email_id);
    const rank = { Low: 0, Medium: 1, High: 2 };
    const priority = (rank[t.priority] || 0) > (rank[open.priority] || 0) ? t.priority : open.priority;
    const note = '[' + nowIso + '] ' + t.email_id + ': ' + t.summary;
    return {
      op: 'update',
      row: Object.assign({}, open, { updated_at: nowIso, email_ids: ids.join(', '), priority, notes: (open.notes ? open.notes + '\n' : '') + note }),
    };
  }
  // ID is unique without a global counter: TKT-<order digits>-<n-th ticket for this order>
  const n = (rows || []).filter((r) => r.order_id === t.order_id).length + 1;
  return {
    op: 'append',
    row: {
      ticket_id: 'TKT-' + t.order_id.replace(/^KC-/, '') + '-' + n, created_at: nowIso, updated_at: nowIso,
      order_id: t.order_id, customer_email: t.customer_email, email_ids: t.email_id, intent: t.intent,
      priority: t.priority, status: 'Open', summary: t.ticket_summary, notes: '[' + nowIso + '] ' + t.email_id + ': ' + t.summary,
    },
  };
}

function ticketSummary(cls, order, policy) {
  const items = order ? order.items.map((i) => i.name).join(', ') : '';
  const label = {
    damaged: 'Damaged item', leaking: 'Leaking item', wrong_item: 'Wrong item delivered', missing_item: 'Missing item',
    change_of_mind: 'Return request (change of mind)', not_suitable: 'Refund request (product did not suit)',
  }[cls.issue_type] || (cls.intent === 'complaint' ? 'Complaint' : 'Return/refund request');
  const elig = policy && policy.eligible === true ? 'ELIGIBLE' : policy && policy.eligible === false ? 'NOT ELIGIBLE' : 'CHECK';
  return (label + ' — ' + items + ' — policy: ' + elig + (policy && policy.reasons.length ? ' (' + policy.reasons.join('; ') + ')' : '')).slice(0, 300);
}

if (typeof module !== 'undefined') {
  module.exports = {
    INTENTS, CONFIDENCE_THRESHOLD, parseJsonLoose, validateClassification, repairClassification, fallbackClassification,
    extractOrderIds, riskFlags, findOrder, publicOrderView, daysBetween, policyDecision, decideRoute, splitFaq, searchFaq,
    templateReply, checkDraft, upsertTicket, ticketSummary, firstName,
  };
}
