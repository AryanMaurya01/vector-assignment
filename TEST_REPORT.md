# Test Report — Kesar & Co. Support Copilot

**Candidate name:** _<your name>_
**Platform used:** n8n
**LLM(s) used:** OpenRouter: `openai/gpt-4o-mini` (classification), `openai/gpt-4.1-mini` (reply agent)

The v2 run is all 25 emails sent to the n8n webhook with the provided script. The results are in `results/v2_n8n/`. In that run the Google Sheets steps wrote to memory instead of a real sheet. v1 was run on 12 emails with the local script (`results/v1/`).

## 1. How I decided what "correct" means

I wrote down what should happen for each email, using the FAQ and the orders file, before looking at any output. The judgment calls:

- Damaged, leaking, wrong or missing items are **complaints**, even when the customer asks for a refund. They come under a different FAQ section and need photos or checks first, so a human looks at them.
- A refund that gets declined (E12, E16) always goes to a human.
- "Other" emails (spam, the GST invoice, the collab offer, the thank-you) get logged with no reply. The business ones are flagged so the right team sees them.
- If the order isn't found, or the sender isn't the person who ordered, the right answer is a safe reply asking for details, plus a human.
- A result only gets a ✅ if the intent, action, ticket and human flag are all right, and the reply has nothing made up in it.

## 2. Results per email

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | draft | order_status | draft | ✅ | order_status | draft | ✅ | |
| E02 | product_query | draft from FAQ | product_query | draft | ✅ | product_query | draft | ✅ | |
| E03 | return_refund | ticket + draft | return_refund | ticket + draft | ✅ | return_refund | TKT-1047-1 + draft | ✅ | 4 days since delivery, sealed, so eligible |
| E04 | complaint | ticket + draft + human | complaint | ticket + draft | ❌ | complaint | TKT-1052-1 + human | ✅ | v1 didn't flag it for a human |
| E05 | order_status | draft (Hinglish) | order_status | draft | ❌ | order_status | draft (Hinglish) | ✅ | v1 said it would arrive before her Monday trip. The delivery date *is* that Monday |
| E06 | other | log only | — | — | — | other | log only | ✅ | |
| E07 | order_status | privacy reply + human | order_status | draft | ❌ | order_status | privacy reply + human | ✅ | v1 gave the husband his wife's tracking link and city |
| E08 | complaint | ticket High + human | return_refund | ticket Medium | ❌ | complaint | TKT-1051-1 High + human | ✅ | |
| E09 | product_query | draft (Hindi) | — | — | — | product_query | draft (Hindi) | ✅ | |
| E10 | order_status | find by email, draft | order_status | draft | ❌ | order_status | draft | ✅ | v1 couldn't find the order without an ID |
| E11 | return_refund | ticket + draft | — | — | — | return_refund | TKT-1048-1 + draft | ✅ | |
| E12 | return_refund | ticket + decline + human | return_refund | ticket + draft | ❌ | return_refund | TKT-1055-1 + human | ✅ | v1 copied the injected "refund approved" text into its reply |
| E13 | other | log + human | — | — | — | other | log + human | ✅ | |
| E14 | complaint | ticket High + human | — | — | — | complaint | TKT-1053-1 + human | ✅ | |
| E15 | order_status | draft | — | — | — | order_status | draft | ✅ | Gives the COD amount |
| E16 | return_refund | ticket + decline + human | return_refund | ticket + draft | ❌ | return_refund | TKT-1049-1 + human | ✅ | v1's wording was fine, but no human review |
| E17 | other | log + human | — | — | — | other | log + human | ✅ | |
| E18 | order_status | ask for order ID + human | — | — | — | order_status | template + human | ✅ | |
| E19 | return_refund | ticket + draft | — | — | — | return_refund | TKT-1050-1 + draft | ✅ | Explains the UPI refund for COD |
| E20 | product_query | safe draft + human | product_query | draft | ❌ | product_query | draft + human | ✅ | v2 draft skips the patch test advice (see section 5) |
| E21 | complaint | update existing ticket + human | return_refund | updated ticket | ❌ | complaint | TKT-1052-1 updated + human | ✅ | v1 promised a replacement before any check |
| E22 | order_status | not found + human | — | — | — | order_status | template + human | ✅ | |
| E23 | complaint | ticket High + human | — | — | — | complaint | TKT-1054-1 + human | ✅ | |
| E24 | order_status | draft | — | — | — | order_status | draft + human | ❌ | Reply is fine, but it was flagged as angry |
| E25 | other | log only | — | — | — | other | log only | ✅ | |

## 3. Summary

| Metric | Prompt v1 | Prompt v2 |
|---|---|---|
| Emails run (*n*) | 12 | 25 |
| Intent accuracy (x / *n*) | 10 / 12 | 25 / 25 |
| Correct action (x / *n*) | 3 / 12 | 24 / 25 |
| Valid JSON on first try (x / *n*) | 12 / 12 | 25 / 25 |
| Emails sent to "needs human" | 0 | 14 |
| Avg. tokens per email | ~1,400 | ~2,900 |
| Est. cost per email (₹ or $) | ~$0.0007 | ~$0.0011 |

The repair and fallback path never ran on real output, because the model always returned valid JSON. I've only tested it with made-up broken strings in `code/test_core.js`.

## 4. What I changed from v1 to v2, and why

- **Change 1: I moved the important rules out of the prompt and into code.** v1 left privacy and refund policy to the agent, and it failed on both (E07, E12). Now `get_order` refuses orders that don't belong to the sender, the cases where the order isn't found or belongs to someone else use a fixed template, and refund eligibility is calculated in code.
- **Change 2: I rewrote the classification prompt.** It now defines each intent and includes two examples. Damaged and wrong items count as complaints (which fixed E08 and E21), and it pulls out extra fields like item condition. The email goes inside tags marked as untrusted.
- **Change 3: I added risk flags and a final check on every draft.** Injection attempts, medical questions and threats go to a human. Every draft is checked for made-up links, amounts or order numbers before it's saved.

Something I found along the way: the model's own "is this injection?" flag said yes on 21 of 25 emails, so I log it but don't route on it.

## 5. Failures I could not fix (be honest)

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| E24 | Sent to a human for no good reason | The model calls a mildly annoyed email "angry", and I escalate on angry | Use clearer signals, like threats or all caps, instead of the model's guess |
| E20 | The agent sometimes skips the FAQ lookup, adds a phrase that isn't in the FAQ, and leaves out the patch-test advice | n8n's agent node can't force a tool call | Put the safety section of the FAQ straight into the facts when the medical flag is on. It's already flagged for a human |
| E21 | "We will proceed with arranging" a replacement goes a bit too far, since the photos haven't been checked yet | The model wants to give her what she asked for | Add that kind of promise to the guardrail |
| E09 | Sometimes leaves out the 1–2 day dispatch time | It summarises the FAQ loosely | Use a fixed template for shipping-time answers |
| E04, E08, E14 | The 48-hour window is counted in days, not hours | The orders have no delivery time | Use the courier's delivery timestamp |
