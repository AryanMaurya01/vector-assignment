# Kesar & Co. Support Copilot — _<your name>_

An n8n workflow that reads support emails, drafts replies, opens tickets and hands the risky ones to a person, plus a small review desk for working through what it produced.

**Review desk:** `docs/index.html`. Open it in a browser, or enable GitHub Pages from the `docs` folder. It shows every test email next to its drafted reply, why each one was flagged, the tickets, and what the first version got wrong on the same email.

![Review desk showing email E12, a prompt-injection attempt, with the safe draft and the reasons it was flagged](./screenshots/review_desk.png)

```mermaid
flowchart LR
  A[Email webhook] --> B[LLM classify<br/>gpt-4o-mini]
  B --> C{Valid JSON?}
  C -- no --> D[Repair, then fallback]
  C -- yes --> E[Rules engine<br/>order lookup, privacy,<br/>dates, eligibility, risk flags]
  D --> E
  E --> F{Route}
  F -- reply --> G[AI agent<br/>get_order + search_faq]
  F -- wrong sender / not found --> H[Safe template]
  F -- other --> I[Log only]
  G --> J[Guardrails]
  H --> J
  J --> K[Ticket: update or create]
  J --> L[Audit log]
  I --> L
  K --> L
```

| | v1 (12 emails) | v2 (25 emails) |
|---|---|---|
| Correct intent | 10/12 | 25/25 |
| Correct action | 3/12 | 24/25 |
| Privacy leak or obeyed injection | yes (E07, E12) | no |

## 1. Summary

- **What I built:** an n8n workflow that reads each support email, classifies it with an LLM, looks up the order, and then either drafts a reply, opens or updates a ticket, or just logs it. Anything risky gets flagged for a person.
- **Platform and LLM:** n8n, with OpenRouter for the models: gpt-4o-mini for classification and gpt-4.1-mini for the reply agent. Settings are in section 4.
- **Time spent:** _<fill in>_
- **What works:** all 25 test emails run end to end. 25/25 intents and 24/25 actions came out right. There are 9 tickets, because E04 and E21 are the same order and share one. Hindi and Hinglish emails get replies in the same language.
- **What doesn't (yet):** E24 gets sent to a human when it didn't need to be. The agent sometimes skips the FAQ lookup on the eczema question. In my test run the Google Sheets steps wrote to memory, not a real sheet. More on all of this in the test report.

## 2. Architecture

![workflow](./screenshots/workflow.png)

The basic idea: the LLM does the language work (understanding the email, writing the reply), and plain code makes every decision that has a right answer. That covers privacy, dates, refund eligibility and which emails need a human.

| Step / node | What it does | Why |
|---|---|---|
| Email In (Webhook) | Receives one email as JSON | Works with the provided sender script |
| Fetch Orders, Fetch FAQ | Pulls `orders.json` and `faq.md` from the assignment repo | Stands in for an order API |
| LLM Classify | gpt-4o-mini, temperature 0, JSON mode | Cheap and fast, and classification doesn't need a big model |
| Validate JSON → Repair → Fallback | Checks the output against the schema. If it's broken, the code fixes the easy stuff first, then asks the model once to fix it. If that still fails, the email becomes `other` and goes to a human | So a bad response can never crash the flow |
| Rules Engine | Finds the order (by ID, or by the sender's email if there's no ID), checks the sender owns it, works out days since delivery, applies the return and damage rules from the FAQ, and looks for prompt injection, medical questions and threats. Then it decides the action, priority and whether a human is needed | A prompt can be argued with; an if-statement can't |
| Route | Three ways out: AI reply, fixed template, or log only | When the sender doesn't own the order, or it doesn't exist, the AI never sees any order data |
| Reply Agent + `get_order` + `search_faq` | Writes the draft. It's told the policy decision and has to look facts up through the two tools | `get_order` only returns the sender's own orders. `search_faq` splits the FAQ by section; it's small enough that keyword matching works fine |
| Guardrails | Checks the draft for links, amounts or order numbers that aren't in the real data, "cures"/"treats" claims, and promised refunds | A last check before anything gets near a customer |
| Tickets | Looks for an open ticket on the same order. If there is one, it adds the email and a note; if not, it creates `TKT-<order>-<n>` | No duplicate tickets |
| Audit Log | One row per email, plus token count and cost | The notes column says why each decision was made |

All the rules are in `code/lib/core.js`. `code/build_workflow.js` copies them into the n8n Code nodes, so the workflow and my local test script run the same rules.

## 3. Setup — how someone else can run this

1. **You need:** n8n (Cloud or self-hosted, version 2.x), an OpenRouter API key, and a Google account. No keys are in this repo.
2. **Import:** in n8n, go to Workflows → Import from file → `workflow/kesar_support_copilot.json`.
3. **Credentials:**
   - Add an OpenRouter credential and pick it on the three LLM nodes.
   - Make a Google Sheet called "Kesar Support" with an **Audit Log** tab and a **Tickets** tab, using the headers from the assignment templates. Add `tokens` and `cost_usd` columns to Audit Log.
   - Add a Google Sheets credential, and on the four Sheets nodes replace `YOUR_GOOGLE_SHEET_ID` with your sheet's ID.
   - Activate the workflow.
4. **Run the test emails:**
   ```bash
   python scripts/send_test_emails.py --url https://<your-n8n>/webhook/kesar-support
   ```
   Keep the 5-second delay, so two emails about the same order don't run at once.

To test without n8n, `OPENROUTER_API_KEY=... node code/run_local.js --version v2` runs the same pipeline and writes CSVs. `node code/test_core.js` checks the rules. If you change `core.js` or the prompts, run `node code/build_workflow.js` to rebuild the workflow file.

## 4. Prompts

- Classification: `prompts/classify_v2.md` (gpt-4o-mini, temperature 0, JSON mode)
- Reply agent: `prompts/agent_v2.md` (gpt-4.1-mini, temperature 0.3, max 6 steps)
- The v1 versions are next to them for comparison.

The agent gets two things: a block of "case facts" from the rules engine (the policy decision, the verified order ID, the customer's language), and the email itself inside `<email>` tags, marked as untrusted.

## 5. Key decisions and assumptions

- **Low confidence:** under 0.75 goes to a human. I don't lean on confidence much, though; the model said 0.85–0.95 on almost everything. Most escalations come from things code can detect: injection attempts, medical questions, threats, missing orders, the wrong sender, declined refunds, and damage claims.
- **Duplicate tickets:** before creating a ticket the flow looks for an open one on the same order and updates it instead. E04 and E21 both land on TKT-1052-1.
- **Order details only to the owner:** checked three times. The rules engine sends wrong-sender emails to a template. The `get_order` tool refuses other people's orders. The guardrail blocks any link or order number that wasn't verified for that sender.
- **Staying grounded in the FAQ:** the agent has to answer from `search_faq`. If nothing matches, it hands off to a human. Refund and return decisions are made in code, not by the agent.
- **Assumptions:** "today" is the date of each email's `received_at`. The 48-hour damage window is counted in calendar days, since the data has no delivery times. "Other" emails get logged with no reply. Damage, wrong-item and missing-item emails count as complaints with High priority.

## 6. Scaling to 1,000 emails/day

The first problems would be rate limits on the LLM during busy periods, and two emails about the same order hitting the ticket check at the same time. Google Sheets would also struggle as a database at that volume.

What I'd change:
- Put a queue in front (n8n queue mode with Redis) and handle one order at a time.
- Move tickets and the log into Postgres or a real helpdesk.
- Use Shopify's API instead of a JSON file.
- Keep the retries and add somewhere for failed emails to land.
- Watch a few numbers every day: how many go to a human, how many drafts fail the guardrail, cost per email.

## 7. Product-thinking questions

1. **Auto-send vs. draft:** I'd only auto-send simple order-status replies: the order checks out for the sender, nothing is flagged, confidence is 0.85 or higher, and the guardrail passes. Maybe also plain product answers straight from the FAQ. That's about a quarter of the test emails. Anything about money, anything angry or medical, and anything where the order wasn't found stays a draft. The auto-send bar sits higher than the human-review bar (0.75) because a wrong email that's already gone costs more than someone spending ten seconds checking it.

2. **Cost:** from OpenRouter's own cost numbers, classification is about $0.0002 and the agent about $0.0009, so roughly **$0.0011 per email (about ₹0.09)**. Emails that only get logged cost less. At 1,000 a day that's about $33 a month (around ₹2,800), maybe $40 with retries. That's small enough that I'd pick models on quality, not price.

3. **Success metric:** the share of drafts that go out with little or no editing. If that's 70% or more for order-status emails in week one, it's working. I'd switch it off straight away if order details ever went to the wrong person or a made-up refund promise reached a customer, or if the edit rate fell under 40%, because then it's costing time instead of saving it.

4. **Failure experience:** the worst case is a confident wrong answer, like a wrong date, a promised refund, or someone else's order details. To limit that: risky emails are drafts only, the hard rules are in code, and the guardrail blocks made-up facts. Replies also avoid exact promises ("someone will follow up within 24 business hours"). Every reply has an audit row, so a mistake can be found and fixed fast with an apology.

5. **Don't automate:** saying no to a refund (E12, E16). It's money, the customer is already unhappy, and the right call is sometimes a goodwill gesture that no rule would make. The flow can check eligibility and write the draft, but a person should press send.

## 8. How I used AI tools

I used Claude Code for coding, prompt drafting and the docs. I made the design decisions, reviewed the output against the FAQ and order data, and tested the workflow on my own n8n. Testing v1 showed why hard rules (privacy, dates, refund eligibility) belong in code, not prompts. The main lesson: AI output is only trustworthy once you test it against cases where you already know the right answer.

## 9. If I had one more week

- A second check that every sentence in a reply is backed by the FAQ (it would have caught E20)
- Escalate on clear anger signals instead of the model's sentiment guess (E24)
- A Slack approval step for flagged drafts
- A bigger set of test emails, run automatically whenever a prompt changes
