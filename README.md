# QATALYST

QATALYST is a PHP and JavaScript-based evaluation and monitoring system for workshop reporting, records, certificates, and analytics.

## Quick Setup

1. Copy [.env.example](.env.example) to `.env`.
2. Fill in the database values and required secrets:
	- `DB_HOST`, `DB_NAME`, `DB_USER`, `DB_PASS`, `DB_PORT`
	- `FILE_ENCRYPTION_KEY`
	- Email settings: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_FROM_EMAIL`, `SMTP_FROM_NAME`
	- AI provider keys: `GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_KEY` or `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`
3. Run `composer install`.
4. Run `npm install` if you need the Node.js report generator.
5. Import your existing QATALYST base schema into MariaDB/MySQL, then apply the required scripts in `migrations/`. This repository contains incremental migrations; the complete base schema is not included.

## Documentation

See [DOCUMENTATION.md](DOCUMENTATION.md) for the full setup guide, architecture, API reference, security notes, and deployment checklist.

## First Run

After Apache and MariaDB are running in XAMPP, open the app at `http://localhost/public_html`. If you use the DOCX report generator, start the Node.js service from the `export/` folder as described in [DOCUMENTATION.md](DOCUMENTATION.md).

## Changelog

### 2026-04-06

- Updated setup and security documentation for environment-based database, encryption, and AI provider keys.
- Expanded OCR deployment documentation for Windows/Linux and added post-deploy runtime verification guidance.
- Added OCR runtime diagnostics endpoint: `GET /api/ocr-health.php` (permission-gated).
- Added Main Settings Security tab OCR Runtime Health card with command output details.
- Added Dashboard OCR status chip with hover/focus details, touch-friendly pin behavior, and deep-link to Security settings.
