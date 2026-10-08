# Audit review for SDO and School Portal

Reviewed and updated October 8, 2026 (Asia/Manila).

## Result

The previous audit trail was not sufficient for resolving disagreements. Several daily writes had no audit event; profile events did not retain old and new values; the affected school could disappear after an account was deleted or reassigned; and school activity searches failed with native database prepares.

Authenticated writes through the listed endpoints now record an operation outcome, actor/account side, affected record, school snapshot where available, server time, and request reference. Identified records include sanitized before/after changes. Existing login, logout, upload and other business events remain available; multiple entries with the same request reference belong to one request.

## Coverage

| Daily operation | Evidence recorded |
| --- | --- |
| SDO and school login/logout | Existing success/failure events now retain available actor and school identity snapshots. School registration, successful verification and known-account verification/resend failures also have events. Verification codes and session tokens are excluded. |
| School access approval, revocation, activation and deletion | SDO actor, target account, successful/rejected outcome; identified account changes survive later renaming, reassignment and deletion. Password/session fields are excluded. |
| School personal/profile/logo edits | Account and linked school changes, including old/new school name, head/contact details and district when changed. Photos are represented by fingerprints. Existing locked rows provide the baseline for profile changes. |
| Public/private school directory and personnel directory | Operation outcome and identified row changes; public/private school identifiers remain separate. Public school edit baselines use the existing transaction lock. |
| School submissions, calendar, tuition and permit actions | Draft saves, edits, uploads, submissions and deletion requests are journaled. Identified document/submission rows retain changed values; permit response submission IDs are included. Linked document rows are included when referenced by a submission. |
| SDO submission review | Status, remarks, reviewer/date and other changed submission fields. The submitting school user can review the SDO decision in their own activity page. |
| Programs, imported records and responses | Create/update/delete/save outcomes and identified row changes. Bulk request IDs are captured within the limits below. |
| Certificates, checklists, indorsements, tracker and announcements | Authenticated write outcomes, available record/reference IDs and changed rows where the endpoint supplies an identifiable record. Aggregate saves without a primary record ID have a request summary rather than a complete per-row diff. |
| Report settings, questions/categories/columns and sequence management | Identified row changes; keyed evaluation settings and global/workshop speaker display settings retain before/after values. Bulk sequence assignment results are retained as bounded reference data. |
| Evaluation reminders | Shared SDO authentication, requested workshop/participants, request outcome and returned sent/failed counts. A successful request is not proof that every email was delivered. |
| Audit export | Export event and selected filters; CSV includes saved identity, changes and request references. |

## Review a disagreement

1. SDO opens **Audit Logs**, selects the affected public/private school and date range, and optionally filters by account side, module or actor.
2. Expand an entry to compare **Before** and **After**, actor, result and record ID. Search by request reference to relate the detailed operation event to its business events.
3. School users open **Audit Logs** to review their actions, decisions on their own submissions, and approved shared school-record changes. Other users' personal account values and unrelated schools' records are not exposed.
4. Export the filtered SDO history for review when needed. Make any agreed correction through the normal application form so the correction creates a new audit event.

## History protection and limits

- The API is read-only. Database triggers reject UPDATE and DELETE against audit history. The SDO page shows **History protection active** when both triggers are present. This was verified on disposable local databases; deployment must be checked separately.
- The database account needs CREATE/ALTER for schema initialization and TRIGGER permission to install protection. A database administrator can still drop triggers or alter the database directly; this is not cryptographic tamper evidence. Keep independent database backups.
- Logging failures are reported to the server error log and do not stop daily business operations. Review those errors; the protection indicator checks trigger presence, not delivery of every audit insert.
- This change cannot reconstruct actions or original identities that were never logged. Legacy entries use current account/school data when historical snapshots are absent.
- Routine reads, polling and every document download are not comprehensively journaled. Direct SQL edits, unauthenticated public evaluations and legacy endpoints outside the authenticated write allowlist are outside this operation journal.
- Large values/images use SHA-256 and byte counts. Secret-like keys are removed. Nested data is bounded to eight levels and 200 members; bulk row baselines are limited to 50 IDs. This is review evidence, not a document archive or restore mechanism.
- Most record comparisons use a request-entry baseline and a post-operation read; they do not provide transaction serialization for every endpoint or prevent simultaneous edits. Profile/account approval/public school edits also use their existing locked-row baselines. Treat the sequence together with record IDs and timestamps when investigating concurrent work.

## Validation

- **168 passing HTTP/database integration checks**, including registration, verification, school/SDO permission boundaries, profile synchronization, approval/deletion, program and draft-calendar edits, report/speaker settings, failed reminder validation, submission decisions, preserved historical identity, scoped activity searches, CSV export, schema repair, rollback and audit mutation rejection.
- **107 PHP files** passed syntax validation; the final helper/reminder changes were checked again. The three changed audit JavaScript files passed syntax validation.
- **Six passing JavaScript checks** across the deletion handler and audit renderer, including rejection/network failures and escaping stored audit content.
- Browser review confirmed before/after details on the SDO page and an SDO return-for-correction decision on the school page. Screenshots in `tests/proof/` use synthetic records only.
- Tests copy schema into random disposable databases, use fake email delivery and clean up their runtime copies. Real accounts, submissions and SMTP deliveries were not modified.

Repeat with `php tests/school-portal-integration.php`, `node tests/audit-details.test.cjs`, and `node tests/user-management-delete.test.cjs`.

## Deployment

Upload the contents of `deployment/audit-log-fixes-2026-10-08.zip` into Hostinger's `public_html`, preserving the directories below. It contains application files only, with no credentials, tests, uploaded documents or database dump.

```text
api/audit_logs.php
api/evaluation_monitoring.php
api/public_schools.php
api/school-portal-activity.php
api/school-portal-profile-update.php
api/school-portal-register.php
api/school-portal-verify.php
api/user_management.php
config/audit_log.php
config/audit_operations.php
config/auth_middleware.php
css/audit-logs.css
js/audit-details.js
js/audit-logs.js
js/school-portal-audit.js
audit-logs.html
school-portal-audit.html
```

After uploading, refresh the audit pages, confirm **History protection active** on the SDO side, and use designated test records to verify a school edit and an SDO submission decision. The missing audit columns and triggers initialize automatically outside business transactions. If protection needs setup, resolve the deployed database permission rather than assuming the history is protected. The Hostinger deployment has not been changed by this local review.
