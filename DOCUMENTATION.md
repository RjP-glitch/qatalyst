# QATALYST — System Documentation

> **Quality Assurance, Technical Assistance, Learning, and Systems Tracking**  
> Developed for the Schools Division Office (SDO) of Baliwag, Philippines — SMME Department

**Version:** 1.2.9  
**Last Updated:** May 18, 2026

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Technology Stack](#2-technology-stack)
3. [System Requirements](#3-system-requirements)
4. [Installation & Setup](#4-installation--setup)
5. [Project Structure](#5-project-structure)
6. [Database Schema](#6-database-schema)
7. [Authentication & Authorization](#7-authentication--authorization)
8. [API Reference](#8-api-reference)
9. [Frontend Pages](#9-frontend-pages)
10. [Key Features](#10-key-features)
11. [Third-Party Integrations](#11-third-party-integrations)
12. [Configuration](#12-configuration)
13. [Deployment Notes](#13-deployment-notes)

---

## 1. Project Overview

**QATALYST** (also referred to internally as *SMME Monitoring System* or *QRES — Quality Reporting and Evaluation Systems*) is a web-based evaluation and monitoring platform that manages the complete lifecycle of training workshop evaluations:

- **Creating** workshops and programs
- **Collecting** participant evaluation responses via online forms
- **Computing** rating averages across configurable categories
- **Analyzing** data using the QAME methodology (Quality, Appropriateness, Management, Effectiveness)
- **Generating** reports (DOCX) and certificates (PDF)
- **Monitoring** participation and sending email reminders
- **Importing** legacy evaluation data from Excel spreadsheets

The system supports two parallel evaluation workflows:
1. **Online Evaluations** — Configurable per-workshop question forms with real-time response tracking
2. **Excel Import** — Legacy data import from `.xlsx` spreadsheets with auto-detection of scales and configurable column mapping

---

## 2. Technology Stack

| Layer | Technology | Details |
|---|---|---|
| **Backend** | PHP 8.2+ | Vanilla PHP (no framework), flat API architecture |
| **Database** | MariaDB 10.4+ | MySQL-compatible, database name: `evaluation_db` |
| **Frontend** | HTML / CSS / JavaScript | Vanilla (no SPA framework), per-page JS controllers |
| **Web Server** | Apache (XAMPP) | With `.htaccess` support for API routing |
| **PHP Libraries** | PHPMailer 7.x | Email via Gmail SMTP |
| | PhpSpreadsheet 4.x | Excel file import/parsing |
| | Smalot PdfParser 2.x | PDF text extraction for checklist scanning |
| | PhpWord 1.x | Word document parsing |
| | Tesseract OCR 2.x | OCR text extraction from images |
| **Node.js** | Express 5.x + `docx` 9.x | DOCX report generation (runs as a separate service) |
| **AI** | OpenAI GPT API | AI-powered feedback summarization |
| **Package Management** | Composer (PHP), npm (Node.js) | Dependency management |
| **Fonts** | Google Fonts | Outfit, Plus Jakarta Sans |
| **Icons** | Font Awesome 6.5 | UI iconography |

---

## 3. System Requirements

- **XAMPP** (or equivalent Apache + MariaDB/MySQL + PHP 8.2+ stack)
- **Node.js** (v18+ recommended) — required for DOCX report generation
- **Composer** — PHP dependency manager
- **npm** — Node.js package manager
- **Gmail Account** — with App Password for SMTP email sending
- **AI provider keys** — for AI feedback features (`GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_KEY` / `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`)

---

## 4. Installation & Setup

### 4.1 Clone / Copy the Project

Place the project in your web server's document root:
```
C:\xampp\htdocs\public_html\
```

### 4.2 Install PHP Dependencies

```bash
cd C:\xampp\htdocs\public_html
composer install
```

This installs:
- `phpmailer/phpmailer` — Email sending
- `phpoffice/phpspreadsheet` — Excel file processing
- `smalot/pdfparser` — PDF text extraction
- `phpoffice/phpword` — Word document parsing
- `thiagoalessio/tesseract_ocr` — OCR text extraction

Validation checks:
- Ensure `vendor/autoload.php` exists after install
- Confirm package versions in `vendor/composer/installed.json`
- Run `composer show --locked` to inspect resolved package versions from `composer.lock`

### 4.3 Install Node.js Dependencies

```bash
npm install
```

This installs:
- `express` — HTTP server for report API
- `docx` — Word document generation
- `cors` — Cross-origin request handling
- `@supabase/supabase-js` — (if applicable)

Validation checks:
- Ensure `node_modules/` exists
- Run `npm list --depth=0` to inspect installed runtime packages

### 4.4 Import the Database

1. Open **phpMyAdmin** (http://localhost/phpmyadmin)
2. Create a new database named `evaluation_db`
3. Import the SQL dump file: `migrations/u906274725_eval_db.sql`
4. Alternatively, run migration files from the `migrations/` directory

### 4.5 Configure Database Connection

Copy `.env.example` to `.env` and fill in the database values before starting Apache/PHP.

```env
DB_HOST=localhost
DB_NAME=evaluation_db
DB_USER=root
DB_PASS=
DB_PORT=3306
FILE_ENCRYPTION_KEY=generate_a_long_random_value
```

`config/database.php` loads these values with `vlucas/phpdotenv` and stops the application if `.env` or `FILE_ENCRYPTION_KEY` is missing. Keep database credentials out of frontend files and out of git history.

### 4.6 Configure Frontend Base URL

`js/config.js` auto-infers `CONFIG.BASE_URL` from the current page URL.

- **Typical local dev:** no changes needed (it will infer `http://localhost/<folder>`)
- **Production / fixed base path:** replace `BASE_URL: inferBaseUrl()` with a fixed string (example below)

Example override:
```javascript
BASE_URL: 'https://yourdomain.com/qatalyst'
```

### 4.7 Configure Email (PHPMailer)

Store sensitive values in `.env` or server environment variables instead of hardcoding them in PHP files.

Typical values used by the backend include:
- Database connection values: `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`
- File encryption key: `FILE_ENCRYPTION_KEY`
- AI provider keys: `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_KEY` or `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`

If you are configuring PHPMailer, keep the SMTP username, password, and app password in your local deployment settings and do not commit them to the repository.

### 4.8 DOCX Report Generation (Node.js)

The system generates DOCX files in two ways:

1) **PHP → Node CLI (used by** `GET /api/export_report.php`**)**
- PHP writes report JSON to a temporary file and runs the Node script `export/generate_report.js`.
- **Requirements:** Node.js installed on the same host, and `shell_exec` enabled in PHP.
- **Windows note:** the current implementation calls Node using an absolute path (`C:\\Program Files\\nodejs\\node.exe`). If Node is installed elsewhere, update that path accordingly.

2) **Optional Express export service** (`export/quality_report_api.js`)
- Runs a small Express server on port **3001**.
- Endpoint: `POST /export/quality-report` (returns a `.docx` attachment).
- This service is currently a simple placeholder exporter and is independent of `export_report.php`.

Start the optional service:
```bash
node export/quality_report_api.js
```

### 4.9 OCR Runtime Dependencies (Checklist and Document Extraction)

Composer packages provide OCR wrappers and parsers, but system binaries are also required for full OCR coverage.

Required/used at runtime:
- `Tesseract OCR` executable (`tesseract`)
- `Ghostscript` executable (`gswin64c` on Windows) for PDF-to-image conversion in OCR fallback
- Optional: `Imagick` PHP extension for additional PDF image fallback paths

Where this is used:
- `api/checklist.php` (shell-based OCR fallback)
- `api/extract.php` (Tesseract wrapper, Ghostscript/Imagick PDF OCR pipeline)

Quick checks:
```bash
tesseract --version
gswin64c -v
php -m
```

If binaries are installed in non-default locations, set these `.env` values:
- `TESSERACT_BIN`
- `GHOSTSCRIPT_BIN`

Recommended configuration method:
- Set `TESSERACT_BIN` and `GHOSTSCRIPT_BIN` in `.env` to avoid editing source files per environment.

### 4.10 Access the Application

Open a browser and navigate to:
```
http://localhost/public_html
```

---

## 5. Project Structure

```
qatalyst/
├── api/                          # PHP API endpoints (~30 files)
│   ├── backfill_category_averages.php
│   ├── certificates_api.php      # Certificate management, file uploads & email distribution
│   ├── column_configs.php        # Saved column-mapping configuration CRUD
│   ├── compute_workshop.php      # Compute online workshop results into saved records
│   ├── dashboard.php             # Dashboard analytics data (live evaluations)
│   ├── delete-responses.php      # Delete evaluation responses
│   ├── evaluation.php            # Evaluation form data retrieval & submission
│   ├── evaluation_monitoring.php # Participation tracking & reminders
│   ├── export_report.php         # DOCX report generation trigger
│   ├── export-responses.php      # CSV export of evaluation responses
│   ├── feedback_ai.php           # OpenAI feedback summarization
│   ├── forgot-password.php       # Password reset flow
│   ├── login.php                 # User authentication
│   ├── logout.php                # Session termination
│   ├── main-settings.php         # Profile & system settings
│   ├── process.php               # Excel import engine
│   ├── program_dashboard.php     # Program-specific dashboard (imported records)
│   ├── programs.php              # Workshop CRUD
│   ├── qame_categories.php       # QAME category management
│   ├── questions.php             # Evaluation questions CRUD
│   ├── rating_scales.php         # Rating scale configuration
│   ├── records_api.php           # Imported records retrieval
│   ├── responses.php             # Evaluation response listing (live & imported)
│   ├── save.php                  # General save endpoint
│   ├── settings_api.php          # Import settings management
│   ├── speaker_display_settings.php # Speaker roster display preferences
│   ├── speaker_roster.php        # Speaker ratings aggregation
│   ├── submit-evaluation.php     # Evaluation form submission (legacy redirect)
│   ├── user_management.php       # User account CRUD
│   ├── notifications.php         # Notification bell API (evaluation submissions)
│   ├── verify-2fa.php            # Two-factor authentication verification
│   ├── verify-email.php          # Email verification
│   ├── verify-reset-code.php     # Password reset code verification
│   ├── view-tables-api.php       # Database schema introspection
│   ├── workshops.php             # Workshop listing (authenticated)
│   ├── .htaccess                 # API security (Authorization header pass-through, upload protection)
│   └── uploads/                  # File upload storage (PHP execution disabled)
│
├── config/
│   ├── database.php              # PDO database connection (singleton)
│   ├── auth_middleware.php       # Authentication & permission middleware
│   ├── security.php              # Security utilities (CORS, headers, file validation)
│   └── htaccess                  # Security rules for config directory
│
├── models/
│   ├── User.php                  # User model (CRUD, auth methods)
│   ├── PasswordResetToken.php    # Password reset token model
│   └── VerificationCode.php      # Email verification code model
│
├── helpers/
│   └── EmailHelper.php           # PHPMailer wrapper (4 email methods)
│
├── js/
│   ├── config.js                 # Global CONFIG object (BASE_URL, API_URL)
│   ├── permissions.js            # Client-side permission management & nav filtering
│   ├── dashboard.js              # Home dashboard controller (summary cards, recent activity)
│   ├── workshop-dashboard.js     # Workshop analytics dashboard controller (charts, demographics, QAME)
│   ├── evaluation.js             # Evaluation form controller
│   ├── programs.js               # Programs page controller
│   ├── certificates.js           # Certificate management controller
│   ├── certificates-splitter.js  # Certificate splitting controller
│   ├── checklist.js              # Multi-step checklist scanner controller
│   ├── checklist-generator-modal.js # Checklist generator modal (prefill + live preview + DOCX export)
│   ├── column-settings.js        # Column mapping configurator controller
│   ├── evaluation-monitoring.js  # Monitoring page controller
│   ├── records.js                # Records page controller (with DOCX/PDF export)
│   ├── speaker-roster.js         # Speaker roster controller (live + saved records)
│   ├── user-management.js        # User management controller
│   ├── settings.js               # Settings page controller
│   ├── main-settings.js          # Main settings controller
│   ├── import-excell.js          # Excel import controller
│   ├── import-settings.js        # Import settings load/save controller
│   ├── view-responses.js         # Response viewer controller
│   ├── qame-analysis.js          # QAME analysis controller
│   ├── quality-reports.js        # Quality reports controller
│   ├── code-validation.js        # Verification code controller
│   ├── notifications.js          # Notification bell system (polling, dropdown UI)
│   ├── verify-2fa.js             # 2FA verification page controller
│   ├── view-tables-app.js        # DB schema viewer — interactive ERD visualizer
│   ├── view-tables-schema.js     # DB schema viewer — table/column definitions
│   ├── docx.umd.min.js           # DOCX library (bundled)
│   └── FileSaver.min.js          # Browser file download/save library
│
├── css/                          # Per-page stylesheets
│   ├── dashboard.css
│   ├── workshop-dashboard.css
│   ├── evaluation.css
│   ├── programs.css
│   ├── certificates.css
│   ├── login.css
│   ├── notifications.css         # Notification bell/dropdown styles
│   └── ... (one CSS per page)
│
├── export/
│   ├── generate_report.js        # Node.js DOCX report builder
│   └── quality_report_api.js     # Express server for quality reports (port 3001)
│
├── migrations/                   # SQL migration scripts
│   ├── create_qame_super_categories.sql
│   ├── create_rating_scales_table.sql
│   ├── create_user_files_table.sql
│   ├── create_column_configs.sql  # Column config storage table
│   ├── add_participant_role_capabilities.sql
│   ├── add_settings_snapshot.sql
│   ├── add_workshop_id_to_programs.sql # Link imported records to workshops
│   └── migrate.php               # Migration runner
│
├── models/                       # PHP model classes
├── src/                          # MVC skeleton (controllers/, models/, views/, routes.php)
├── vendor/                       # Composer dependencies (auto-generated)
├── node_modules/                 # npm dependencies (auto-generated)
├── images/                       # Static images/assets
├── TCPDF/                        # TCPDF library for PDF generation
│
├── *.html                        # Frontend pages (20 HTML files)
├── checklist.php                 # Backend for checklist document scanning (PDF/DOCX/DOC)
├── composer.json                 # PHP dependencies
├── package.json                  # Node.js dependencies
├── migrations/u906274725_eval_db.sql  # Database dump/schema (moved to `migrations/`)
├── .htaccess                     # CORS, upload limits, URL rewriting
└── README.md                     # Brief project readme
```

### Architecture Pattern

The project uses a **flat API architecture**:
- Each PHP file in `api/` is a standalone endpoint
- Request routing is handled internally via `$_SERVER['REQUEST_METHOD']` and `$_GET['action']` parameters
- The frontend consists of separate HTML pages with per-page JavaScript controllers
- JavaScript files make `fetch()` calls with `credentials: 'include'` to send HttpOnly cookies automatically
- Authentication is managed via HttpOnly cookie (`session_token`) — JS cannot access the token
- Display-only user info is stored in `localStorage` (user_id, full_name, email, role) — **NOT** the session token

---

## 6. Database Schema

The database `evaluation_db` contains **28+ tables** organized into the following groups:

### 6.1 Core Workshop/Program Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `workshops` | Training programs/workshops | `id`, `title`, `start_date`, `end_date`, `venue`, `status`, `division_memo` |
| `workshop_days` | Individual days within a workshop | `id`, `workshop_id`, `day_number`, `day_date` |
| `workshop_participants` | Participants registered for a workshop | `id`, `workshop_id`, `name`, `sex`, `email`, `designation`, `school`, `attendance` |
| `resource_speakers` | Speaker info per workshop day | `id`, `workshop_id`, `day_id`, `name`, `designation`, `organization`, `topic` |

### 6.2 Online Evaluation System Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `evaluation_question_categories` | 8 evaluation categories | `id`, `name`, `display_order` |
| `evaluation_questions` | Configurable questions per workshop | `id`, `category_id`, `workshop_id`, `question_text`, `question_type` (rating/text/select), `is_for_speaker`, `display_order` |
| `evaluation_submissions` | Each form submission | `id`, `participant_id`, `workshop_id`, `day_id`, `submitted_at` |
| `evaluation_answers` | Individual rating/text/select answers | `id`, `submission_id`, `question_id`, `rating_value`, `text_value`, `select_value` |
| `evaluation_speaker_answers` | Per-speaker ratings | `id`, `submission_id`, `speaker_id`, `question_id`, `rating_value` |

**Evaluation Categories** (default 8):
1. Program Management & Operations
2. Attainment of Objectives
3. Delivery of Content
4. Venue
5. Meal
6. Program Management Team
7. Speaker Evaluation (per-speaker)
8. Feedback (open-ended)

### 6.3 Excel Import / Legacy Data Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `evaluation_programs` | Programs from Excel import or online computation | `id`, `title`, `proponents`, `training_venue`, `inclusive_dates`, `overall_average`, `overall_result`, `source_filename`, `workshop_id` (FK), `source_type` (excel/online/merged) |
| `respondents` | Individual imported respondents per day | `id`, `program_id`, `day_sheet`, `respondent_number`, `sex` |
| `respondent_scores` | Per-question scores from imported data | `id`, `respondent_id`, `question_label`, `score`, `category_name` |
| `respondent_feedback` | Open-ended feedback from imports | `id`, `respondent_id`, `feedback_type`, `feedback_text` |
| `category_averages` | Pre-computed category averages | `id`, `program_id`, `day_sheet`, `category_name`, `average_score`, `result_label`, `is_overall` |
| `speaker_averages` | Pre-computed speaker ratings | `id`, `program_id`, `day_sheet`, `speaker_name`, `average_score`, `result_label` |
| `speaker_criteria` | Per-criteria speaker scores | `id`, `speaker_average_id`, `criteria_name`, `average_score` |

### 6.4 Configuration Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `eval_settings` | JSON key-value settings for imports | `id`, `setting_key`, `setting_value` (JSON) |
| `rating_scales` | Configurable rating scales | `id`, `scale_type` (category/speaker/overall), `min_value`, `max_value`, `label`, `color` |
| `qame_super_categories` | QAME analysis groupings (Q, A, M, E) | `id`, `name`, `code`, `description` |
| `qame_category_mappings` | Maps eval categories to QAME groups | `id`, `super_category_id`, `category_name` |
| `participant_roles` | Configurable participant role types | `id`, `role_name`, `capabilities` |
| `column_configs` | Saved column-mapping configurations | `id`, `name`, `description`, `config_json` (LONGTEXT), `sheet_count`, `column_count`, `created_at`, `updated_at` |
| `speaker_display_settings` | Speaker roster display preferences | `workshop_id`, `show_name`, `show_rating`, `show_rank`, `show_badge_label`, `highlight_top` |

### 6.5 Authentication & User Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `users` | User accounts | `id`, `email`, `password` (hashed), `role`, `permissions` (JSON), `status`, `profile_picture`, `two_factor_enabled`, `last_notification_check`, `verify_token`, `verify_token_expires` |
| `login_sessions` | Token-based sessions | `id`, `user_id`, `session_token`, `ip_address`, `user_agent`, `expires_at` |
| `login_attempts` | Rate limiting & brute-force protection | `id`, `ip_address`, `email`, `user_agent`, `success` (0/1), `attempted_at` |
| `password_reset_tokens` | Password reset tokens | `id`, `user_id`, `token`, `code` (6-digit), `expires_at` |
| `email_verification_codes` | Email verification | `id`, `user_id`, `code`, `is_used`, `expires_at` |
| `two_factor_codes` | 2FA verification codes | `id`, `user_id`, `temp_token`, `code` (6-digit), `expires_at`, `created_at` |

### 6.6 File Management

| Table | Purpose | Key Columns |
|---|---|---|
| `user_files` | User-uploaded files | `id`, `user_id`, `filename`, `item_no`, `location`, `headings`, `qame_report_status` |
| `program_files` | Certificate/program file uploads | `id`, `program_id`, `filename`, `file_path` |

### 6.7 Monitoring Tables

| Table | Purpose | Key Columns |
|---|---|---|
| `evaluation_reminders` | Reminder email tracking | `id`, `participant_id`, `workshop_id`, `sent_at` |

### Entity Relationship Overview

```
workshops ─┬─── workshop_days ─── resource_speakers
            ├─── workshop_participants
            ├─── evaluation_questions ─── evaluation_question_categories
            ├─── evaluation_programs (via workshop_id FK)
            └─── speaker_display_settings
                       │
            evaluation_submissions ─┬─── evaluation_answers
                                    └─── evaluation_speaker_answers

evaluation_programs ─┬─── respondents ─┬─── respondent_scores
  (source_type:      │                 └─── respondent_feedback
   excel/online/     ├─── category_averages
   merged)           ├─── speaker_averages ─── speaker_criteria
                     └─── program_files

users ─┬─── login_sessions
       ├─── login_attempts (rate limiting)
       ├─── password_reset_tokens
       ├─── email_verification_codes
       ├─── two_factor_codes
       └─── user_files

column_configs (standalone — saved column mapping presets)
```

---

## 7. Authentication & Authorization

### 7.1 Authentication Flow

1. **Login** — User submits email/password to `POST /api/login.php`
2. **Rate Limit Check** — Server checks `login_attempts` table for brute-force protection (5 attempts per 15 minutes per IP)
3. **Credential Verification** — Server verifies password using constant-time comparison (bcrypt)
4. **2FA Check** — If user has `two_factor_enabled`:
   - Generate temp_token and 6-digit code
   - Store in `two_factor_codes` table (10-minute expiry)
   - Send code via email
   - Return `requires_2fa: true` with temp_token
   - User redirected to `verify-2fa.html` to enter code
   - On code verification: proceed to step 5
5. **Token Generation** — Server generates a cryptographic `session_token` (100 hex characters)
6. **Session Storage** — Token stored in `login_sessions` table with IP/user-agent binding
7. **HttpOnly Cookie** — Token set as HttpOnly cookie (`session_token`) — inaccessible to JavaScript
8. **API Requests** — Browser automatically sends cookie with `credentials: 'include'` on every fetch
9. **Validation** — `authenticate()` reads the correct HttpOnly cookie first, then falls back to `Authorization`

**Portal note (SDO vs School Portal):**
- SDO login uses HttpOnly cookie `session_token` (set by `api/login.php`).
- School Portal login uses HttpOnly cookie `school_session_token` (set by `api/school-login.php`).
- `authenticate()` detects portal requests (by URL/filename) and prioritizes the matching cookie to prevent session collisions in the same browser.
- API clients can optionally send `X-Portal: school` to force portal-mode cookie preference.

**Security Note (browser clients):** the frontend should rely on HttpOnly cookies and must never store session tokens in `localStorage`. Note that `api/verify-2fa.php` currently includes `session_token` in the JSON body for compatibility with non-browser API clients.

```
Client                          Server
  │                               │
  ├── POST /api/login.php ──────►│ Check rate limit (login_attempts)
  │   {email, password}           │ Verify credentials (constant-time)
  │                               │ Check two_factor_enabled
  │                               │
  │  ─ ─ ─ IF 2FA DISABLED ─ ─ ─ ─│
  │                               │ Generate session_token
  │                               │ Store in login_sessions
  │                               │ Set HttpOnly cookie
  │◄─── {user_id, email, role} ───┤ (NO session_token in response body)
  │   + Set-Cookie: session_token │
  │                               │
  │  ─ ─ ─ IF 2FA ENABLED ─ ─ ─ ─ │
  │                               │ Generate temp_token + 6-digit code
  │                               │ Store in two_factor_codes
  │                               │ Send code via email
  │◄─── {requires_2fa, temp_token}│
  │                               │
  │── Redirect to verify-2fa.html │
  │                               │
  ├── POST /api/verify-2fa.php ─►│ Validate temp_token + code
  │   {temp_token, code}          │ Generate session_token
  │                               │ Store in login_sessions
  │                               │ Set HttpOnly cookie
  │◄─── {user_id, email, role} ───┤
  │   + Set-Cookie: session_token │
  │                               │
  │ localStorage.setItem(         │
  │   'user_id', user.id)         │ (display info only, NOT token)
  │                               │
  ├── GET /api/dashboard.php ───►│ Read session_token from cookie
  │   credentials: 'include'      │ Check cookie → Auth header fallback
  │   Cookie: session_token=...   │ Validate token + expiry + user status
  │                               │ Return data if valid
  │◄─── {dashboard_data} ────────┤
```

### 7.2 Session Management

- Sessions expire after 24 hours (configurable via `SESSION_EXPIRY_HOURS` in login.php)
- Session token stored in HttpOnly cookie with `SameSite=Strict` and `Secure` (HTTPS) flags
- Sessions are tied to IP address and user agent for security
- Multiple concurrent sessions are supported
- Users can view and revoke active sessions via settings
- Expired sessions are automatically cleaned up on each login

### 7.3 Role-Based Access Control

**Roles:**
| Role | Description |
|---|---|
| `admin` | Full access to all features (all permissions automatically granted) |
| `viewer` | Limited access based on assigned permissions |

**Permissions (JSON array stored per user):**
| Permission Key | Grants Access To |
|---|---|
| `dashboard` | Dashboard & analytics |
| `programs` | Workshop/program management (also used for monitoring + exports) |
| `certificates` | Certificate generation & distribution |
| `speakers` | Speaker roster page access (client-side gated; the API endpoint is not currently permission-enforced) |
| `checklist` | Checklist scanner + related admin tools |
| `directory` | Directory management APIs |
| `school_submissions` | School portal submissions/admin views |
| `users` | User account management |
| `settings` | System/import settings + saved column configs |
| `audit_logs` | Audit log viewer/export |

**Default permissions:** if a user has no explicit `users.permissions` JSON entries, `hasPermission()` falls back to `user_roles.default_permissions` (JSON).

### 7.4 Client-Side Permission Enforcement

Located in `js/permissions.js`:

| Function | Purpose |
|---|---|
| `hasPermission(permission)` | Check if user has a single permission |
| `hasAnyPermission(array)` | Check if user has ANY of the listed permissions |
| `hasAllPermissions(array)` | Check if user has ALL listed permissions |
| `checkPagePermission(permission, redirectUrl)` | Redirect if user lacks permission for current page |
| `autoCheckPagePermission()` | Auto-detect required permission from page URL |
| `applyNavPermissions()` | Hide sidebar nav items the user cannot access |

### 7.5 Middleware Functions

Located in `config/auth_middleware.php`:

| Function | Purpose |
|---|---|
| `authenticate()` | Reads `session_token` or `school_session_token` (based on portal detection) first, then falls back to `Authorization`. Validates against `login_sessions` + user status. |
| `hasPermission($permission, $user)` | Checks if user has a specific permission |
| `requirePermission($permission, $user)` | Returns HTTP 403 if permission check fails |

Located in `config/security.php`:

| Function | Purpose |
|---|---|
| `setSecurityHeaders()` | Sets X-Frame-Options, X-Content-Type-Options, X-XSS-Protection, CSP, Referrer-Policy |
| `setCorsHeaders()` | Sets CORS headers with origin whitelist and `Access-Control-Allow-Credentials: true` |
| `handlePreflight()` | Handles OPTIONS preflight requests |
| `isAllowedFileExtension($filename, $allowed)` | Validates file extension against whitelist and blocks dangerous extensions |

### 7.6 Password Reset Flow

1. User requests reset via `POST /api/forgot-password.php`
2. System generates a 6-digit code, stores in `password_reset_tokens` (15-minute expiry)
3. Code sent to user's email via PHPMailer/Gmail SMTP
4. User submits code + new password to complete reset

### 7.7 Two-Factor Authentication

1. **Enable 2FA** — User enables 2FA via main settings page (`two_factor_enabled` flag)
2. **Login with 2FA** — When user logs in with 2FA enabled:
   - Server generates a temporary token and 6-digit code
   - Code stored in `two_factor_codes` table (10-minute expiry)
   - Code sent to user's email via PHPMailer
   - User redirected to `verify-2fa.html` with temp token
3. **Verify Code** — User submits code to `POST /api/verify-2fa.php`
   - Server validates code and temp token
   - On success: creates session, sets HttpOnly cookie, returns user data
4. **Session Created** — User is fully authenticated after 2FA verification

**Files:**
- `verify-2fa.html` — 2FA code entry page
- `js/verify-2fa.js` — 2FA verification controller
- `api/verify-2fa.php` — 2FA verification endpoint
- `api/login.php` — Checks `two_factor_enabled` and triggers 2FA flow

---

## 8. API Reference

All API endpoints are located in the `api/` directory. Responses are JSON unless otherwise noted.

**Authentication:** Authenticated endpoints read the session token from:
1. HttpOnly cookie `session_token` (SDO) or `school_session_token` (School Portal)
2. `Authorization` header (fallback — for API clients)

### 8.1 Authentication

#### `POST /api/login.php` — User Login
- **Auth Required:** No
- **Body:** `{ "email": string, "password": string, "portal"?: "sdo"|"school" }`
- **Response:** `{ "success": true, "data": { user_id, email, full_name, email_verified, role, account_type, verify_token } }`
- **Note:** Session token is NOT in response body — it is set as an HttpOnly cookie (`Set-Cookie: session_token=...`)
- **Rate Limiting:** Returns 429 after 5 failed attempts within 15 minutes

#### `POST /api/logout.php` — User Logout
- **Auth Required:** Yes (via HttpOnly cookie)
- **Note:** Reads token from cookie, invalidates session, clears cookie
- **Response:** `{ "success": true }`

#### `POST /api/forgot-password.php` — Request Password Reset
- **Auth Required:** No
- **Body:** `{ "email": string }`
- **Response:** `{ "success": true, "message": "Reset code sent" }`

#### `POST /api/verify-reset-code.php` — Verify Reset Code
- **Auth Required:** No
- **Body:** `{ "email": string, "code": string }`
- **Response:** `{ "success": true, "token": string }`

#### `POST /api/reset-password.php` — Reset Password
- **Auth Required:** No
- **Body:** `{ "token": string, "password": string }`
- **Response:** `{ "success": true }`

#### `POST /api/verify-email.php` — Verify Email Address
- **Auth Required:** No
- **Body:** `{ "user_id": int, "code": string }`
- **Response:** `{ "success": true }`

#### `POST /api/verify-2fa.php` — Two-Factor Verification
- **Auth Required:** No
- **Body:** `{ "temp_token": string, "code": string }`
- **Response:** `{ "success": true, "data": { user_id, email, full_name, email_verified, role, session_token, expires_at } }`
- **Note:** Also sets the HttpOnly cookie `session_token` for browser clients

---

### 8.2 Notifications

#### `GET /api/notifications.php` — Get Notification Counts
- **Auth Required:** Yes (via HttpOnly cookie)
- **Response:**
```json
{
  "success": true,
  "data": {
    "unread_count": int,
    "recent": [
      {
        "id": int,
        "submitted_at": "timestamp",
        "participant_name": "string",
        "day_label": "Day 1",
        "workshop_title": "string",
        "is_new": boolean,
        "time_ago": "2 minutes ago"
      }
    ],
    "last_check": "timestamp"
  }
}
```

#### `POST /api/notifications.php` — Mark Notifications as Read
- **Auth Required:** Yes (via HttpOnly cookie)
- **Body:** `{ "action": "mark_read" }`
- **Response:** `{ "success": true, "data": { "marked_at": "timestamp" } }`

---

### 8.3 Workshop / Program Management

#### `GET /api/programs.php` — List All Workshops
- **Auth Required:** Yes
- **Response:** Array of workshops with aggregated stats (responses_count, days_count, speakers_count, creator_name)

#### `GET /api/programs.php?categories=1` — Fetch Active Question Categories
- **Auth Required:** Yes
- **Response:** Array of active evaluation question categories

#### `GET /api/programs.php?dropdown_options=1` — Fetch Program Dropdown Options
- **Auth Required:** Yes
- **Query (optional):** `type=unit|nature_of_event`
- **Response:** Active options grouped by type for Program Unit and Nature of Event selects

#### `POST|PUT|DELETE /api/programs.php?manage_options=1` — Manage Program Dropdown Options
- **Auth Required:** Yes
- **Permission:** `programs` (write methods)
- **Description:** CRUD for `workshop_dropdown_options` entries used by Programs forms

#### `GET /api/programs.php?id=<id>` — Get Single Workshop
- **Auth Required:** Yes
- **Response:** Workshop details with days and speakers

#### `GET /api/programs.php` — List Workshops (Unified)
- **Auth Required:** Yes
- **Response:** Unified list combining:
  - System workshops from `workshops`
  - Excel-linked workshops (`evaluation_programs` with `workshop_id`)
  - Standalone Excel imports (`evaluation_programs` with `workshop_id IS NULL`)
- **Notes:** Includes `source` discriminator (`system` or `excel`), response/day/speaker counts, and computed/fallback `overall_average` and `overall_result`

#### `POST /api/programs.php` — Create Workshop
- **Auth Required:** Yes
- **Permission:** `programs`
- **Body:** `{ "title": string, "start_date": string, "end_date": string, "venue": string, "division_memo": string, "proponents": string, "description": string, "total_participants": int, "days": [{ "day_number": int, "date": string, "title": string, "description": string, "speakers": [...] }] }`
- **Response:** `{ "success": true, "data": { "id": int } }`

#### `PUT /api/programs.php` — Update Workshop
- **Auth Required:** Yes
- **Permission:** `programs`
- **Body:** `{ "id": int, ... (same as create) }`
- **Notes:**
  - Enforces ownership (creator) or `admin` role
  - If submissions exist and `days` are changed, returns partial success with `requires_force: true` unless `force_rebuild_days` is provided

#### `DELETE /api/programs.php` — Delete Workshop
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?id=<program_id>[&force=true]`
- **Notes:**
  - Enforces ownership (creator) or `admin` role
  - Returns HTTP 409 with `requires_confirmation: true` if submissions exist and `force=true` is not supplied

#### `GET /api/workshops.php` — Workshop Listing
- **Auth Required:** Yes
- **Response:** Array of workshops with days and participant counts

---

### 8.4 Evaluation System

#### `GET /api/evaluation.php` — Get Evaluation Form Data
- **Auth Required:** No
- **Query:** `?program_id=<id>`
- **Response:** Workshop info, questions grouped by category (workshop-specific + global fallback), speakers, days, and evaluation status
- **Features:** Checks submittability (status, end_date); sets `effective_status` and `is_submittable` flags

#### `POST /api/evaluation.php` — Submit Evaluation
- **Auth Required:** No
- **Description:** Handles evaluation submission directly (also accessible via `submit-evaluation.php` legacy redirect)
- **Body:**
```json
{
  "workshop_id": 1,
  "day_id": 1,
  "participant": {
    "name": "string",
    "sex": "Male|Female",
    "email": "string",
    "designation": "string",
    "school": "string"
  },
  "answers": [
    { "question_id": 1, "rating_value": 4 },
    { "question_id": 2, "text_value": "Great session" },
    { "question_id": 3, "select_value": "Met as expected" }
  ],
  "speaker_answers": [
    { "speaker_id": 1, "question_id": 10, "rating_value": 4 }
  ]
}
```
- **Response:** `{ "success": true, "submission_id": int }`
- **Note:** Uses `ON DUPLICATE KEY UPDATE` for graceful resubmission handling

#### `GET /api/questions.php` — List Questions for Workshop
- **Auth Required:** Yes
- **Query:** `?workshop_id=<id>`
- **Response:** Questions grouped by category with display order

#### `POST /api/questions.php` — Create Question
- **Auth Required:** Yes
- **Body:** `{ "workshop_id": int, "category_id": int, "question_text": string, "question_type": "rating|text|select", ... }`

#### `PUT /api/questions.php` — Update Question
- **Auth Required:** Yes
- **Body:** `{ "id": int, "question_text": string, ... }`

#### `PATCH /api/questions.php` — Batch Reorder Questions
- **Auth Required:** Yes
- **Body:** `{ "questions": [{ "id": int, "display_order": int }, ...] }`

#### `DELETE /api/questions.php` — Delete Question
- **Auth Required:** Yes
- **Body:** `{ "id": int }`

---

### 8.5 Dashboard & Analytics

#### `GET /api/dashboard.php` — Live Workshop Dashboard Data
- **Auth Required:** Yes (valid session cookie or Authorization header)
- **Permission:** `dashboard`
- **Query:** `?workshop_day_id=<id>` (single day) or `?workshop_day_id=all&workshop_id=<id>` (all days aggregate)
- **Polling:** `?workshop_day_id=<id>&check_only=1` — lightweight poll returning response count only
- **Response:**
```json
{
  "workshop": { ... },
  "total_responses": int,
  "demographics": { "male": int, "female": int },
  "category_averages": [
    { "category": "string", "average": float, "label": "string" }
  ],
  "speaker_ratings": [
    { "speaker": "string", "criteria": [...], "average": float, "rank": int }
  ],
  "question_averages": [...],
  "feedback_summary": [...],
  "qame_analysis": { "Q": float, "A": float, "M": float, "E": float },
  "last_submission": "timestamp"
}
```
- Supports per-day filtering and "all days" aggregate view
- Speaker rankings with tie handling
- Dynamic evaluation questions (reads from `evaluation_questions` table)
- Primarily consumed by `workshop-dashboard.html` (not the home `dashboard.html` page)

#### Home Dashboard Data Sources (`dashboard.html`)
- **Auth Required:** Yes (session validated via `GET /api/main-settings.php`)
- **Permission Gate:** `dashboard` (users without this permission are redirected to their first allowed page)
- **Primary Data Calls:**
  - `GET /api/workshops.php` — workshop list and response counters (authenticated)
  - `GET /api/records_api.php` — saved records count/activity feed data (authenticated)
  - `GET /api/imported_responses.php` — imported response totals (authenticated)
  - `GET /api/ocr-health.php` — OCR runtime chip status (requires `users` permission; otherwise chip shows "No Access")
- **Behavior:** No 10-second analytics polling on the home dashboard; OCR chip checks on load, every 2 minutes, and when the tab regains visibility

#### `GET /api/program_dashboard.php` — Imported Program Dashboard Data
- **Auth Required:** Yes
- **Query:** `?program_id=<id>&day=<day_sheet|all>`
- **Response:** Program metadata, sex breakdown, category averages, speaker data, respondent list
- **Features:** Fuzzy category name matching (handles "&" vs "and", parenthetical suffixes); returns real `evaluation_question_categories.id` for QAME mapping

#### `GET /api/responses.php` — List Evaluation Responses
- **Auth Required:** Yes
- **Query (live):** `?workshop_day_id=<id>` — returns submissions from live evaluations
- **Query (imported):** `?program_id=<id>&day_sheet=<day>` — returns respondents from saved records
- **Response:** Array of submissions with full answer data, dynamic field mapping (pm_q1, obj_q2, speaker_q1, etc.)

#### `DELETE /api/responses.php` — Delete Response
- **Auth Required:** Yes
- **Body:** `{ "submission_id": int }`

#### `GET /api/export-responses.php` — Export Responses to CSV
- **Auth Required:** Yes
- **Query:** `?workshop_day_id=<id>` (required)
- **Optional Filters:** `sex`, `participant_type`, `search`
- **Response:** CSV file download (`survey_responses_[DATE].csv`)

---

### 8.6 Monitoring

#### `GET /api/evaluation_monitoring.php?action=workshops` — List Workshops
- **Auth Required:** Yes
- **Permission:** `programs`
- **Response:** Array of workshops for dropdown selection

#### `GET /api/evaluation_monitoring.php?action=participants` — Get Participant Completion Status
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?workshop_id=<id>&day_id=<id>` (optional day filter)
- **Response:** Per-participant evaluation completion status (pending/partial/completed) across all days

#### `GET /api/evaluation_monitoring.php?action=stats` — Get Completion Statistics
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?workshop_id=<id>`
- **Response:** Overall completion stats + per-day breakdown with response rate %

#### `POST /api/evaluation_monitoring.php?action=remind` — Send Reminder to Specific Participants
- **Auth Required:** Yes
- **Permission:** `programs`
- **Body:** `{ "workshop_id": int, "participant_ids": [int, ...] }`
- **Response:** `{ "success": true, "sent": int, "failed": int }`

#### `POST /api/evaluation_monitoring.php?action=remind_all` — Send Reminder to All Incomplete
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?workshop_id=<id>&day_id=<id>` (optional day filter)
- **Response:** `{ "success": true, "sent": int, "failed": int }`

---

### 8.7 Certificates, Participants & Files

Base endpoint: `api/certificates_api.php` using `action=<name>`.

#### Workshop & Participant Management
- `GET ?action=get_workshops` — List workshops plus orphaned/import-only programs (normalized shape for UI)
- `GET ?action=get_participants&workshop_id=<id>` — List participants for workshop
- `GET ?action=get_participant_roles` — List available participant roles
- `GET ?action=get_stats&workshop_id=<id>` — Workshop participant statistics
- `POST ?action=add_participant` — Add participant
- `POST ?action=update_participant` — Update participant
- `POST ?action=delete_participant` — Delete participant
- `POST ?action=import_csv` — Import participants from CSV (auto-marks attendance as 'attended')

#### Email Distribution
- `GET ?action=get_email_status&workshop_id=<id>` — Email sent status per participant
- `POST ?action=send_certificate_email` — Send certificate email with PDF attachment
- `POST ?action=bulk_send_certificate_email` — Bulk send to multiple participants
- `POST ?action=mark_email_sent` — Mark email as sent manually
- `POST ?action=bulk_mark_sent` — Bulk mark emails as sent

#### File Management
- `GET ?action=get_files` — List uploaded files
- `POST ?action=upload_file` — Upload file (creates `program_files` table if needed)
- `POST ?action=delete_file` — Delete file
- `GET ?action=download_file&id=<id>` — Download file

#### Certificate Splitter Integration
- `POST ?action=save_split_results` — Save split certificate PDFs, create `program_files` entries, and auto-link matched files to participants/respondents (`cert_file_id`)
- `POST ?action=bulk_send_certificate_email` — Bulk send pending certificates with optional fallback attachment
- `POST|GET ?action=fix_dangling_certs` — Clear stale `cert_file_id` references when linked files were deleted
- Splitter data sources outside `certificates_api.php`:
  - `GET /api/workshops.php` — Workshop/program picker data for modal selection
  - `GET /api/workshops.php?action=participants&workshop_id=<id>` — Participant list for selected workshop
  - `GET /api/records_api.php` — Linked/standalone imported records for picker and linked-record chips
  - `GET /api/records_api.php?id=<record_id>&monitoring=1` — Respondent list when a standalone record is selected

#### Workshop Days
- `GET ?action=get_days&workshop_id=<id>` — List workshop days

**Auth Required:** Yes (session cookie via `authenticate()`, `certificates` permission)

---

### 8.8 Speaker Roster

#### `GET /api/speaker_roster.php` — Speaker Ratings
- **Auth Required:** Endpoint currently has no server-side auth middleware check; frontend page access is permission-gated client-side (`speakers` permission)
- **Query:** Optional filters: `?workshop_id=<id>`, `?workshop_day_id=<id>`, `?speaker_id=<id>`
- **Response:** Resource speakers with aggregated ratings across 6 criteria plus speaker/workshop/day metadata
- **Used By:** `speaker-roster.html` and `js/speaker-roster.js`

---

### 8.9 Excel Import & Records

#### `POST /api/process.php` — Import Excel File
- **Auth Required:** Yes
- **Content-Type:** `multipart/form-data`
- **Body Fields:**
  - `excel_file` — `.xlsx`, `.xls`, or `.csv` file
  - `rules` — JSON array of text→numeric replacements
  - `excluded_columns` — columns to skip
  - `speaker_names` — map slot numbers to speaker names per day
  - `preview_only=1` — dry-run mode (returns data without saving)
- **Description:** Processes uploaded files using PhpSpreadsheet. Auto-detects per-sheet active speaker slots and feedback column positions. Dynamic column classification (question vs. info based on response ratio & keywords). Per-sheet override detection with user-saved precedence logic.
- **Response:** `{ "success": true, "program_id": int, "summary": { ... } }`

#### `POST /api/compute_workshop.php` — Compute Online Workshop into Saved Record
- **Auth Required:** Yes
- **Permission:** `programs`
- **Body:** `{ "workshop_id": int }`
- **Description:** Processes all online evaluation submissions for a workshop and creates a saved `evaluation_programs` record (with `source_type='online'`). Populates `respondents`, `respondent_scores`, `respondent_feedback`, `speaker_averages`, `speaker_criteria`, and `category_averages` tables.
- **Response:** `{ "success": true, "program_id": int, "stats": { "respondents_saved": int, "days_saved": int, "overall_average": float, "pct_responses": float } }`

#### `GET /api/records_api.php` — Get Imported Records
- **Auth Required:** Yes
- **Query:** `?id=<program_id>` (optional) or `?action=categories` (ordered category list)
- **Response:** Imported evaluation records with full per-day breakdowns (categories, questions, column-level averages, speakers, criteria)

#### `GET /api/records_api.php?action=check_sequence&sn=<sequence>&exclude_id=<id>` — Validate Record Sequence Number
- **Auth Required:** Yes
- **Description:** Checks whether a sequence number already exists in `evaluation_programs`; used by Programs page record edit modal for duplicate-prevention.
- **Response:** Duplicate status with optional conflicting record metadata.

#### `DELETE /api/records_api.php` — Delete Record
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?id=<program_id>`
- **Description:** Cascading delete of program and all related data

#### `GET /api/settings_api.php` — Get Import Settings
- **Auth Required:** Yes
- **Permission:** `settings`
- **Response:** Column mappings, categories, speaker slots, thresholds

#### `POST /api/settings_api.php` — Update Import Settings
- **Auth Required:** Yes
- **Permission:** `settings`
- **Body:** Settings key-value pairs (JSON)

---

### 8.10 QAME Analysis

#### `GET /api/qame_categories.php` — List QAME Categories
- **Auth Required:** Yes
- **Response:** QAME super-categories with sub-category mappings

#### `POST /api/qame_categories.php` — Create QAME Category
- **Auth Required:** Yes
- **Body:** `{ "name": string, "code": string, "description": string }`

#### `PUT /api/qame_categories.php` — Update QAME Category
- **Auth Required:** Yes
- **Body:** `{ "id": int, "name": string, ... }`

#### `DELETE /api/qame_categories.php` — Delete QAME Category
- **Auth Required:** Yes
- **Body:** `{ "id": int }`

---

### 8.11 Rating Scales

#### `GET /api/rating_scales.php` — Get Rating Scales
- **Auth Required:** Yes
- **Response:** Rating scales grouped by type:
  - `category` — e.g., 3.51–4.00 = "Outstanding"
  - `speaker` — Speaker-specific thresholds
  - `overall` — Overall program rating thresholds

---

### 8.12 Reports & Export

#### `GET /api/export_report.php` — Generate DOCX Report
- **Auth Required:** Yes
- **Permission:** `programs`
- **Query:** `?id=<evaluation_programs.id>`
- **Description:** Fetches record data from `evaluation_programs` + computed tables, writes JSON to a temp file, invokes Node.js script (`export/generate_report.js`) to generate a Word document, then streams it as a download.
- **Response:** Binary `.docx` file download

#### Node.js Report Server — `export/quality_report_api.js`
- **Port:** 3001
- **Endpoint:** `POST /export/quality-report`
- **Description:** Express.js API for generating quality report DOCX files

---

### 8.13 User Management

#### `GET /api/user_management.php` — List Users
- **Auth Required:** Yes
- **Permission:** `users`
- **Response:** Array of user accounts

#### `POST /api/user_management.php?action=create` — Create User
- **Auth Required:** Yes
- **Permission:** `users`
- **Body:** `{ "email": string, "password": string, "full_name": string, "role": string, "permissions": [...] }`

#### `POST /api/user_management.php?action=update` — Update User
- **Auth Required:** Yes
- **Permission:** `users`
- **Body:** `{ "id": int, ... }`

#### `POST /api/user_management.php?action=delete` — Delete User
- **Auth Required:** Yes
- **Permission:** `users`
- **Body:** `{ "id": int }`

#### `POST /api/user_management.php?action=toggle_status` — Enable/Disable User
- **Auth Required:** Yes
- **Permission:** `users`
- **Body:** `{ "id": int }`

#### `POST /api/user_management.php?action=reset_password` — Reset User Password
- **Auth Required:** Yes
- **Permission:** `users`
- **Body:** `{ "id": int, "new_password": string }`

---

### 8.14 Main Settings

#### `GET /api/main-settings.php?action=profile` — Get User Profile
- **Auth Required:** Yes

#### `POST /api/main-settings.php?action=update_profile` — Update Profile
- **Auth Required:** Yes
- **Body:** `{ "full_name": string, "email": string }`

#### `POST /api/main-settings.php?action=change_password` — Change Password
- **Auth Required:** Yes
- **Body:** `{ "current_password": string, "new_password": string }`

#### `POST /api/main-settings.php?action=upload_picture` — Upload Profile Picture
- **Auth Required:** Yes
- **Body:** `multipart/form-data` with image file

#### `POST /api/main-settings.php?action=toggle_2fa` — Toggle 2FA
- **Auth Required:** Yes

---

### 8.15 AI Feedback

#### `POST /api/feedback_ai.php` — AI Feedback Summarization
- **Auth Required:** Yes
- **Body:** `{ "feedback_text": string }`
- **Description:** Sends open-ended participant feedback to OpenAI API for summarization and improvement suggestions
- **Response:** `{ "success": true, "summary": string }`

---

### 8.16 Column Configurations

#### `GET /api/column_configs.php` — List All Column Configs
- **Auth Required:** Yes
- **Permission:** `settings`
- **Response:** Array of saved column-mapping configurations (summary)

#### `GET /api/column_configs.php?id=<id>` — Get Single Config
- **Auth Required:** Yes
- **Permission:** `settings`
- **Response:** Full column config with `config_json`

#### `POST /api/column_configs.php` — Create Column Config
- **Auth Required:** Yes
- **Permission:** `settings`
- **Body:** `{ "name": string, "description": string, "config": { "sheets": [...] } }`
- **Note:** Auto-creates `column_configs` table on first run

#### `PUT /api/column_configs.php` — Update/Rename Column Config
- **Auth Required:** Yes
- **Permission:** `settings`
- **Body:** `{ "id": int, "name": string, "description": string, "config": { ... } }`

#### `DELETE /api/column_configs.php?id=<id>` — Delete Column Config
- **Auth Required:** Yes
- **Permission:** `settings`

---

### 8.17 Speaker Display Settings

#### `GET /api/speaker_display_settings.php` — Get Global Display Defaults
- **Auth Required:** Yes

#### `GET /api/speaker_display_settings.php?workshop_id=<id>` — Get Effective Settings for Workshop
- **Auth Required:** Yes
- **Response:** `{ "effective": {...}, "workshop_override": {...}, "global_default": {...} }`

#### `POST /api/speaker_display_settings.php` — Create/Update Display Settings
- **Auth Required:** Yes
- **Body:** `{ "workshop_id": null|int, "show_name": 0|1, "show_rating": 0|1, "show_rank": 0|1, "show_badge_label": 0|1, "highlight_top": 0|1 }`

#### `DELETE /api/speaker_display_settings.php?workshop_id=<id>` — Reset Workshop to Global Defaults
- **Auth Required:** Yes

---

### 8.18 Checklist Scanner

#### `POST /api/checklist.php?action=scan_checklist` — Scan Checklist Document
- **Auth Required:** Yes (`checklist` permission)
- **Content-Type:** `multipart/form-data`
- **Accepts:** `.doc`, `.docx`, `.pdf` files
- **Description:** Extracts text from uploaded documents using PdfParser (PDF), ZIP XML extraction (DOCX), or binary extraction (DOC). Detects header fields (school name, location, recognition #, date, school head, evaluator) and matches against DepEd checklist standards.
- **Response:** `{ "fields": [...], "items": [...], "raw_text": string }`

---

### 8.19 Audit Logs

#### `GET /api/audit_logs.php` — List Audit Logs
- **Auth Required:** Yes
- **Permission:** `audit_logs`
- **Description:** Returns paginated audit logs with optional filters.
- **Supported Query Params:**
  - `page`, `limit`
  - `search`, `role`, `action`, `module`, `status`
  - `from`, `to`, `user_id`, `school_id`

#### `GET /api/audit_logs.php?list=schools` — List Schools for Filter Dropdown
- **Auth Required:** Yes
- **Permission:** `audit_logs`
- **Description:** Returns active schools used by the Audit Logs page school filter.

#### `GET /api/audit_logs.php?export=csv` — Export Audit Logs CSV
- **Auth Required:** Yes
- **Permission:** `audit_logs`
- **Description:** Exports filtered audit logs to CSV and records an `export` action in `audit_logs`.

---

### 8.20 Utility / Development

#### `GET /api/view-tables-api.php` — Database Schema Introspection
- **Auth Required:** Yes
- **Response:** Lists all tables, columns, foreign keys, row counts — useful for development/debugging

#### `GET /api/ocr-health.php` — OCR Runtime Health Check
- **Auth Required:** Yes (`users` permission)
- **Description:** Verifies OCR runtime readiness from PHP (shell execution availability, configured OCR binary env vars, and version-command output for Tesseract and Ghostscript)
- **Used By:**
  - Dashboard header OCR status chip and hover panel (`dashboard.html`, `js/dashboard.js`)
  - Main Settings → Security tab OCR Runtime Health card (`main-settings.html`, `js/main-settings.js`)
- **Response:** Runtime diagnostics including `shell_exec_enabled`, configured env values, and command outputs/errors

---

## 9. Frontend Pages

| Page | File | Description |
|---|---|---|
| Landing | `index.html` | Splash/landing page with title and tagline |
| Login | `login.html` | Login form with branded panel showing feature highlights |
| Dashboard | `dashboard.html` | Home overview dashboard with summary cards, recent workshops, quick actions, activity feed, and OCR runtime status chip (permission-aware) |
| Workshop Dashboard | `workshop-dashboard.html` | Workshop-specific analytics dashboard with charts, demographics, QAME analysis. Accessed via `?program_id=<id>` parameter. Features back button to programs page, workshop title display, day navigation, and PNG export. |
| 2FA Verification | `verify-2fa.html` | Two-factor authentication code entry page |
| Programs | `programs.html` | Unified workshop/program management with card/table layouts, system+excel source merge, day/speaker builder, question bank/copy workflow, in-modal responses/reports/monitoring, evaluation link + QR/preview tools, and summary report export actions |
| Program Summary | `program-summary.html` | Activity summary report for all programs and workshops across quarters |
| Evaluation Form | `evaluation.html` | Participant-facing evaluation form (public) |
| Directory | `directory.html` | Personnel directory with division tabs, district grouping for school personnel, private school contact matrix, and modal-based CRUD with seed-data fallback |
| Certificates | `certificate.html` | Workshops-first certificate manager: select program, manage recipients, upload/link files, send single/bulk emails, and handle resend/status workflows |
| Speaker Roster | `speaker-roster.html` | Workshops-first speaker roster: select a program (or all programs), then view aggregated speaker ratings with day-level breakdowns, profile modal, and deep links |
| Audit Logs | `audit-logs.html` | Permission-gated audit activity viewer (`audit_logs`) with filters, pagination, and CSV export |
| User Management | `user-management.html` | Permission-gated user account CRUD (`users`) |
| Main Settings | `main-settings.html` | User profile, password, 2FA, rating scales, participant roles, file management, and OCR runtime health check panel in Security tab |
| Import Excel | `import-excell.html` | Excel file upload and import interface |
| Checklist | `checklist.html` | Multi-step document scanning & DepEd checklist verification |
| Code Validation | `code-validation.html` | Verification code entry page |
| QR Generator | `qr-generator.html` | QR code generator for program and evaluation links |
| Forgot Password | `forgot-password.html` | Password reset flow |
| Documents Submitted | `documents-submitted-all.html` | Consolidated school document submission review and status management |
| School Portal Access | `school-portal.html` | School-side sign-in and registration with public/private school toggle, district-to-school cascading selectors, and email verification handoff |
| School Portal Verify | `school-portal-verify.html` | 6-digit email verification flow (submit and resend code) for portal users |
| School Portal Dashboard | `school-portal-dashboard.html` | School document portal with tabs for dashboard, submissions, upload, embedded school-calendar builder, and profile |
| School Calendar Builder | `school-portal-calendar.html` | School portal calendar draft builder/editor with save and apply workflow |
| School Portal Announcements | `school-portal-announcements.html` | School portal announcements page |
| School Portal Audit | `school-portal-audit.html` | School portal audit log view |
| School Portal Calendar Submitted | `school-portal-calendar-submitted.html` | School portal calendar submission review page |
| School Portal Permit | `school-portal-permit.html` | School portal permit workflow page |
| School Portal Profile | `school-portal-profile.html` | School portal profile management page |
| School Portal Submissions | `school-portal-submissions.html` | School portal submissions listing page |
| School Portal Tracker | `school-portal-tracker.html` | School portal tracking dashboard |
| School Portal Tuition | `school-portal-tuition.html` | School portal tuition workflow page |
| School Portal Tuition Submitted | `school-portal-tuition-submitted.html` | School portal tuition submission review page |
| School Portal User Manual | `school-portal-user-manual.html` | School-facing manual for portal workflows |
| Database Viewer | `view-tables.html` | Interactive ERD visualizer & database schema explorer |

### Frontend Architecture

Each page follows the same pattern:
1. **HTML file** — Page structure with sidebar navigation
2. **CSS file** — Page-specific styles (in `css/` directory)
3. **JS file** — Page controller (in `js/` directory)

Global configuration is loaded from `js/config.js` which provides:
- `CONFIG.BASE_URL` — Base application URL
- `CONFIG.API_URL` — API endpoint base URL
- `CONFIG.apiEndpoint(path)` — Helper to build full API URLs

Authentication state in `localStorage` (display/session hints only):
- `user_id` — Logged-in user ID
- `full_name` — User's display name
- `email` — User's email
- `role` — User's role (admin/viewer)
- `permissions` — JSON array of granted permissions

Session token handling:
- `session_token` is stored in an HttpOnly cookie and is not accessible to JavaScript

Permission enforcement is handled client-side by `js/permissions.js`, which auto-detects the current page and hides/restricts unauthorized navigation items.

---

## 10. Key Features

### 10.1 Dual Evaluation System

**Online Evaluations:**
- Configurable per-workshop question forms with drag-to-reorder
- 8 default categories with customizable questions
- Support for 3 question types: rating (1–4 scale), text (open-ended), select (dropdown)
- Per-speaker evaluation questions
- Copy questions between workshops
- Real-time response tracking (10-second polling on dashboard with `check_only` mode)
- Demographic breakdown (gender analysis including LGBTQ+)
- "Save to Records" — compute online workshop results into saved program records via `compute_workshop.php`
- Graceful resubmission handling (`ON DUPLICATE KEY UPDATE`)

**Excel Import:**
- Import legacy evaluation data from `.xlsx`, `.xls`, and `.csv` files
- Multi-sheet support (one sheet per day)
- Configurable column mapping via interactive Column Settings UI
- Auto-detection of rating scales (4-point or 5-point)
- Per-sheet override detection with user-saved precedence logic
- Dynamic column classification (question vs. info based on response ratio & keywords)
- Preview mode (`preview_only=1`) — dry-run without saving
- Automatic computation of averages and result labels
- Saved column mapping configurations (backup/restore as JSON)

### 10.2 QAME Analysis Framework

A unique analytical methodology grouping evaluation categories into 4 dimensions:

| Code | Dimension | Description |
|---|---|---|
| **Q** | Quality | Content quality & delivery effectiveness |
| **A** | Appropriateness | Objectives relevance & attainability |
| **M** | Management | Program operations & logistics |
| **E** | Effectiveness | Speaker impact & overall outcomes |

Each QAME dimension aggregates scores from mapped evaluation categories to provide a high-level quality assessment.

### 10.3 Notification System

- **Notification Bell** — Header bell icon with unread count badge
- **Real-time Updates** — Polls every 30 seconds for new evaluation submissions
- **Dropdown Panel** — Shows recent 20 submissions with participant name, workshop, and time ago
- **Mark as Read** — Click bell or mark-all button to clear unread count
- **Files:**
  - `api/notifications.php` — Backend API
  - `js/notifications.js` — Frontend controller (auto-injects into header)
  - `css/notifications.css` — Styling for bell/dropdown
- **Database:** Uses `users.last_notification_check` column to track read state

### 10.4 Real-Time Dashboard

- Home dashboard cards for totals (workshops, active workshops, responses, imported responses, saved records)
- Recent workshops table with quick navigation to workshop analytics
- Quick Actions panel (programs, import, certificates)
- Recent activity feed from workshop responses and saved records
- Permission-aware access (`dashboard` permission required)
- Data aggregation from `workshops.php`, `records_api.php`, and `imported_responses.php`
- Header OCR runtime status chip:
  - Polls OCR health every 2 minutes and on tab visibility return
  - States: Checking, Healthy, Issues, No Access, Offline/Error
  - Hover/focus popover shows status reason and last checked time
  - Click-to-pin popover for touch devices with outside-click/Escape close
  - Direct "Open Security Settings" action (deep-link to `main-settings.html#security`)

Workshop-level real-time analytics (10-second `check_only` polling, per-question/category breakdown, QAME dimensions, speaker criteria/ranking, and "All Days" toggle) are provided by `workshop-dashboard.html` using `GET /api/dashboard.php`.

### 10.5 Programs Management (Unified)

- Single Programs view combines system workshops and Excel imports using source tagging
- Card/Table layout toggle with persisted preference (`localStorage`)
- Program editor with day-level structure and per-day speaker entries
- Dynamic Program Unit and Nature of Event dropdown options from backend-managed tables
- Evaluation access utilities:
  - Copyable evaluation link generator
  - QR code rendering and PNG download for quick distribution
  - Embedded evaluation form preview modal
- Evaluation question management:
  - Custom question CRUD per workshop
  - Copy questions from another workshop
  - Default question bootstrap on creation
- In-view modal tabs for Overview, Responses, Reports, and Monitoring
- Notification deep-link support (`?open_workshop=<id>&highlight_participant=<id>`) to open a program and highlight a target response row
- Unified record maintenance from Programs page for Excel-source entries (edit/delete record actions routed to records endpoints)
- Summary Report modal:
  - Quarter-filtered aggregate counts (programs, respondents, expected participants, response rate)
  - Breakdowns by quarter, source, status, and unit
  - Word export for generated summary snapshot
- Report utilities directly from Programs view:
  - QAME preview
  - Word export
  - PowerPoint export
  - AI summary generation

#### OCR Runtime Observability

- API-level runtime diagnostics endpoint: `GET /api/ocr-health.php`
- Admin-facing visibility points:
  - Dashboard header OCR chip for at-a-glance status
  - Main Settings Security card for full command output/details
- Runtime checks include:
  - `shell_exec` availability in PHP context
  - Tesseract command/version execution
  - Ghostscript command/version execution
  - Configured OCR binary paths from environment variables

### 10.6 Certificate System

- Workshops-first flow: pick a workshop/program first, then manage recipients and files
- Participant management per workshop (add/edit/delete)
- CSV import of participants (auto-marks attendance as 'attended')
- Certificate email distribution with PDF attachments and template personalization ({name}, {designation})
- Single and bulk email sending with delivery status tracking
- Resend workflow for previously-sent recipients
- Email sent status tracking (`email_sent_at` column)
- File upload management per program with encrypted-at-rest file storage/decryption on download/send
- Splitter integration: split multi-page PDFs, auto-match participants, persist split outputs, and link certificates to participants

### 10.7 Report Generation

- **DOCX Export** — Full evaluation report in Word format
  - Generated via Node.js using the `docx` library
  - Part 1: Detailed category tables, speaker criteria, rating scale reference, signatures
  - Part 2: Evaluation summary, overall ratings, resource person performance, feedback highlights
  - DepEd letterhead formatting with logos and footers
- **CSV Export** — Export responses with sex/participant_type/search filters
- **PDF/Print** — HTML rendering with DepEd letterhead for print output
- **Quality Reports** — Separate Express.js API on port 3001

### 10.8 AI Feedback Summarization

- OpenAI GPT integration
- Summarizes open-ended participant feedback
- Provides improvement suggestions
- Accessible from the dashboard

### 10.9 Evaluation Monitoring

- Tracks per-participant evaluation completion across all days
- Visual completion matrix (checkmark per day)
- Send reminder emails to participants who haven't completed evaluations
- Bulk reminder sending

### 10.10 Configurable Rating Scales

Three scale types with customizable thresholds and descriptive labels:

| Scale Type | Usage |
|---|---|
| `category` | Category-level score interpretation |
| `speaker` | Speaker rating interpretation |
| `overall` | Overall program score interpretation |

Default scale example:
| Range | Label |
|---|---|
| 3.51 – 4.00 | Outstanding |
| 2.51 – 3.50 | Very Satisfactory |
| 1.51 – 2.50 | Satisfactory |
| 1.00 – 1.50 | Needs Improvement |

### 10.11 Speaker Roster

- Workshops-first landing flow: users select a workshop/record (or "All Programs") before speaker list view
- Aggregated speaker performance across live workshops and saved records
- Ratings across 6 criteria per speaker with day-level appearance tags
- Card and table views with search, rating filter, and sort direction toggle
- Speaker profile modal with criteria breakdown, appearance history, and record feedback highlights
- Deep-link support: `?speaker=Name` auto-opens speaker profile after data load
- Overall speaker average and top performer summary cards
- Note: display preference controls (`speaker_display_settings`) are not currently exposed in this page UI

### 10.12 User Management

- Admin can create, update, delete, and toggle user accounts
- Role assignment (admin/viewer)
- Granular permission assignment (dashboard, programs, certificates, speakers, checklist, directory, school_submissions, users, settings, audit_logs)
- Password reset capability
- Profile picture upload

### 10.13 Checklist Scanner

- Multi-step document scanning interface (3 steps)
- Upload school documents (PDF/images) for OCR text extraction
- Upload checklist documents (DOC/DOCX/PDF) for field detection
- Auto-detects header fields: school name, location, recognition number, date, school head, evaluator
- Matches against default DepEd minimum requirements (letter of advice, approved fees, notarized certification, consultations, salary allocation, etc.)
- Auto-populates respondent info fields from extracted data
- Includes a checklist generator modal with editable items, status cycle (blank/✓/✗/N/A), findings/recommendations, and live document-style preview before DOCX export
- Export results for record-keeping

### 10.14 Column Mapping Configurator

- Interactive UI for mapping Excel columns to evaluation categories
- Sample data preview with Day 1 & Day 2 sheet tabs
- Column type selector: score, info, or feedback
- Category assignment per column with range-apply support
- Per-sheet configuration overrides
- Speaker slot configuration (up to 4 speakers × 6 criteria)
- Respondent info field mapping (email, name, sex, designation, school)
- Scale & rating threshold configuration
- Skip sheets list
- Backup/restore configuration as JSON
- Saved column mapping presets via `column_configs` table

### 10.15 Interactive Database Viewer

- Draggable ERD (Entity Relationship Diagram) with zoomable SVG canvas
- 30+ database tables with column types and foreign keys
- Relationship lines with highlighting on hover
- Double-click nodes to switch to detailed table view
- Pan/zoom controls
- Grouped by: core, eval, analytics, auth, files

### 10.16 Documentation Consistency Snapshot (April 6, 2026)

Final parity pass for major operational pages and their APIs:

| Area | Page/API | Current Status | Notes |
|---|---|---|---|
| Dashboard | `dashboard.html`, `js/dashboard.js`, `api/dashboard.php` | ✅ Aligned | Home dashboard aggregation behavior and OCR chip states documented separately from workshop analytics dashboard. |
| Main Settings | `main-settings.html`, `js/main-settings.js`, `api/ocr-health.php` | ✅ Aligned | Security tab OCR health panel and endpoint response expectations documented. |
| Programs | `programs.html`, `js/programs.js`, `api/programs.php` | ✅ Aligned | Unified system+excel list, dropdown option management, ownership/force-delete behaviors documented. |
| Speaker Roster | `speaker-roster.html`, `js/speaker-roster.js`, `api/speaker_roster.php` | ✅ Aligned | Workshops-first flow, all-program aggregation, deep-link behavior, and current API query filters documented. |
| Audit Logs | `audit-logs.html`, `js/audit-logs.js`, `api/audit_logs.php` | ✅ Aligned | Permission-gated page/endpoint behavior (`audit_logs`: filtering, pagination, school lookup list, CSV export) are documented. |
| Certificates | `certificate.html`, `js/certificates.js`, `api/certificates_api.php` | ✅ Aligned | Workshops-first recipient/file flow, resend behavior, and cookie-based auth + permission requirements documented. |
| Certificate Splitter | N/A | ⚠ Removed | The standalone `certificates-splitter.html` page is not present in this workspace. Certificate splitting workflows are handled via `certificate.html` and related export tools. |
| Directory | `directory.html`, `js/directory.js`, `api/directory.php`, `api/private_schools.php` | ⚠ Partial | UI/API flows are documented; current backend permission gate for directory API uses `checklist` permission and private schools API relies on session-only guard. |
| School Portal Access | `school-portal.html`, `js/school-portal.js`, `api/school-login.php`, `api/school-portal-register.php`, `api/get-districts.php`, `api/get-schools.php` | ✅ Aligned | Public/private registration branching, portal-only account guard, and verification token redirect flow are documented. |
| School Portal Verify | `school-portal-verify.html`, inline script, `api/school-portal-verify.php` | ✅ Aligned | 6-digit verification and resend behavior, attempt/rate limits, and post-verify session bootstrap are documented. |
| School Portal Dashboard | `school-portal-dashboard.html`, `js/school-portal-dashboard.js`, `api/school-portal-dashboard.php`, `api/school-portal-upload.php` | ✅ Aligned | Dashboard/read and upload flows are both implemented and documented (cookie-authenticated portal users, type-gated file upload). |
| School Calendar Builder | `school-portal-calendar.html`, `js/school-portal-calendar.js`, `api/school-calendar-documents.php`, `api/school-calendar-save.php` | ✅ Aligned | Portal-integrated calendar draft workflow with saved-document load/edit/delete behavior is documented. |

Scope note:
- This snapshot validates documentation parity with the current implementation state.
- It does not imply ideal security architecture; for example, some endpoints may remain intentionally documented as currently implemented while awaiting hardening refactors.
- Entries marked ⚠ Partial indicate known implementation gaps or non-ideal guards that are intentionally recorded for transparency.

### 10.17 Directory Module (Personnel + Private Schools)

- Page flow (`directory.html` + `js/directory.js`):
  - Auth bootstrap via `GET /api/main-settings.php` to hydrate local user info and permissions.
  - Division tabs (`CID`, `OSDS`, `SGOD`, `LSB`, `School`) and dedicated `Private Schools` tab.
  - Search across names, positions, units, district, school ID, and contacts.
  - Modal-based add/edit/delete for both personnel and private schools.
- API usage:
  - `GET/POST/PUT/DELETE /api/directory.php` for personnel records.
  - `GET/POST/PUT/DELETE /api/private_schools.php` for private school contacts.
- Fallback behavior:
  - If API reads fail or return empty, the page renders built-in seed data for personnel and private schools.
- Implementation note:
  - `api/directory.php` currently enforces `requirePermission('checklist', $authUser)`.

### 10.18 School Portal Access and Verification

- Access page (`school-portal.html` + `js/school-portal.js`):
  - Login posts to `POST /api/school-login.php` (portal-user only; rejects `sdo_personnel` accounts).
  - Registration posts to `POST /api/school-portal-register.php` with role, school metadata, and password.
  - Public/private school toggle:
    - Public flow: `GET /api/get-districts.php` then `GET /api/get-schools.php?district_id=<id>`.
    - Private flow: `GET /api/get-schools.php?type=private`.
  - Both login and registration route unverified users to `school-portal-verify.html?token=...&email=...`.
- Verify page (`school-portal-verify.html` inline script):
  - Verify mode: `POST /api/school-portal-verify.php` with `{ token, code }`.
  - Resend mode: `POST /api/school-portal-verify.php` with `{ token, action: 'resend' }`.
  - Includes 6-digit input UX, resend countdown timer, and success redirect to portal sign-in.

### 10.19 School Portal Dashboard

- Dashboard page (`school-portal-dashboard.html` + `js/school-portal-dashboard.js`):
  - Loads profile/stats/submissions from `GET /api/school-portal-dashboard.php`.
  - Provides tabs for Dashboard, My Submissions, Submit Documents, School Calendar, and Profile.
  - Upload cards validate max size (10MB) and send multipart form data for `tuition` and `calendar` document types.
  - Includes logout (`POST /api/logout.php`) and bfcache/visibility session revalidation.
- Upload endpoint (`api/school-portal-upload.php`):
  - Accepts `POST` multipart form payload with fields: `file` and `type`.
  - Enforces portal-user authentication (`account_type = portal_user`) via cookie session.
  - Validates 10MB max size and type-specific allowed extensions:
    - `tuition`: `pdf`, `doc`, `docx`
    - `calendar`: `pdf`, `doc`, `docx`, `xlsx`, `txt`
  - Persists file to `api/uploads/school_submissions/<user_id>/` and writes a `school_submissions` record with default `pending` status.
- Embedded school calendar submodule:
  - Calendar table supports month rows by term, day counts, month detail modal, and generated summary.
  - School calendar tab is lazily initialized and pre-fills school name from portal session data.

### 10.20 School Calendar Builder (Portal Integrated)

- Page: `school-portal-calendar.html`
- Architecture:
  - Client-side calendar editor integrated into school portal navigation.
  - Supports creating drafts, loading existing drafts, updating calendar content, and deleting drafts.
  - Calendar picker supports month activity marking and save/apply workflow for document generation.
- Output:
  - Saves draft data via portal calendar APIs and supports iterative edits before final document use.

### 10.21 Audit Logs

- Permission-gated audit trail page (`audit-logs.html`) that requires `audit_logs` permission (with access-denied fallback UI)
- Filterable activity feed by search, role, school, action, module, status, date range, and user/school identifiers
- Paginated log browsing (default 50 rows per page)
- CSV export of filtered results (`/api/audit_logs.php?export=csv`)
- School lookup endpoint for filter population (`/api/audit_logs.php?list=schools`)

---

## 11. Third-Party Integrations

### 11.1 PHPMailer / Gmail SMTP

**Library:** `phpmailer/phpmailer` v7.x  
**Helper:** `helpers/EmailHelper.php`

Used for:
- Password reset codes
- Email verification codes
- Evaluation reminder emails
- Certificate distribution (with PDF attachments)

Configuration requires a Gmail account with an App Password.

### 11.2 PhpSpreadsheet

**Library:** `phpoffice/phpspreadsheet` v4.x  
**Used in:** `api/process.php`

Parses `.xlsx`, `.xls`, and `.csv` files with multi-sheet support for importing legacy evaluation data.

### 11.3 Smalot PdfParser

**Library:** `smalot/pdfparser` v2.x  
**Used in:** `api/checklist.php`, `api/extract.php`

Extracts text content from PDF documents for checklist field detection.

### 11.4 PhpWord

**Library:** `phpoffice/phpword` v1.x  
**Used in:** `api/extract.php`

Parses Word documents (DOCX) for checklist text extraction.

### 11.5 Tesseract OCR

**Library:** `thiagoalessio/tesseract_ocr` v2.x  
**Used in:** `api/extract.php` and OCR fallback paths in `api/checklist.php`

OCR text extraction from uploaded images/PDF-derived images for checklist scanning.

Runtime requirement:
- Install the **Tesseract executable** on the host OS and ensure PHP can execute it.

Related runtime tooling:
- `api/extract.php` also uses **Ghostscript** (preferred PDF image conversion path) and optionally **Imagick**.

### 11.6 Node.js DOCX Generation

**Libraries:** `docx` v9.x, `express` v5.x  
**Files:** `export/generate_report.js`, `export/quality_report_api.js`

Generates Word documents from evaluation data. The Express server runs on port 3001.

### 11.7 AI Provider Proxy

**Used in:** `api/ai-proxy.php`

This is the supported AI gateway for checklist and feedback workflows. It reads provider credentials from `.env` and sends Anthropic-compatible requests to the selected backend.

Supported environment variables:
- `GROQ_API_KEY` — primary provider
- `GEMINI_API_KEY` — fallback provider
- `CLOUDFLARE_API_KEY` or `CLOUDFLARE_API_TOKEN` — Cloudflare AI access token
- `CLOUDFLARE_ACCOUNT_ID` — required with Cloudflare AI

The legacy `api/feedback_ai.php` file still contains a hardcoded OpenAI key. It should be treated as deprecated and should not be used in production until the secret is moved to an environment variable.

### 11.8 TCPDF

**Directory:** `TCPDF/`

PDF generation library used for certificate creation.

---

## 12. Configuration

### 12.1 Database Connection — `config/database.php`

`config/database.php` loads database credentials from `.env` and falls back to safe defaults only where appropriate. Use this format in your deployment file:

```env
DB_HOST=localhost
DB_NAME=evaluation_db
DB_USER=root
DB_PASS=
DB_PORT=3306
FILE_ENCRYPTION_KEY=generate_a_long_random_value
```

The file will stop with a server configuration error if `.env` is missing or if `FILE_ENCRYPTION_KEY` is not set.

### 12.2 Frontend Config — `js/config.js`

`js/config.js` computes `BASE_URL` from the current site origin and path, so it works in both local and deployed subdirectory installs. It also exposes the derived API and AI proxy endpoints:

- `CONFIG.BASE_URL`
- `CONFIG.API_URL`
- `CONFIG.AI_PROXY_URL`
- `CONFIG.EXTRACT_URL`

`DEBUG_MODE` should be set to `false` in production builds.

### 12.3 Email Settings — `helpers/EmailHelper.php`

Configure Gmail SMTP:
- SMTP Host: `smtp.gmail.com`
- SMTP Port: `587` (TLS)
- Username: Your Gmail address
- Password: Gmail App Password

### 12.4 AI Keys and Provider Routing

Add provider credentials to `.env` so the server can inject them at runtime:

```env
GROQ_API_KEY=your_groq_key_here
GEMINI_API_KEY=your_gemini_key_here
CLOUDFLARE_API_KEY=your_cloudflare_key_here
CLOUDFLARE_ACCOUNT_ID=your_cloudflare_account_id_here
```

If you keep the legacy OpenAI-based feedback script, move its key out of the PHP file immediately and load it from an environment variable instead.

### 12.5 Import Settings — `eval_settings` Table

Managed via the Settings UI or `api/settings_api.php`. Controls:
- Column-to-category mappings for Excel import
- Speaker column slots
- Rating thresholds
- Category names and order

### 12.6 OCR Binary Paths — Environment Variables

OCR binaries are configurable through `.env`:

```env
TESSERACT_BIN=C:\Program Files\Tesseract-OCR\tesseract.exe
GHOSTSCRIPT_BIN=C:\Program Files\gs\gs10.06.0\bin\gswin64c.exe
```

Behavior:
- `api/extract.php` reads `TESSERACT_BIN` and `GHOSTSCRIPT_BIN` from environment values first, then uses built-in defaults.
- `api/checklist.php` reads `TESSERACT_BIN` (fallback command: `tesseract`).

If `TESSERACT_BIN` is not resolvable on the host, OCR operations fail at runtime.

---

## 13. Deployment Notes

### Production Checklist

- [ ] Set `DEBUG_MODE: false` in `js/config.js`
- [ ] Update `BASE_URL` to production domain in `js/config.js`
- [ ] Move database credentials, encryption keys, and AI provider keys to `.env`
- [ ] Update database credentials in the deployment `.env` file
- [ ] Configure proper email SMTP credentials outside source control
- [ ] Remove any hardcoded OpenAI or other AI keys from PHP files
- [ ] Set up HTTPS (SSL certificate)
- [ ] Install OCR runtime binaries (Tesseract, Ghostscript)
- [ ] Set `TESSERACT_BIN` and `GHOSTSCRIPT_BIN` in deployment `.env` (or ensure defaults match host paths)
- [ ] Verify PHP can execute OCR binaries (`tesseract --version`, Ghostscript version command)
- [ ] Restrict database access (don't use root with no password)
- [ ] Remove/protect development tools:
  - `view-tables.html` / `api/view-tables-api.php`
  - `api/test.php`, `api/test-forgot-password.php`
- [ ] Set proper file permissions on `api/uploads/`
- [ ] Configure Apache virtual host with proper `AllowOverride`
- [ ] Start the Node.js report server as a service (`export/quality_report_api.js`)
- [ ] Run `composer install --no-dev` for production
- [ ] Set up database backups

### OCR Deployment (Tesseract and Ghostscript)

#### Windows Server

1. Install Tesseract OCR (default path: `C:\Program Files\Tesseract-OCR\tesseract.exe`).
2. Install Ghostscript (default path similar to `C:\Program Files\gs\<version>\bin\gswin64c.exe`).
3. Set binary paths in `.env`:
  - `TESSERACT_BIN=C:\Program Files\Tesseract-OCR\tesseract.exe`
  - `GHOSTSCRIPT_BIN=C:\Program Files\gs\<version>\bin\gswin64c.exe`
4. Verify commands from a shell accessible to the web server user:
  - `tesseract --version`
  - `gswin64c -v`
5. Restart Apache/PHP after installation.

#### Linux Server

Install packages (example for Debian/Ubuntu):

```bash
sudo apt-get update
sudo apt-get install -y tesseract-ocr ghostscript
```

Then set `.env` binary paths for Linux, for example:
- `TESSERACT_BIN=/usr/bin/tesseract`
- `GHOSTSCRIPT_BIN=/usr/bin/gs`

Optional:
- Install `php-imagick` to enable additional OCR fallback routes in `api/extract.php`.

#### Post-Deploy OCR Validation

Run these checks:

```bash
composer install --no-dev
php -m
tesseract --version
```

Then test:
- Upload a scanned PDF in Checklist Scanner (`/api/checklist.php?action=scan_checklist`)
- Upload a PDF or DOCX through the extract flow (`/api/extract.php`)
- Call OCR health endpoint (`/api/ocr-health.php`) to confirm PHP runtime can execute OCR binaries

### Security Considerations

**Authentication Security:**
- Session tokens stored in HttpOnly cookies (JavaScript cannot access)
- Cookies use `SameSite=Strict` to prevent CSRF attacks
- `Secure` flag enabled in production (HTTPS only)
- Session tokens are 100 hex characters (50 random bytes)
- Constant-time password verification prevents timing attacks

**Secret Handling:**
- Database credentials, encryption keys, and AI provider keys are read from `.env`
- `.env` is blocked from web access by Apache rules and should never be committed
- AI requests are proxied server-side so provider keys never reach the browser

**Rate Limiting:**
- `login_attempts` table tracks failed login attempts
- IP-based lockout: 5 failed attempts triggers 15-minute lockout
- Client-side lockout provides immediate feedback without server roundtrip

**Password Security:**
- All passwords hashed with bcrypt (`password_hash()`, `password_verify()`)
- Minimum password requirements enforced
- Password reset uses time-limited 6-digit codes

**SQL Injection Protection:**
- PDO prepared statements used throughout
- Parameterized queries for all user input

**XSS Protection:**
- Content-Security-Policy headers restrict script sources
- X-XSS-Protection header enables browser XSS filter
- X-Content-Type-Options prevents MIME sniffing

**File Upload Security:**
- Dangerous extensions blocked (php, exe, js, etc.)
- `api/.htaccess` prevents PHP execution in uploads directory
- File extension whitelist validation

**Additional Headers:**
- X-Frame-Options: DENY (prevents clickjacking)
- Referrer-Policy: strict-origin-when-cross-origin

**CORS Configuration:**
- Origin whitelist (not `*` in production)
- `Access-Control-Allow-Credentials: true` for cookie auth
- Proper OPTIONS preflight handling

---

### CORS & Upload Configuration

The root `.htaccess` file configures:
- Upload limits: 50MB max filesize, 300s timeout
- `RewriteEngine On` for URL rewriting

The `api/.htaccess` file adds:
- Authorization header pass-through to PHP
- Block access to sensitive files (`.log`, `.bak`, `.sql`, `.env`, `.ini`)
- Prevent PHP execution in `uploads/` directory
- Security headers (X-Content-Type-Options, X-Frame-Options, X-XSS-Protection)
- Disable directory listing

CORS is now handled dynamically by `config/security.php`:
- Origin whitelist (localhost in dev, your domain in production)
- `Access-Control-Allow-Credentials: true` for cookie authentication
- Proper Vary header for caching

---

*This documentation was generated from the QATALYST codebase as of March 8, 2026.*
