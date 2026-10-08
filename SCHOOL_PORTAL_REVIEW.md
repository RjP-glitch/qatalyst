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
