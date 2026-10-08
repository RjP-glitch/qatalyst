# School portal fixes

Completed October 8, 2026 (Asia/Manila).

## Outcome

All ten issues identified in the school portal review have been addressed. School registration now creates one **School User** account type. There is no self-selected School Administrator role. SDO personnel confirm the person's school affiliation before enabling school record edits and shared school features.

## SDO approval for existing and new accounts

1. Open **SDO User Management → School Portal Users**.
2. Confirm that the person's selected school and affiliation are correct.
3. Click **Approve school access** and confirm the displayed school.
4. Have the school user refresh their dashboard or sign in again.

The approval control requires an active account, verified email, and a valid active school link. **Revoke school access** takes effect on existing sessions immediately at the API. The next dashboard refresh updates the visible controls.

The three existing school accounts have not been automatically approved. Their account identities and school records were preserved. SDO should review each affiliation using the steps above. Approval uses the existing permissions field; no database migration is required.

## Resolved findings

| Issue | Implemented correction |
| --- | --- |
| School registration could grant SDO administrator privileges | Server forces the existing teacher storage role, displayed as School User. SDO permissions require an SDO account. |
| Self-selected school affiliation allowed shared edits | Active school/district validation plus explicit SDO approval for school edits and shared school data. Registration cannot change school levels. |
| Unverified users could use full sessions | Login returns a verification challenge until email is verified. Protected portal APIs also enforce verification. |
| Verification overwrote the SDO session | Verification sets only the school session cookie and returns the correct public/private school identity. Logout also preserves the other application's session. |
| District names and IDs diverged | School and SDO public directory saves validate the district and update its name, ID, and linked users together. Historical submission district snapshots remain unchanged. |
| Custom registration produced an unlinked account | Registration requires an existing active school. Missing schools must be added by SDO. Fake fallback school/district choices were removed. |
| Missing links could update the opposite school table | Resolution uses only the explicitly linked public/private table. Missing or inactive links block shared features and edits. |
| SDO submissions showed an outdated public school name | Listing and search read the current linked public/private school name. |
| Failed school saves could leave personal details changed | User and school edits commit together; errors roll back both. Unsupported fields return validation errors. |
| Expired verification had no usable recovery | Sign-in renews the challenge and sends a new code. Resend and incorrect-attempt limits are enforced. Delivery failures are reported honestly. |

School head names/emails belong to the school directory and are explicitly labeled separately from the person's login identity. The personal employee/staff number is also separate from the school's DepEd ID. Accounts awaiting approval can update their own photo and staff number, while school fields and shared features remain restricted.

The SDO directory reloads when the tab becomes visible, while preserving an open edit dialog. It can also be refreshed manually; changes are not pushed continuously into an already-visible screen.

## Validation

- **80 passing HTTP/database integration checks** against copied schema in random disposable local databases, covering public/private registration, login, verification, cross-application authorization, approval/revocation, atomic saves, district synchronization, school naming, and session isolation.
- **103 PHP files** and **14 relevant JavaScript files** passed syntax checks; files receiving final cleanup were checked again.
- Browser checks confirmed a pending account could save its personal staff number while school fields stayed disabled.
- Browser checks changed an approved public test school's name and district, then confirmed both appeared in the SDO directory. SDO User Management displayed affiliation, approval status, and approve/revoke actions correctly.
- Disposable test databases, servers, and runtime copies were cleaned up. Tests did not change real school/user records and did not send real emails.

Actual SMTP delivery remains unverified: the integration suite uses a fake email sender. Configured SMTP should be checked with a designated test mailbox before relying on email delivery.

## Repeat testing

Run `php tests/school-portal-integration.php` or `npm run test:school-portal` from the project directory. PHP needs PDO MySQL and access to the configured local database. The database user needs permission to create/drop the suite's guarded random test database. The suite copies schema only, uses synthetic records and a fake mailer, and cleans up after completion.

Browser proof images are in `tests/proof/`: `school-profile-pending.png`, `school-profile-approved.png`, and `sdo-directory-synced.png`. All show disposable test records.

## School approval notifications

SDO personnel with User Management permission now receive a **School account awaiting approval** notification for active, email-verified users linked to an active school. Existing verified accounts awaiting approval are included. A successful verification records its event time in the existing audit log; no schema migration is required.

The notification opens the School Portal Users tab and isolates the exact account for review. Clearing the search restores the normal user list. Approval removes the pending notification and refreshes the notification bell. Marking an alert as read does not approve the account.

The expanded integration suite passed **92 checks**, including verification-triggered alerts, existing accounts, unread status, access restrictions, duplicate prevention, deactivated accounts, and notification removal after approval. Browser checks confirmed the notification dropdown, the exact account link, and normal search after clearing the filter. No real accounts were approved or edited.

## Account deletion request fix

The Delete button sent an empty POST while the API required JSON, causing `Invalid JSON request.` before deletion ran. The button now sends `{}`; the API also accepts an empty body specifically for deletion so cached pages remain compatible. Other actions still require JSON, and malformed deletion JSON is rejected. Successful deletion refreshes the user list and notification bell. The deletion handler now also applies the existing role hierarchy, preventing non-admin user managers from deleting administrators.

The integration suite passed **105 checks**, including both request formats, session revocation, preservation of the linked school, authorization, self-deletion, role hierarchy, and rejected-request behavior. Run `node tests/user-management-delete.test.cjs` for three additional page-handler checks covering the outgoing JSON, success refreshes, server rejection, and connection failure. All deletion tests use disposable accounts.

Deploy `api/user_management.php` and `js/user-management.js` together, then refresh the browser. No database migration is needed.

## Program page access fix

The legacy authentication query in `api/programs.php` selected only ID, role, and permissions. It omitted `account_type`, which the shared permission check now requires. This denied every program request, including SDO administrators, across QATAME, QMS, SBM, SGC, SDO PIR, and School PIR. The failure was reproduced with a disposable administrator before the fix.

Programs now use `authenticate('sdo_personnel')`, preserving the full server-side identity, active-account checks, cookie isolation, and bearer-token support. Program permissions still apply. No stored roles, permissions, programs, or imports are modified.

The expanded integration suite passed **126 checks**, including container and standalone import results for all six page filters, SDO administrator and explicit permission access, mixed cookies, anonymous and school-account rejection, and inactive accounts. Each test uses copied schema and synthetic records in a disposable database. Deploy only `api/programs.php` for this fix; no database migration is needed.
