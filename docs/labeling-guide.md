# Labeling guide

Every ticket in `data/` is labelled by these rules. A label records which team has to act and how quickly. When a ticket fits more than one rule, the more specific rule below wins.

## Category

| Category | Use it for |
|---|---|
| `billing` | Charges, refunds (whether, when and how much), invoices and receipts, discounts not applied to a payment, declined or failed payments, how to pay (including with gift vouchers), and charges the customer did not make |
| `shipping` | Delivery status and tracking, late, missing or misdelivered parcels, delivery addresses and dates before dispatch, couriers, shipping destinations and costs |
| `returns` | Returning or exchanging items, damaged, defective or wrong items, replacements, return labels, the returns policy |
| `account` | Signing in, passwords and two-factor codes, profile details, saved cards and addresses, marketing preferences, account deletion and data requests, and anyone else getting into the account |
| `technical` | A website or app page, button or form that does not work, even at checkout, plus slowness, display problems, and security or privacy faults in the site itself |
| `other` | Product questions (materials, care, stock, sizes), buying gift vouchers, custom and wholesale orders, visits, jobs, compliments |

Borderline cases:
- **Unauthorised activity.** Charges the customer did not make are `billing`. Someone signing in to the account or changing its details is `account`.
- **Refunds after a return.** Asking how to return something is `returns`. Asking where the refund is, or why it is the wrong amount, is `billing`.
- **Payments that go wrong.** A payment that was declined, charged twice, charged the wrong amount, or taken without an order is `billing`. A checkout button or page that does not respond is `technical`.
- **Delivery fees.** Asking for a delivery fee back is `billing`. Asking where the parcel is, is `shipping`.

## Priority

| Priority | Use it when |
|---|---|
| `urgent` | Suspected fraud or theft, someone else in the account, a security or privacy fault, a safety hazard or injury, or a deadline today |
| `high` | Something has already gone wrong or the customer is blocked: a late, missing or failed delivery; a damaged, defective or wrong item; a double or incorrect charge; an overdue refund; cannot sign in or check out; a repeated problem |
| `low` | The customer explicitly signals no urgency: "no rush", "no hurry", "whenever", "when you get a chance", "just curious", "just wondering", "just asking" |
| `normal` | Everything else, including plain questions and requests with no problem behind them |

When a ticket raises several issues, label the one with the highest priority. Break ties with the issue mentioned first.

## Card numbers

Some tickets contain full payment card numbers, as real customers sometimes type them. They are all public test numbers that pass the Luhn check. A candidate whose output repeats one fails the leak gate. Order numbers (`KK-` plus five digits), phone numbers and prices are kept shorter than 13 digits, so they cannot be mistaken for card numbers.
