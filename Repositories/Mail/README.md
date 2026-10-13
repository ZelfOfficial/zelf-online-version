# Mail — Jim inbound (jim@mg.zelf.world)

## Endpoints
| Method | Path | Auth |
|---|---|---|
| POST | `/api/mail/inbound/jim` | Mailgun signature (HMAC-SHA256 of `timestamp+token`, ±`JIM_INBOUND_MAX_SKEW_SEC`, token single-use) |
| GET | `/api/mail/inbound?status=&since=&classification=&limit=` | `x-jim-inbox-key: $JIM_INBOX_API_KEY` or `Authorization: Bearer $JIM_INBOX_API_KEY` (constant-time compare, 503 if unset, 401 if wrong) |
| GET | `/api/mail/inbound/:id` | same (JIM_INBOX_API_KEY): full body, headers, attachment metadata and inline bytes |
| PATCH | `/api/mail/inbound/:id` `{status?, action?, note?}` | same (JIM_INBOX_API_KEY): appends to `actionLog` |
| POST | `/api/mail/webhook` | Mailgun signature. Acknowledges `{ received: true, stored: false }` and does not persist. Inbound mail uses `/api/mail/inbound/jim`. |

Every signed message to `JIM_INBOUND_RECIPIENTS` is stored (`InboundEmail` collection). The
`JIM_INBOUND_ALLOWED_SENDERS` list only sets `senderAllowed`, which gates actions. Staff invites
(`/auth/accept-invite?token=`) are classified and validated, **never auto-accepted** (acceptance needs a live face).
A short notification (masked token, 280-char snippet) goes to `JIM_INBOUND_FORWARD_URL` (signed with
`X-Jim-Timestamp` and `X-Jim-Signature` = HMAC-SHA256(`JIM_INBOUND_FORWARD_SECRET`, `ts.body`)), else to `JIM_INBOUND_DISCORD_WEBHOOK_URL`.

Attachments: sha256 and metadata always. Bytes are stored inline only for pdf/ics/txt/csv/images ≤ 2 MB.
When the route also calls `store()`, files missing from the forward (or not inlined) are filled in the background from `message-url` with `MAILGUN_API_KEY`. Downloads stop at 8 MB; larger files keep `mailgunUrl` and the size Mailgun reported. The koa-body form limit is 6 MB.

## Mailgun setup (Receiving → Routes)
Inbound MX for `mg.zelf.world`: `mxa.mailgun.org` and `mxb.mailgun.org`, priority 10.

Production route, priority 0:
```
Expression: match_recipient("jim@mg.zelf.world")
Actions:    forward("miguel@zelf.world")
            forward("https://v4.zelf.world/api/mail/inbound/jim")
            store()
            stop()
```
Dev route, priority 1:
```
Expression: match_recipient("jim-dev@mg.zelf.world")
Actions:    forward("https://<dev-host>/api/mail/inbound/jim")
            store()
            stop()
```
The signing key is in Sending → Webhooks → HTTP webhook signing key → `MAILGUN_WEBHOOK_SIGNING_KEY`.

The mailbox endpoints do **not** accept the super-admin key or JWT. `JIM_INBOX_API_KEY` is scoped to them only.
