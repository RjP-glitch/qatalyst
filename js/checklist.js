const API_URL = CONFIG.API_URL;
let expandedMenus = {};

window.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');

    checkAuthentication().then(isAuthenticated => {
        if (!isAuthenticated) return;
        setupUploadZone('pdfZone', 'pdfFile', handlePdfFile);
    });
});

async function checkAuthentication() {
    const cachedUserId = localStorage.getItem('user_id');
    let fullName = localStorage.getItem('full_name');
    let email = localStorage.getItem('email');

    try {
        const res = await fetch(`${CONFIG.API_URL}/main-settings.php`, {
            credentials: 'include'
        });

        if (!res.ok) { clearSessionAndRedirect(); return false; }

        const json = await res.json();
        if (!json.success || !json.data?.id) { clearSessionAndRedirect(); return false; }

        if (json.data) {
            if (json.data.id) localStorage.setItem('user_id', String(json.data.id));
            if (json.data.full_name) { fullName = json.data.full_name; localStorage.setItem('full_name', json.data.full_name); }
            if (json.data.email) { email = json.data.email; localStorage.setItem('email', json.data.email); }
            if (json.data.role) localStorage.setItem('role', json.data.role);
            if (json.data.account_type) localStorage.setItem('account_type', json.data.account_type);
            if (Array.isArray(json.data.permissions)) {
                localStorage.setItem('permissions', JSON.stringify(json.data.permissions));
            }
        }

        if (json.data?.account_type === 'portal_user') {
            window.location.href = 'school-portal-dashboard.html';
            return false;
        }

        if (json.data?.profile_picture) {
            const avatar = document.getElementById('sidebarAvatar');
            if (avatar) {
                avatar.innerHTML = `<img src="${json.data.profile_picture}"
                    style="width:100%;height:100%;object-fit:cover;border-radius:50%;"
                    alt="Profile">`;
            }
        }

    } catch (e) {
        console.warn('Session validation network error:', e);
        if (!cachedUserId) { clearSessionAndRedirect(); return false; }
    }

    if (typeof Permissions !== 'undefined') {
        await Permissions.loadRolePermissions();
    }

    if (typeof Permissions !== 'undefined' && !Permissions.has('checklist')) {
        const fallbackRoutes = [
            { perm: 'dashboard', url: 'dashboard.html' },
            { perm: 'certificates', url: 'certificate.html' },
            { perm: 'programs', url: 'programs.html' },
            { perm: 'speakers', url: 'speaker-roster.html' },
            { perm: 'users', url: 'user-management.html' },
            { perm: 'settings', url: 'main-settings.html' },
        ];
        const target = fallbackRoutes.find(r => Permissions.has(r.perm));
        window.location.href = target ? target.url : 'login.html';
        return false;
    }

    if (typeof Permissions !== 'undefined') {
        Permissions.applyNavPermissions();
    }

    loadUserInfo(fullName, email);

    const overlay = document.getElementById('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');

    return true;
}

function clearSessionAndRedirect() {
    ['user_id', 'email', 'full_name', 'role', 'permissions', 'account_type']
        .forEach(k => localStorage.removeItem(k));
    window.location.replace('login.html');
}

function loadUserInfo(fullName, email) {
    const initial = fullName ? fullName.charAt(0).toUpperCase() : 'U';
    const avatar = document.getElementById('sidebarAvatar');
    if (avatar && !avatar.querySelector('img')) avatar.textContent = initial;
    const nameEl = document.getElementById('sidebarUserName');
    const emailEl = document.getElementById('sidebarUserEmail');
    if (nameEl) nameEl.textContent = fullName || 'User';
    if (emailEl) emailEl.textContent = email || '';
}

async function loadProfilePicture() {
    try {
        const res = await fetch(CONFIG.API_URL + '/main-settings.php', { credentials: 'include' });
        const json = await res.json();
        if (json.success && json.data.profile_picture) {
            document.getElementById('sidebarAvatar').innerHTML = `<img src="${json.data.profile_picture}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;" alt="Profile">`;
        }
    } catch (e) { }
}

// ──────────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────────────
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function showMsg(id, msg, type) { const el = document.getElementById(id); if (!el) return; el.textContent = msg; el.className = 'msg-box visible ' + type; }
function hideMsg(id) { const el = document.getElementById(id); if (el) el.className = 'msg-box'; }
function goStep(n) {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.step-tab').forEach(t => t.classList.remove('active'));
    document.getElementById('panel-' + n).classList.add('active');
    document.querySelector('[data-step="' + n + '"]').classList.add('active');
    window.scrollTo({ top: 0, behavior: 'smooth' });
}
function markStepDone(n) { document.querySelector('[data-step="' + n + '"]').classList.add('done'); }

// ──────────────────────────────────────────────────────────────────────────────
// AI API PROXY CALL
// ──────────────────────────────────────────────────────────────────────────────
async function callAI(body) {
    const proxyUrl = (typeof CONFIG !== 'undefined' && CONFIG.AI_PROXY_URL)
        ? CONFIG.AI_PROXY_URL
        : '/api/ai-proxy.php';

    // Attach the user-selected AI provider so the proxy can honour it.
    // Falls back to 'auto' (Groq → Gemini → Cloudflare chain) if not set.
    const provider = (typeof window._selectedAiProvider !== 'undefined')
        ? window._selectedAiProvider
        : 'auto';

    const response = await fetch(proxyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...body, ai_provider: provider })
    });

    if (!response.ok) {
        const err = await response.text().catch(() => response.statusText);
        throw new Error('AI request failed: ' + err);
    }

    return response.json();
}

// ──────────────────────────────────────────────────────────────────────────────
// STATE
// ──────────────────────────────────────────────────────────────────────────────
const state = {
    pdfFile: null,
    extractedText: '',
    checklistType: 'tuition_increase',
    matchedData: {},
    checklistItems: [],   // [{id, text, found, remark}]
    complianceScore: 0,
    aiSummary: '',
    overallStatus: '',
    savedReportId: null,  // ID returned after saving to DB
    calendarMonths: [],   // [{month, year, stated_days, computed_days, holidays:[{date,name}], status, note}]
    feeTables: [],        // [{category, line_items, stated_total, computed_total, match}]
    ra6728: null,         // {total_incremental, teaching_70_*, facilities_20_*, scholarship_10_*}
};

// ──────────────────────────────────────────────────────────────────────────────
// CHECKLIST DEFINITIONS
// ──────────────────────────────────────────────────────────────────────────────
const CHECKLIST_DEFAULTS = {
    tuition_increase: [
        { id: 1, text: 'Date received by DepEd RO III (submission on or before May 15)' },
        { id: 2, text: 'Letter of advice to the Regional Office signed by the School Head' },
        { id: 3, text: 'Xerox copy of approved tuition, miscellaneous and other school fees (previous SY)' },
        { id: 4, text: 'Comparative Schedule of tuition, miscellaneous and other school fees' },
        { id: 5, text: 'Percentage of increase of tuition/miscellaneous and other fees clearly stated' },
        { id: 6, text: 'Certification under Oath (notarized) signed by School Head — RA 6728 compliance' },
        { id: '6a', text: '(a) Consultations conducted with PTA/PTCA and Faculty Association with minutes' },
        { id: '6b', text: '(b) 70% of incremental proceeds to salaries/wages/benefits of teaching personnel' },
        { id: '6c', text: '(c) 20% to improvement/modernization of buildings, equipment, libraries' },
        { id: '6d', text: '(d) 10% to student fund/scholarship' },
        { id: 7, text: 'Certificate of No Delinquency in payment of teachers\' salaries' },
        { id: 8, text: 'Board Resolution approving the proposed increase (for non-stock/non-profit schools)' },
        { id: 9, text: 'Latest Audited Financial Statement (AFS)' },
        { id: 10, text: 'SEC/DOLE Registration or other corporate papers' },
        { id: 11, text: 'Government Recognition / Permit Number on file' },
        { id: 'T1', text: 'Fee table arithmetic check: individual fee line items add up correctly to the stated total tuition/miscellaneous amount for each level or category' },
        { id: 'T2', text: 'Incremental proceeds allocation check: the stated peso amounts for the 70%/20%/10% breakdown (RA 6728) are arithmetically consistent with the total incremental proceeds figure' },
    ],
    no_increase: [
        { id: 1, text: 'Letter declaring No Increase in tuition and other fees for the school year' },
        { id: 2, text: 'Comparative fee schedule showing previous SY and current SY (same amounts)' },
        { id: 3, text: 'Signed certification by School Head' },
        { id: 4, text: 'Government Recognition / Permit Number on file' },
        { id: 5, text: '1st Indorsement from the Schools Division' },
    ],
    // ── SCHOOL CALENDAR — updated with strict 200–220 day range and holiday exclusion rules
    school_calendar: [
        { id: 1, text: 'Board Resolution approving the school calendar signed by the Board and School Head' },
        { id: 2, text: 'Total school days is between 200 and 220 days (DepEd required range — must not be below 200 or above 220)' },
        { id: 3, text: 'Opening of classes date explicitly specified in the calendar' },
        { id: 4, text: 'National holidays and non-working days are explicitly listed AND excluded from the total school day count' },
        { id: 5, text: 'Three-term or semester breakdown provided with individual day counts that add up to the stated total' },
        { id: 6, text: 'SEC Registration or Government Recognition / Permit Number attached or referenced' },
        { id: 7, text: 'Document signed by both the School Head and Board representative' },
        { id: 8, text: 'Per-month school day counts are arithmetically correct (each month\'s stated days match actual weekdays minus declared holidays for that month)' },
    ],
};

const FIELD_DEFS = [
    {
        key: 'schoolName', label: 'Name of School',
        extract(t) {
            function cleanSchool(v) {
                if (!v) return '';
                return cv(v.replace(/\s*(Location|Address|SY|School\s*Year|Permit|Recognition|Date|Processed|Evaluated|Validated)[^\w].*$/i, '').trim());
            }
            // Skip DepEd agency / division lines
            const skipPat = /department\s+of\s+education|schools\s+division|division\s+of\s+(city|province)|region\s+iii|deped\s+ro/i;

            // Explicit label
            for (const pat of [/name\s+of\s+school\s*[:\-]?\s*([A-Z][A-Z\s\-&'.]{4,80})/i]) {
                const m = t.match(pat);
                if (m && !skipPat.test(m[1])) return cleanSchool(m[1]);
            }
            // School-type keyword — pick first match NOT from a DepEd agency line
            const all = [...t.matchAll(/\b([A-Z][A-Z\s]{3,50}(?:ACADEMY|SCHOOL|INSTITUTE|COLLEGE|UNIVERSITY|CENTER)[A-Z\s,]*(?:INC\.?)?)\b/g)];
            for (const m of all) {
                if (!skipPat.test(m[1])) return cleanSchool(m[1]);
            }
            return '';
        }
    },
    {
        key: 'location', label: 'Location / Address',
        extract(t) {
            // Truncate a raw match at sentence-boundary/legal boilerplate bleed-over
            function trimAddr(v) {
                if (!v) return '';
                // Stop at legal/narrative phrases that signal we've gone past the address
                v = v.replace(/\s*[,.]?\s*(?:being\s+the|hereinafter|referred\s+to|a\s+corporation|duly\s+organized|existing\s+under|after\s+being|do\s+hereby).*/i, '');
                // Stop at a second sentence starting with a capital after a period
                v = v.replace(/\.\s+[A-Z].*$/, '');
                return v.trim().replace(/[,.\s]+$/, '');
            }
            function isGarbled(v) {
                if (!v) return true;
                // Reject calendar/event text
                if (/\b(term|quarter|semester|onset|educators|framer)\b/i.test(v)) return true;
                // Reject unmatched parentheses
                if (/\([^)]{0,5}$/.test(v)) return true;
                // Must have at least 2 real words
                if (v.trim().split(/\s+/).length < 2) return true;
                // Reject if more than 12 words (likely bled into body text)
                if (v.trim().split(/\s+/).length > 12) return true;
                return false;
            }

            // 1. Explicit location label
            for (const p of [
                /location\s*[\/\-:]\s*address\s*[:\-]?\s*([^\n\r]{5,120})/i,
                /location\s*[:\-]\s*([^\n\r]{5,120})/i,
            ]) { const m = t.match(p); if (m) { const v = trimAddr(m[1]); if (!isGarbled(v)) return cv(v); } }

            // 2. "Complete Address:" — used in DepEd permit docs
            const ca = t.match(/complete\s+addr\w*\s*[:\-]?\s*([^\n\r]{5,120})/i);
            if (ca) { const v = trimAddr(ca[1]); if (!isGarbled(v)) return cv(v); }

            // 3. "with address at <number> <street>, <city>" — from Board Resolution / SEC docs
            //    Capture ONLY the address portion, stop before legal continuation
            const withAddr = t.match(/with\s+address\s+at\s+(\d[\w\s.,#\-]{5,80}(?:Baliwag|Baliuag|Bulacan|Pampanga|Manila|City)[^,.\n\r]{0,40})/i);
            if (withAddr) { const v = trimAddr(withAddr[1]); if (!isGarbled(v)) return cv(v); }

            // 4. "Address:" — skip email/tel lines
            const addrM = t.match(/(?<![Ee][-\s]?mail\s{0,5})\baddress\s*[:\-]\s*([^\n\r]{5,120})/);
            if (addrM && !/@/.test(addrM[1]) && !/\btel\b/i.test(addrM[1])) {
                const v = trimAddr(addrM[1]); if (!isGarbled(v)) return cv(v);
            }

            // 5. Physical: street number + St./Ave. anchored to Philippine locality
            const phys = t.match(/\b(\d+\/?\w*\s+[\w&.\s]+?(?:Bldg|Building|St(?:reet)?|Ave(?:nue)?|Road|Barangay|Brgy)\.?[^@\n\r]{0,60}(?:Baliwag|Baliuag|Bulacan|Pampanga|Manila|City)[^@\n\r]{0,40})/i);
            if (phys) { const v = trimAddr(phys[1]); if (!isGarbled(v)) return cv(v); }

            // 6. Poblacion/City pattern
            const city = t.match(/\b(Poblacion\s*,\s*[\w\s]+(?:City|Bulacan|Pampanga)[^\n\r]{0,60})/i);
            if (city) return cv(city[1]);

            return '';
        }
    },
    {
        key: 'syApplied', label: 'SY Applied For',
        extract(t) { for (const p of [/sy\s+applied\s+for\s*[:\-]?\s*([^\n\r]{1,30})/i, /school\s+year\s*[:\-]\s*([^\n\r]{1,30})/i]) { const m = t.match(p); if (m) return cv(m[1]); } const s = t.match(/\b(20\d{2}\s*[-–]\s*20\d{2})\b/); return s ? cv(s[1]) : '' }
    },
    {
        key: 'govRecogNo', label: 'Government Recognition No.',
        extract(t) {
            // Clean raw match: keep only the recognition code (e.g. "E-025 s. 1996")
            // Stop at any word that looks like OCR garbage (3+ consecutive consonants, or non-alphanumeric noise)
            function cleanRecog(v) {
                if (!v) return '';
                v = cv(v);
                // Truncate at obvious OCR garbage words — e.g. "Pane ese Tt 1" after the real number
                // Keep: letters, digits, spaces, hyphens, dots, "s." year patterns
                // Stop when we see words that are clearly not part of a recog number
                v = v.replace(/\s+(?:[A-Z][a-z]{2,}\s+){2,}.*$/, ''); // 2+ title-case words in a row = boilerplate
                v = v.replace(/\s+\w{4,}\s+\w{4,}\s+.*$/, '');         // two long words in a row = likely noise
                return cv(v);
            }
            // Score: prefer match that looks like a real recog code (letter-digits-s.year)
            function looksLikeRecog(v) {
                return /[A-Z]\s*[-–]\s*\d{2,4}\s*s\.?\s*\d{4}/i.test(v) || /No\.\s*\d{3,}/i.test(v);
            }
            const candidates = [];
            for (const p of [
                // Letterhead format: "Gov. Recog. No. E – 025 s. 1996"
                /gov(?:ernment)?\.?\s+recog(?:nition)?\.?\s+no\.?\s*([^\n\r]{1,50})/i,
                // "Recog. No. E-025 s. 1996"
                /recog\.?\s+no\.?\s*([^\n\r]{1,50})/i,
                // "Recognition No. ..."
                /(?:government\s+)?recognition\s+no\s*[\.:\-]?\s*([^\n\r]{1,50})/i,
                /recog(?:nition)?\s*(?:no|#)[\s\.:\-]*([^\n\r]{1,50})/i,
            ]) {
                const m = t.match(p);
                if (m) { const v = cleanRecog(m[1]); if (v) candidates.push(v); }
            }
            // Prefer a candidate that matches the expected format; discard all if none qualify
            const best = candidates.find(looksLikeRecog) || '';
            if (best) return best;
            return nl(t, 'recognition no', 0);
        }
    },
    {
        key: 'govPermitNo', label: 'Government Permit No.',
        extract(t) {
            for (const p of [
                /(?:government\s+)?permit\s+no\s*[\.:\-]?\s*([^\n\r]{1,50})/i,
                /SHSP\s+No\.?\s*([\w\s,\.]+)/i,   // catches "SHSP No. 534, s.2015"
            ]) { const m = t.match(p); if (m) return cv(m[1]); }
            return nl(t, 'permit no', 0);
        }
    },
    {
        key: 'dateReceived', label: 'Date Received',
        extract(t) {
            const currentYear = new Date().getFullYear();
            const m = t.match(/date\s+received\s*[:\-]?\s*([^\n\r]{1,40})/i);
            if (m) return cv(m[1]);
            // Date fallback — only accept years within ±5 of today
            const d = t.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+(\d{4}))\b/i);
            if (d) {
                const yr = parseInt(d[2]);
                if (yr >= currentYear - 5 && yr <= currentYear + 2) return cv(d[1]);
            }
            return '';
        }
    },
    {
        key: 'schoolHead', label: 'School Head / Principal',
        extract(t) {
            const junk = /HEREAT|BEFORE\s+ME|BALIWAG|BULACAN|SERIES|BOOK\s+NO|PAGE\s+NO|NOTARY|SUBSCRIBED|SWORN|CLEY|CamScanner|ROWENA|QUIAMBAO|MALLARI|AMIN|CAPUYAN|MENDOZA/i;
            // A name must: not be junk, have at least one word of 3+ clean alpha chars,
            // not contain digits, not be mostly lowercase (OCR garble like "alleostsiogt")
            function okName(v) {
                if (!v || junk.test(v)) return null;
                const clean = cv(v);
                if (!clean) return null;
                // Reject if it contains digits
                if (/\d/.test(clean)) return null;
                // Reject if any word looks like OCR garble: 5+ chars but >60% lowercase
                const words = clean.split(/[\s,]+/);
                for (const w of words) {
                    if (w.length >= 5 && !/^(LPT|EdD|PhD|MA|MS|MRS?|DR|ATTY|ENGR|JR|SR)$/i.test(w)) {
                        const lower = (w.match(/[a-z]/g) || []).length;
                        const upper = (w.match(/[A-Z]/g) || []).length;
                        // Mostly lowercase in an otherwise all-caps context = OCR garble
                        if (lower > upper && lower > 3) return null;
                    }
                }
                // Must have at least one word of 3+ alphabetic characters
                if (!words.some(w => /^[A-Za-z]{3,}/.test(w))) return null;
                return clean;
            }
            // Name with credential above "Prepared by:" block
            const prep = t.match(/prepared\s+by\s*:?\s*\n?\s*((?:MRS?|MS|DR|ATTY|ENGR|LPT)\.?\s+[A-Z][A-Z\s.\/]{3,60})/i);
            if (prep) { const n = okName(prep[1]); if (n) return n; }
            // Any name directly above "Principal" or "School Head" label
            const abovePrincipal = t.match(/([A-Z][A-Z\s.,\/]{5,60}(?:LPT|EdD|PhD|MA|MS)?)\s*\n[^\n]{0,40}(?:School\s*(?:Head|Principal)|Principal)/i);
            if (abovePrincipal) { const n = okName(abovePrincipal[1]); if (n) return n; }
            // "Prepared by:" followed by a name on the next line
            const prepLine = t.match(/prepared\s+by\s*:?\s*\n\s*([A-Z][A-Z\s.,]{5,60})\s*\n/i);
            if (prepLine) { const n = okName(prepLine[1]); if (n) return n; }
            const sh = t.match(/school\s+head\s*[:\-]\s*([A-Z][^\n\r,]{3,60})/i);
            if (sh) { const n = okName(sh[1]); if (n) return n; }
            const ti = t.match(/\b((?:MRS?|MS|DR|ATTY|ENGR)\.?\s+[A-Z][A-Z\s.]{3,50})\b/ig);
            if (ti) { for (const m of ti) { const n = okName(m); if (n) return n; } }
            return '';
        }
    },
    {
        key: 'evaluatedBy', label: 'Processed / Evaluated By',
        extract(t) { for (const p of [/(?:processed|evaluated)\s*(?:\/\s*(?:evaluated|processed))?\s*by\s*[:\-]?\s*([A-Z][^\n\r]{3,100})/i]) { const m = t.match(p); if (m) return cv(m[1]); } const s = t.match(/([A-Z][A-Z\s.,]+(?:PhD|MA|MS|Dr\.)?)?\s*\n?\s*(?:Chief|SGOD|In-Charge)/i); return s ? cv(s[1]) : '' }
    },
];

function cv(v) { if (!v) return ''; v = v.trim().replace(/^[\s:\-_\/]+/, '').replace(/[\s:\-_\/]+$/, '').replace(/\s{2,}/g, ' ').trim(); return (v.length < 2 || /^[_\-\s]+$/.test(v)) ? '' : v; }
function nl(text, label, offset) { const lines = text.split('\n'); for (let i = 0; i < lines.length; i++) { if (lines[i].toLowerCase().includes(label.toLowerCase())) { const t = lines[i + offset]; if (t) return cv(t); } } return ''; }

// ──────────────────────────────────────────────────────────────────────────────
// CHECKLIST TYPE
// ──────────────────────────────────────────────────────────────────────────────
function setChecklistType(type, btn) {
    state.checklistType = type;
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
}

// ──────────────────────────────────────────────────────────────────────────────
// UPLOAD ZONE
// ──────────────────────────────────────────────────────────────────────────────
function setupUploadZone(zoneId, inputId, handler) {
    const zone = document.getElementById(zoneId), input = document.getElementById(inputId);
    if (!zone || !input) return;
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
    input.addEventListener('change', () => { if (input.files[0]) handler(input.files[0]); });
}

function handlePdfFile(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const allowed = ['pdf', 'docx', 'jpg', 'jpeg', 'png', 'webp'];
    if (!allowed.includes(ext)) {
        alert('Please upload a PDF, DOCX, JPG, JPEG, PNG, or WEBP file.');
        return;
    }

    const iconMap = { jpg: 'IMG', jpeg: 'IMG', png: 'IMG', webp: 'IMG' };
    state.pdfFile = file;
    document.getElementById('pdfIcon').textContent = iconMap[ext] || ext.toUpperCase();
    document.getElementById('pdfName').textContent = file.name;
    document.getElementById('pdfPill').classList.add('visible');
    document.getElementById('extractPdfBtn').disabled = false;
    hideMsg('pdfMsg');
    state.extractedText = '';
    document.getElementById('step1Preview').style.display = 'none';
    const continueBtn = document.getElementById('step1ContinueBtn');
    if (continueBtn) continueBtn.disabled = true;
}

function removePdf() {
    state.pdfFile = null; state.extractedText = '';
    document.getElementById('pdfFile').value = '';
    document.getElementById('pdfPill').classList.remove('visible');
    document.getElementById('extractPdfBtn').disabled = true;
    document.getElementById('step1Preview').style.display = 'none';
    const continueBtn = document.getElementById('step1ContinueBtn');
    if (continueBtn) continueBtn.disabled = true;
    hideMsg('pdfMsg');
}

// ──────────────────────────────────────────────────────────────────────────────
// OCR CORRECTIONS PANEL — Shows before/after spelling fixes applied to the text
// ──────────────────────────────────────────────────────────────────────────────
function renderOcrCorrectionsPanel(corrections) {
    // Find or create the panel container (injected right before the step1Preview button row)
    let panel = document.getElementById('ocrCorrectionsPanel');
    if (!panel) {
        const preview = document.getElementById('step1Preview');
        if (!preview) return;
        panel = document.createElement('div');
        panel.id = 'ocrCorrectionsPanel';
        panel.style.cssText = 'margin-top:12px;';
        preview.parentNode.insertBefore(panel, preview);
    }

    if (!corrections || corrections.length === 0) {
        panel.innerHTML = `
            <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;
                background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;
                font-size:13px;color:#16a34a;margin-bottom:12px;">
                <span style="font-size:15px;">✓</span>
                <span>No OCR spelling errors detected — extracted text looks clean.</span>
            </div>`;
        return;
    }

    const rows = corrections.map(c => `
        <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;align-items:center;
            padding:7px 10px;border-bottom:0.5px solid #e5e7eb;font-size:13px;">
            <span style="color:#dc2626;font-family:monospace;background:#fef2f2;
                padding:2px 6px;border-radius:4px;word-break:break-all;">${esc(c.original || '—')}</span>
            <span style="color:#16a34a;font-family:monospace;background:#f0fdf4;
                padding:2px 6px;border-radius:4px;word-break:break-all;">${esc(c.corrected || '—')}</span>
            <span style="color:#6b7280;font-size:11px;white-space:nowrap;">${esc(c.reason || '')}</span>
        </div>`).join('');

    panel.innerHTML = `
        <div style="border:1px solid #bfdbfe;border-radius:8px;overflow:hidden;margin-bottom:12px;">
            <div style="display:flex;align-items:center;justify-content:space-between;
                padding:9px 14px;background:#eff6ff;cursor:pointer;"
                onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none';">
                <span style="font-size:13px;font-weight:600;color:#1d4ed8;">
                    <i class="fa-solid fa-spell-check" style="margin-right:6px;"></i>
                    ${corrections.length} OCR Spelling Correction${corrections.length !== 1 ? 's' : ''} Applied
                </span>
                <span style="font-size:11px;color:#3b82f6;">click to expand ▾</span>
            </div>
            <div style="display:none;">
                <div style="display:grid;grid-template-columns:1fr 1fr auto;gap:8px;
                    padding:6px 10px;background:#f8fafc;border-bottom:0.5px solid #e2e8f0;">
                    <span style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Original (garbled)</span>
                    <span style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Corrected</span>
                    <span style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.04em;">Reason</span>
                </div>
                ${rows}
                <div style="padding:8px 12px;font-size:11px;color:#6b7280;background:#f8fafc;">
                    Numbers, amounts, dates, and table structure were preserved exactly.
                </div>
            </div>
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 1 — Extract text from document via AI
// ──────────────────────────────────────────────────────────────────────────────
const LOADER_MESSAGES = [
    'Reading document with AI…',
    'Identifying text and structure…',
    'Extracting school information…',
    'Almost done…'
];

let _extractAbortController = null;

function _makeAbortError() {
    const err = new Error('Scanning stopped by user.');
    err.name = 'AbortError';
    return err;
}

function _buildExtractUrl(baseUrl, { stream = false } = {}) {
    try {
        const u = new URL(baseUrl, window.location.origin);
        if (stream) {
            u.searchParams.set('stream', '1');
        } else {
            u.searchParams.delete('stream');
        }
        return u.toString();
    } catch (e) {
        if (stream) {
            return baseUrl.includes('?') ? `${baseUrl}&stream=1` : `${baseUrl}?stream=1`;
        }

        return baseUrl
            .replace(/([?&])stream=1(?:&|$)/i, '$1')
            .replace(/[?&]$/, '')
            .replace('?&', '?');
    }
}

async function _extractFileNonStreaming(file, extractUrl, signal) {
    const formData = new FormData();
    formData.append('document', file);

    const res = await fetch(_buildExtractUrl(extractUrl, { stream: false }), {
        method: 'POST',
        credentials: 'include',
        body: formData,
        signal,
    });

    const raw = await res.text();
    let json = null;

    try {
        json = JSON.parse(raw);
    } catch (e) {
        const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const evt = JSON.parse(lines[i]);
                if (evt?.event === 'done') {
                    json = evt;
                    break;
                }
                if (evt?.event === 'error') {
                    throw new Error(evt.message || 'Extraction error.');
                }
            } catch (_) { }
        }
    }

    if (!json) {
        throw new Error(`Extraction endpoint returned invalid JSON (HTTP ${res.status}).`);
    }

    if (!res.ok || json?.error) {
        throw new Error(json?.error || `Extraction failed (HTTP ${res.status}).`);
    }

    return json;
}

function _isPdfFile(file) {
    return !!(file && String(file.name || '').toLowerCase().endsWith('.pdf'));
}

function _inferQualityFromText(text) {
    const trimmed = String(text || '').trim();
    const words = (trimmed.match(/\b\w+\b/g) || []).length;
    const charCount = trimmed.length;

    if (!trimmed || charCount < 30) {
        return {
            status: 'unreadable',
            reason: 'No meaningful text detected from image OCR.',
            char_count: charCount,
            word_count: words,
        };
    }

    if (words < 5) {
        return {
            status: 'sparse',
            reason: 'Very few words detected from image OCR.',
            char_count: charCount,
            word_count: words,
        };
    }

    return {
        status: 'ok',
        reason: null,
        char_count: charCount,
        word_count: words,
    };
}

function _summarizeQualityFromPages(pages) {
    const totalPages = pages.length || 1;
    const badPages = pages.filter(p => (p.quality?.status || 'unreadable') !== 'ok').length;
    const pct = badPages / totalPages;

    let warning = null;
    if (pct >= 0.5) {
        warning = `${Math.round(pct * 100)}% of pages have quality issues — document may not be reliably scannable. Upload a cleaner copy for accurate AI results.`;
    } else if (pct >= 0.3) {
        warning = `${Math.round(pct * 100)}% of pages have quality issues — AI results may be incomplete for affected pages.`;
    }

    return {
        total_pages: totalPages,
        unreadable: badPages,
        unreadable_pct: Math.round(pct * 100),
        scannable: pct < 0.5,
        warning,
    };
}

async function _canvasToPngFile(canvas, fileName) {
    const blob = await new Promise((resolve, reject) => {
        canvas.toBlob(b => {
            if (!b) {
                reject(new Error('Failed to convert PDF page canvas to image blob.'));
                return;
            }
            resolve(b);
        }, 'image/png', 1);
    });

    return new File([blob], fileName, { type: 'image/png' });
}

async function _extractImageFileWithApi(imageFile, extractUrl, signal) {
    const formData = new FormData();
    formData.append('document', imageFile);

    const res = await fetch(_buildExtractUrl(extractUrl, { stream: false }), {
        method: 'POST',
        credentials: 'include',
        body: formData,
        signal,
    });

    const raw = await res.text();
    let json = null;
    try {
        json = JSON.parse(raw);
    } catch (e) {
        throw new Error(`Image OCR response was not valid JSON (HTTP ${res.status}).`);
    }

    if (!res.ok || json?.error) {
        throw new Error(json?.error || `Image OCR request failed (HTTP ${res.status}).`);
    }

    return json;
}

async function _extractPdfViaImageFallback(pdfFile, extractUrl, signal) {
    if (typeof pdfjsLib === 'undefined') {
        throw new Error('PDF-to-image fallback requires PDF.js, but it is not loaded.');
    }

    const buf = await pdfFile.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    const total = pdf.numPages;
    const baseName = String(pdfFile.name || 'document').replace(/\.pdf$/i, '');

    _spvSetTotalPages(total);

    const pages = [];
    const textParts = [];

    for (let pageNum = 1; pageNum <= total; pageNum++) {
        if (_spvStopped || (signal && signal.aborted)) {
            throw _makeAbortError();
        }

        _spvUpdateDot('', `PDF fallback OCR: converting page ${pageNum} of ${total}…`);

        const page = await pdf.getPage(pageNum);
        const viewport = page.getViewport({ scale: 2.0 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);

        await page.render({
            canvasContext: canvas.getContext('2d'),
            viewport,
        }).promise;

        const imageFile = await _canvasToPngFile(canvas, `${baseName}_page_${pageNum}.png`);

        _spvUpdateDot('', `PDF fallback OCR: extracting text from page ${pageNum}…`);
        const pageResult = await _extractImageFileWithApi(imageFile, extractUrl, signal);

        const pageText = String(pageResult?.text || '').trim();
        const pageQuality = pageResult?.pages?.[0]?.quality || _inferQualityFromText(pageText);

        pages.push({ page: pageNum, text: pageText, quality: pageQuality });
        textParts.push(pageText);

        await _spvReceivePage(pageNum, total, pageText, pageQuality);
    }

    const combinedText = textParts.filter(Boolean).join('\n\n').trim();

    return {
        event: 'done',
        text: combinedText,
        length: combinedText.length,
        pages,
        scan_quality: _summarizeQualityFromPages(pages),
    };
}

async function extractAndAnalyse() {
    if (!state.pdfFile) { showMsg('pdfMsg', '⚠ Please upload a document first.', 'error'); return; }

    const btn = document.getElementById('extractPdfBtn');
    const loader = document.getElementById('pdfLoader');
    btn.disabled = true;
    loader.classList.add('visible');
    hideMsg('pdfMsg');
    hideScanQualityPanel();

    // Build the UI shell + PDF.js thumbnails
    showScanProgress(state.pdfFile);

    const extractUrl = (typeof CONFIG !== 'undefined' && CONFIG.EXTRACT_URL)
        ? CONFIG.EXTRACT_URL
        : '/api/extract.php';

    // Accumulate data across stream events
    let extractData = null;
    _extractAbortController = new AbortController();

    try {
        document.getElementById('pdfLoaderMsg').textContent =
            'Extracting document with standard mode…';
        extractData = await _extractFileNonStreaming(
            state.pdfFile,
            extractUrl,
            _extractAbortController ? _extractAbortController.signal : undefined
        );

        // Extraction returned no payload
        if (!extractData) throw new Error('Extraction ended without a completion payload.');

        let finalText = String(extractData.text || '').trim();

        // If server-side PDF extraction is empty, convert pages to images client-side and OCR them.
        if (!finalText && _isPdfFile(state.pdfFile)) {
            document.getElementById('pdfLoaderMsg').textContent =
                'No PDF text found. Converting PDF pages to images for OCR fallback…';
            extractData = await _extractPdfViaImageFallback(
                state.pdfFile,
                extractUrl,
                _extractAbortController ? _extractAbortController.signal : undefined
            );
            finalText = String(extractData.text || '').trim();
        }

        // If page events were empty but final OCR fallback produced text,
        // populate preview from the final text so the page view is not misleading.
        const hasPerPageText = Array.isArray(_spvPageTexts)
            && _spvPageTexts.some(t => String(t || '').trim() !== '');
        if (!hasPerPageText && finalText !== '') {
            _spvPageTexts = [finalText];
            _spvTotalPages = 1;
            _spvCurrentPage = 0;
            _spvUpdatePager();
        }

        // Finish the scan UI (show quality panel, hide progress)
        _spvFinish();

        if (extractData.pages || extractData.scan_quality) {
            renderScanQualityPanel(
                extractData.pages || [],
                extractData.scan_quality || {},
                state.pdfFile.name
            );
        }

        hideScanProgress();

        const extracted = (extractData.text || '').trim();
        if (!extracted) throw new Error('No text could be extracted from the document.');

        // ── OCR Spell-Correction ──────────────────────────────────────────────
        // Ask the AI to fix OCR-introduced misspellings in the raw extracted text
        // before it is stored, so that downstream field extraction and validation
        // both operate on clean text. The AI also returns a list of corrections
        // made so we can show the user exactly what was changed.
        let cleanedText = extracted;
        let ocrCorrections = []; // [{original, corrected, context}]
        try {
            document.getElementById('pdfLoaderMsg').textContent = 'Correcting OCR spelling errors…';
            const correctionResp = await callAI({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 4096,
                messages: [{
                    role: 'user',
                    content:
                        `You are an OCR post-processor for Philippine school documents (DepEd Region III).\n` +
                        `The text below was extracted from a scanned document via OCR and likely contains:\n` +
                        `  - Misspelled words from low-resolution scanning (e.g. "Schoo1" → "School", "Principa1" → "Principal")\n` +
                        `  - Garbled proper nouns (school names, city names, person names)\n` +
                        `  - Split or merged words caused by OCR errors\n` +
                        `  - Corrupted numbers mixed into words (e.g. "Ba1iuag" → "Baliuag")\n\n` +
                        `INSTRUCTIONS:\n` +
                        `  1. Fix ALL clear OCR misspellings — prioritise words that look like corrupted Filipino/English words.\n` +
                        `  2. Preserve ALL numbers, amounts, dates, and table structure exactly — do NOT change any numeric value.\n` +
                        `  3. Preserve the original line breaks, spacing, and paragraph structure.\n` +
                        `  4. Do NOT add, remove, or paraphrase any content — only fix obvious OCR errors.\n` +
                        `  5. If a word is ambiguous and may not be an error, leave it unchanged.\n\n` +
                        `Return ONLY a valid JSON object (no markdown, no extra text) in this exact format:\n` +
                        `{\n` +
                        `  "corrected_text": "<the full corrected text with all OCR fixes applied>",\n` +
                        `  "corrections": [\n` +
                        `    { "original": "<garbled word/phrase>", "corrected": "<fixed word/phrase>", "reason": "<brief reason e.g. digit-letter confusion>" }\n` +
                        `  ]\n` +
                        `}\n` +
                        `If no corrections were needed, return an empty corrections array.\n\n` +
                        `EXTRACTED TEXT:\n"""\n${extracted}\n"""`
                }]
            });
            const raw = (correctionResp.content || []).map(b => b.text || '').join('').trim();
            const clean = raw.replace(/```json|```/g, '').trim();
            let parsed = null;
            try { parsed = JSON.parse(clean); } catch (_) { }

            if (parsed && parsed.corrected_text && parsed.corrected_text.length > extracted.length * 0.5) {
                cleanedText = parsed.corrected_text;
                ocrCorrections = Array.isArray(parsed.corrections) ? parsed.corrections : [];
            }
        } catch (e) {
            // Spell-correction is best-effort — fall back to raw extracted text
            console.warn('OCR spell-correction failed, using raw text:', e);
        }
        // ─────────────────────────────────────────────────────────────────────

        state.extractedText = cleanedText;
        state.matchedData = {};
        FIELD_DEFS.forEach(def => { const v = def.extract(cleanedText); if (v) state.matchedData[def.key] = v; });
        state.checklistItems = CHECKLIST_DEFAULTS[state.checklistType].map(i => ({ ...i, found: null, remark: '' }));

        const words = cleanedText.match(/\b\w+\b/g) || [];
        const sourceExt = ((state.pdfFile?.name || '').split('.').pop() || '').toLowerCase();
        const sourceType = sourceExt === 'pdf'
            ? 'PDF'
            : (sourceExt === 'docx' ? 'DOCX' : 'Image');

        document.getElementById('pdfPreviewStats').innerHTML =
            `<div class="summary-chip" style="background:#fff7ed;color:#9a3412;border-color:#fdba74;">
                <span>${sourceType}</span> source type
            </div>` +
            `<div class="summary-chip"><span>${cleanedText.length.toLocaleString()}</span> characters</div>` +
            `<div class="summary-chip"><span>${words.length.toLocaleString()}</span> words</div>` +
            (ocrCorrections.length
                ? `<div class="summary-chip" style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;">
                       <span>${ocrCorrections.length}</span> OCR correction${ocrCorrections.length !== 1 ? 's' : ''} applied
                   </div>`
                : `<div class="summary-chip" style="background:#f0fdf4;color:#16a34a;border-color:#bbf7d0;">
                       <span>✓</span> No OCR errors found
                   </div>`);
        document.getElementById('pdfPreviewText').textContent = cleanedText;

        // ── OCR Corrections Panel ──────────────────────────────────────────────
        renderOcrCorrectionsPanel(ocrCorrections);
        // ──────────────────────────────────────────────────────────────────────

        document.getElementById('step1Preview').style.display = 'block';

        const continueBtn = document.getElementById('step1ContinueBtn');
        if (continueBtn) continueBtn.disabled = false;

        const qualityWarning = extractData.scan_quality?.warning;
        showMsg('pdfMsg',
            qualityWarning
                ? '⚠ Document extracted with quality warnings. Review the scan quality panel below before proceeding.'
                : '✓ Document extracted and spell-corrected. Proceed to Step 2 to review and validate.',
            qualityWarning ? 'warning' : 'success'
        );

        markStepDone(1);
        renderStep2Fields();
        renderChecklistEditor();

    } catch (err) {
        const wasStopped = _spvStopped || (err && err.name === 'AbortError');
        if (wasStopped) {
            hideScanProgress();
            showMsg('pdfMsg', '⚠ Scanning stopped by user.', 'warning');
        } else {
            _spvFinish();
            hideScanProgress();
            showMsg('pdfMsg', '⚠ ' + (err.message || 'Extraction failed.'), 'error');
        }
    } finally {
        _extractAbortController = null;
        loader.classList.remove('visible');
        btn.disabled = false;
    }
}

// Called when 'start' event arrives — we know total pages now
function _spvSetTotalPages(total) {
    _spvTotalPages = total;
    _spvUpdatePager();
    _spvUpdateDot('', 'Extracting text…');

    // Pre-create empty thumbnail slots so user sees how many pages to expect
    const strip = document.getElementById('spvThumbStrip');
    if (!strip) return;
    strip.innerHTML = '';
    for (let i = 0; i < total; i++) {
        const d = document.createElement('div');
        d.className = 'spv-thumb spv-thumb--pending' + (i === 0 ? ' spv-thumb--active' : '');
        d.id = 'spvThumb_' + i;
        d.onclick = (idx => () => _spvJumpPage(idx))(i);
        const pg = document.createElement('div');
        pg.className = 'spv-thumb-pg';
        pg.textContent = i + 1;
        d.appendChild(pg);
        strip.appendChild(d);
    }

    // Mark first thumb as currently scanning
    const t0 = document.getElementById('spvThumb_0');
    if (t0) t0.classList.add('spv-thumb--scanning');
}

// Called when each 'page' event arrives from the stream
async function _spvReceivePage(pageNum, total, text, quality) {
    const idx = pageNum - 1;

    // Store the text so Prev/Next can show it
    _spvPageTexts[idx] = text;

    // Update total in case start event hadn't arrived yet
    if (total > _spvTotalPages) {
        _spvTotalPages = total;
        _spvUpdatePager();
    }

    // ── Advance the scan line to this page's position ──
    // Each page occupies an equal slice of the frame height
    const targetPct = (pageNum / total) * 100;
    _spvAnimateScanLineTo(targetPct);

    // ── Update status label ──
    _spvUpdateDot('', `Scanning page ${pageNum} of ${total}…`);
    const badge = document.getElementById('spvPageBadge');
    if (badge) badge.textContent = 'Page ' + pageNum;

    // ── Show this page's text in the text box (typing animation) ──
    if (pageNum === _spvCurrentPage + 1 || pageNum === 1) {
        _spvCurrentPage = idx;
        _spvUpdatePager();
        _spvSetPageText(idx, true);
    }

    // ── Render thumbnail for this page using PDF.js if available ──
    const thumb = document.getElementById('spvThumb_' + idx);
    if (thumb) {
        thumb.classList.remove('spv-thumb--scanning', 'spv-thumb--pending');

        // Status color based on quality
        const s = quality?.status || 'ok';
        if (s !== 'ok') thumb.style.borderColor = s === 'unreadable' ? '#ef4444' : '#f59e0b';

        // Mark next page as scanning
        const nextThumb = document.getElementById('spvThumb_' + (idx + 1));
        if (nextThumb) nextThumb.classList.add('spv-thumb--scanning');
    }

    // Render real PDF thumbnail via PDF.js if we have the file loaded
    if (typeof pdfjsLib !== 'undefined' && state.pdfFile && thumb) {
        try {
            // Reuse cached pdf doc if possible
            if (!window._spvPdfDoc) {
                const buf = await state.pdfFile.arrayBuffer();
                window._spvPdfDoc = await pdfjsLib.getDocument({ data: buf }).promise;
            }
            const page = await window._spvPdfDoc.getPage(pageNum);

            // Thumbnail
            const tvp = page.getViewport({ scale: 0.15 });
            const tc = document.createElement('canvas');
            tc.width = tvp.width;
            tc.height = tvp.height;
            await page.render({ canvasContext: tc.getContext('2d'), viewport: tvp }).promise;
            if (thumb.querySelector('canvas')) thumb.querySelector('canvas').replaceWith(tc);
            else thumb.insertBefore(tc, thumb.querySelector('.spv-thumb-pg'));

            // Main canvas — only update if this is the page currently displayed
            if (idx === _spvCurrentPage) {
                const mainCanvas = document.getElementById('spvCanvas');
                if (mainCanvas) {
                    const mvp = page.getViewport({ scale: 0.75 });
                    mainCanvas.width = mvp.width;
                    mainCanvas.height = mvp.height;
                    await page.render({ canvasContext: mainCanvas.getContext('2d'), viewport: mvp }).promise;
                }
            }
        } catch (e) { /* PDF.js render failed — thumbnail stays blank */ }
    }
}

// Smoothly animate the scan line to a target percentage
function _spvAnimateScanLineTo(targetPct) {
    cancelAnimationFrame(_spvRaf);
    const frame = document.getElementById('spvPageFrame');

    function tick() {
        if (_spvStopped || _spvPaused) return;
        const fh = frame ? frame.offsetHeight : 300;
        const gap = targetPct - _spvScanPct;
        if (Math.abs(gap) < 0.3) { _spvScanPct = targetPct; }
        else { _spvScanPct += gap * 0.08; } // ease toward target

        const px = (_spvScanPct / 100) * fh;
        const line = document.getElementById('spvLine');
        const glow = document.getElementById('spvGlow');
        const overlay = document.getElementById('spvOverlay');
        if (line) line.style.top = px + 'px';
        if (glow) glow.style.top = (px - 48) + 'px';
        if (overlay) overlay.style.height = _spvScanPct + '%';

        if (_spvScanPct < targetPct) _spvRaf = requestAnimationFrame(tick);
    }
    _spvRaf = requestAnimationFrame(tick);
}

// Called when the stream finishes (success or error)
function _spvFinish() {
    cancelAnimationFrame(_spvRaf);
    clearInterval(_spvTypingTimer);
    // Snap scan line to bottom to show complete
    const line = document.getElementById('spvLine');
    const glow = document.getElementById('spvGlow');
    const overlay = document.getElementById('spvOverlay');
    if (overlay) overlay.style.height = '100%';
    if (line) line.style.top = '100%';
    if (glow) glow.style.top = 'calc(100% - 48px)';
    _spvUpdateDot('done', 'Extraction complete');
    const stopBtn = document.getElementById('spvStopBtn');
    if (stopBtn) { stopBtn.disabled = true; stopBtn.style.opacity = '0.45'; }
    // Show final page text without typing animation
    _spvSetPageText(_spvCurrentPage, false);
}

// ──────────────────────────────────────────────────────────────────────────────
// SCAN PROGRESS — Animated panel shown while backend processes the file
// ──────────────────────────────────────────────────────────────────────────────
let _scanProgressInterval = null;
let _scanCurrentStep = 1;

// ──────────────────────────────────────────────────────────────────────────────
// SCAN PREVIEW PANEL  — page-by-page live preview while backend extracts
// ──────────────────────────────────────────────────────────────────────────────
let _spvPaused = false;
let _spvStopped = false;
let _spvRaf = null;
let _spvTypingTimer = null;
let _spvCurrentPage = 0;
let _spvTotalPages = 0;
let _spvPageTexts = [];   // filled from backend pages[] after extraction
let _spvScanPct = 0;
let _spvFrameH = 300;

// Called immediately when user clicks Extract — renders the UI shell.
function showScanProgress(file) {
    const panel = document.getElementById('scanProgressPanel');
    if (!panel) return;
    _spvPaused = false; _spvStopped = false; _spvCurrentPage = 0;
    _spvTotalPages = 0; _spvPageTexts = []; _spvScanPct = 0;

    const isPdf = file.name.toLowerCase().endsWith('.pdf');
    const isDocx = file.name.toLowerCase().endsWith('.docx');
    const hasPdfJs = typeof pdfjsLib !== 'undefined';

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="spv-wrap">
            <div class="spv-left">
                <div class="spv-page-frame" id="spvPageFrame">
                    <div class="spv-scan-overlay" id="spvOverlay"></div>
                    <div class="spv-scan-glow"    id="spvGlow"></div>
                    <div class="spv-scan-line"    id="spvLine"></div>
                    ${(isPdf && hasPdfJs)
            ? `<canvas id="spvCanvas" class="spv-page-canvas" width="220" height="300"></canvas>`
            : `<div class="spv-no-preview">
                               <i class="fa-solid fa-${isDocx ? 'file-word' : 'file-pdf'}"></i>
                               <span>Page preview not available for ${isDocx ? 'DOCX' : 'this file'}</span>
                           </div>`
        }
                    <div class="spv-page-badge" id="spvPageBadge">Page 1</div>
                </div>
                <div class="spv-thumb-strip" id="spvThumbStrip"></div>
            </div>
            <div class="spv-right">
                <div class="spv-status-row">
                    <div class="spv-status-dot" id="spvDot"></div>
                    <span id="spvStatusLabel">Extracting text…</span>
                </div>
                <div class="spv-text-box" id="spvTextBox">Waiting for backend…</div>
                <div class="spv-pager">
                    <button class="spv-pager-btn" id="spvPrev" onclick="_spvGoPage(-1)" disabled>Prev</button>
                    <div class="spv-pager-num" id="spvPagerNum">—</div>
                    <button class="spv-pager-btn" id="spvNext" onclick="_spvGoPage(1)"  disabled>Next</button>
                </div>
                <div class="spv-controls">
                    <button class="spv-ctrl-btn" onclick="_spvTogglePlay()" title="Play / Pause">
                        <span id="spvPlayIcon">&#10074;&#10074;</span>
                    </button>
                    <span class="spv-ctrl-hint" id="spvHint">Scanning — review extracted text page by page</span>
                    <button class="spv-stop-btn" id="spvStopBtn" onclick="_spvStop()">
                        Stop Scanning <span class="spv-stop-icon"></span>
                    </button>
                </div>
            </div>
        </div>`;

    // Start live scan animation immediately (cosmetic — syncs with real backend)
    if (isPdf && hasPdfJs) {
        _spvRenderThumbnailsAndAnimate(file);
    } else {
        _spvAnimateScanLine(null, 0);
    }
}

// Called by extractAndAnalyse() at step 2 and step 3 — kept for compatibility.
function advanceScanStep(step) {
    // Map old step numbers to status label
    const labels = { 2: 'Extracting pages & running OCR…', 3: 'Analysing scan quality…' };
    const lbl = document.getElementById('spvStatusLabel');
    if (lbl && labels[step]) lbl.textContent = labels[step];
}

// Called when extraction completes (success or error).
function hideScanProgress() {
    cancelAnimationFrame(_spvRaf);
    clearInterval(_spvTypingTimer);
    const panel = document.getElementById('scanProgressPanel');
    if (panel) panel.style.display = 'none';
}

// ── After extraction: populate per-page text from backend data ──
// Call this with extractData.pages[] so the text box shows real content.
function _spvPopulatePageTexts(pages) {
    if (!Array.isArray(pages) || !pages.length) return;
    _spvTotalPages = pages.length;
    _spvPageTexts = pages.map(p => (p.text || '').trim());
    _spvCurrentPage = 0;
    _spvUpdatePager();
    _spvSetPageText(_spvCurrentPage, false);

    // Rebuild thumbnails label-only (canvas already rendered, just update badges)
    pages.forEach((p, i) => {
        const thumb = document.getElementById('spvThumb_' + i);
        if (thumb) {
            thumb.classList.remove('spv-thumb--scanning', 'spv-thumb--pending');
            const statusCls = (p.quality?.status === 'ok' || !p.quality?.status) ? '' : 'spv-thumb--pending';
            if (statusCls) thumb.classList.add(statusCls);
        }
    });
    _spvUpdateDot('done', 'Extraction complete');
}

// ── Render thumbnails via PDF.js and start scan line animation ──
async function _spvRenderThumbnailsAndAnimate(file) {
    const strip = document.getElementById('spvThumbStrip');
    if (!strip) return;

    let pdf;
    try {
        const buf = await file.arrayBuffer();
        pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    } catch (e) {
        // PDF.js failed — degrade gracefully, scan line still animates
        _spvAnimateScanLine(null, 0);
        return;
    }

    _spvTotalPages = pdf.numPages;
    _spvUpdatePager();

    // Create all thumb slots up front
    for (let i = 0; i < pdf.numPages; i++) {
        const d = document.createElement('div');
        d.className = 'spv-thumb ' + (i === 0 ? 'spv-thumb--active' : 'spv-thumb--pending');
        d.id = 'spvThumb_' + i;
        d.onclick = (idx => () => _spvJumpPage(idx))(i);
        const pg = document.createElement('div');
        pg.className = 'spv-thumb-pg';
        pg.textContent = i + 1;
        d.appendChild(pg);
        strip.appendChild(d);
    }

    // Render pages one by one (sequential so user sees them appear)
    for (let i = 0; i < pdf.numPages; i++) {
        if (_spvStopped) break;
        const thumb = document.getElementById('spvThumb_' + i);
        if (thumb) thumb.classList.add('spv-thumb--scanning');

        try {
            const page = await pdf.getPage(i + 1);
            const vp = page.getViewport({ scale: 0.15 });
            const tc = document.createElement('canvas');
            tc.width = vp.width; tc.height = vp.height;
            await page.render({ canvasContext: tc.getContext('2d'), viewport: vp }).promise;
            if (thumb) {
                thumb.insertBefore(tc, thumb.querySelector('.spv-thumb-pg'));
                thumb.classList.remove('spv-thumb--scanning', 'spv-thumb--pending');
            }

            // Also draw full-size on main canvas if this is the current page
            if (i === _spvCurrentPage) {
                const mainCanvas = document.getElementById('spvCanvas');
                if (mainCanvas) {
                    const mvp = page.getViewport({ scale: 0.75 });
                    mainCanvas.width = mvp.width;
                    mainCanvas.height = mvp.height;
                    await page.render({ canvasContext: mainCanvas.getContext('2d'), viewport: mvp }).promise;
                    _spvFrameH = mainCanvas.height;
                    if (i === 0) _spvAnimateScanLine(mainCanvas, i);
                }
            }
        } catch (e) {
            if (thumb) thumb.classList.remove('spv-thumb--scanning');
        }
    }
}

// ── Animate the green scan line down the main canvas ──
function _spvAnimateScanLine(canvas, pageIdx) {
    _spvScanPct = 0;
    cancelAnimationFrame(_spvRaf);

    const frame = document.getElementById('spvPageFrame');
    function tick() {
        if (_spvStopped) return;
        if (_spvPaused) { _spvRaf = requestAnimationFrame(tick); return; }

        const fh = frame ? frame.offsetHeight : _spvFrameH;
        _spvScanPct = Math.min(_spvScanPct + 0.55, 100);
        const px = (_spvScanPct / 100) * fh;

        const line = document.getElementById('spvLine');
        const glow = document.getElementById('spvGlow');
        const overlay = document.getElementById('spvOverlay');
        if (line) line.style.top = px + 'px';
        if (glow) glow.style.top = (px - 48) + 'px';
        if (overlay) overlay.style.height = _spvScanPct + '%';

        if (_spvScanPct < 100) {
            _spvRaf = requestAnimationFrame(tick);
        }
        // When done the backend result will call _spvPopulatePageTexts
    }
    _spvRaf = requestAnimationFrame(tick);
}

// ── Text box: type out text for the given page ──
function _spvSetPageText(idx, animate) {
    const box = document.getElementById('spvTextBox');
    if (!box) return;
    const full = _spvPageTexts[idx] || '';
    if (!animate || !full) {
        box.textContent = full || (_spvStopped
            ? 'No text extracted for this page.'
            : 'No direct text detected yet for this page. OCR fallback may still complete in the final result.');
        return;
    }
    clearInterval(_spvTypingTimer);
    let chars = 0;
    box.innerHTML = '';
    _spvTypingTimer = setInterval(() => {
        if (_spvPaused) return;
        chars = Math.min(chars + 4, full.length);
        box.innerHTML = esc(full.slice(0, chars)) +
            (chars < full.length ? '<span class="spv-cursor"></span>' : '');
        box.scrollTop = box.scrollHeight;
        if (chars >= full.length) clearInterval(_spvTypingTimer);
    }, 25);
}

// ── Pager ──
function _spvGoPage(dir) {
    const n = _spvCurrentPage + dir;
    if (n < 0 || n >= _spvTotalPages) return;
    _spvJumpPage(n);
}

function _spvJumpPage(idx) {
    _spvCurrentPage = idx;
    document.getElementById('spvPageBadge').textContent = 'Page ' + (idx + 1);
    _spvUpdatePager();
    _spvSetPageText(idx, false);
    // Update thumb highlights
    for (let i = 0; i < _spvTotalPages; i++) {
        const t = document.getElementById('spvThumb_' + i);
        if (t) t.classList.toggle('spv-thumb--active', i === idx);
    }
}

function _spvUpdatePager() {
    const num = document.getElementById('spvPagerNum');
    const prev = document.getElementById('spvPrev');
    const next = document.getElementById('spvNext');
    if (num) num.textContent = _spvTotalPages ? (_spvCurrentPage + 1) + ' / ' + _spvTotalPages : '—';
    if (prev) prev.disabled = _spvCurrentPage === 0;
    if (next) next.disabled = _spvCurrentPage >= _spvTotalPages - 1;
}

// ── Play / Pause ──
function _spvTogglePlay() {
    _spvPaused = !_spvPaused;
    const icon = document.getElementById('spvPlayIcon');
    const hint = document.getElementById('spvHint');
    const dot = document.getElementById('spvDot');
    if (icon) icon.innerHTML = _spvPaused ? '&#9654;' : '&#10074;&#10074;';
    if (hint) hint.textContent = _spvPaused
        ? 'Paused — click play to resume'
        : 'Scanning — review extracted text page by page';
    if (dot) { dot.className = 'spv-status-dot' + (_spvPaused ? ' idle' : ''); }
    if (!_spvPaused) _spvAnimateScanLine(null, _spvCurrentPage);
}

// ── Stop ──
function _spvStop() {
    _spvStopped = true;
    if (_extractAbortController) {
        try { _extractAbortController.abort(); } catch (e) { }
    }
    cancelAnimationFrame(_spvRaf);
    clearInterval(_spvTypingTimer);
    const line = document.getElementById('spvLine');
    const glow = document.getElementById('spvGlow');
    const overlay = document.getElementById('spvOverlay');
    const stopBtn = document.getElementById('spvStopBtn');
    const hint = document.getElementById('spvHint');
    if (line) { line.style.top = '-2px'; }
    if (glow) { glow.style.top = '-48px'; }
    if (overlay) { overlay.style.height = '0%'; }
    if (stopBtn) { stopBtn.disabled = true; }
    if (hint) { hint.textContent = 'Stopped — use Prev / Next to review pages'; }
    _spvUpdateDot('idle', 'Scan stopped');
}

function _spvUpdateDot(cls, label) {
    const dot = document.getElementById('spvDot');
    const lbl = document.getElementById('spvStatusLabel');
    if (dot) dot.className = 'spv-status-dot ' + cls;
    if (lbl) lbl.textContent = label;
}


// ──────────────────────────────────────────────────────────────────────────────
// SCAN QUALITY PANEL — Per-page results rendered after extraction completes
// ──────────────────────────────────────────────────────────────────────────────
function hideScanQualityPanel() {
    const el = document.getElementById('scanQualityPanel');
    if (el) el.style.display = 'none';
}

function renderScanQualityPanel(pages, quality, fileName) {
    const panel = document.getElementById('scanQualityPanel');
    if (!panel) return;

    const totalPages = quality.total_pages || pages.length || 1;
    const badPages = quality.unreadable || 0;
    const goodPages = totalPages - badPages;
    const scannable = quality.scannable !== false;

    // ── Banner ──
    let banner;
    if (!scannable) {
        banner = `<div class="sqp-banner sqp-banner--danger">
            <span class="sqp-banner-icon">⛔</span>
            <div>
                <strong>Document may not be scannable</strong>
                <p>${esc(quality.warning || 'Too many unreadable pages were detected.')}</p>
            </div>
        </div>`;
    } else if (quality.warning) {
        banner = `<div class="sqp-banner sqp-banner--warning">
            <span class="sqp-banner-icon">⚠</span>
            <div>
                <strong>Scan quality warning</strong>
                <p>${esc(quality.warning)}</p>
            </div>
        </div>`;
    } else {
        banner = `<div class="sqp-banner sqp-banner--ok">
            <span class="sqp-banner-icon">✅</span>
            <div>
                <strong>All ${totalPages} page${totalPages !== 1 ? 's' : ''} scanned successfully</strong>
                <p>No quality issues detected — AI analysis should be accurate.</p>
            </div>
        </div>`;
    }

    // ── Summary chips ──
    const chips = `
        <div class="sqp-chips">
            <div class="sqp-chip sqp-chip--total">
                <span class="sqp-chip-num">${totalPages}</span>
                <span class="sqp-chip-lbl">total pages</span>
            </div>
            <div class="sqp-chip sqp-chip--ok">
                <span class="sqp-chip-num">${goodPages}</span>
                <span class="sqp-chip-lbl">readable</span>
            </div>
            ${badPages > 0 ? `
            <div class="sqp-chip sqp-chip--bad">
                <span class="sqp-chip-num">${badPages}</span>
                <span class="sqp-chip-lbl">with issues</span>
            </div>` : ''}
        </div>`;

    // ── Per-page list (only show if more than 1 page or there are issues) ──
    let pageList = '';
    if (pages.length > 1 || pages.some(p => p.quality.status !== 'ok')) {
        const statusMeta = {
            ok: { icon: '✓', label: 'Readable', cls: 'sqp-page--ok' },
            blurred: { icon: '〰', label: 'Blurred', cls: 'sqp-page--blurred' },
            sparse: { icon: '◌', label: 'Sparse', cls: 'sqp-page--sparse' },
            unreadable: { icon: '✗', label: 'Unreadable', cls: 'sqp-page--unreadable' },
        };

        const rows = pages.map(p => {
            const s = p.quality.status || 'ok';
            const m = statusMeta[s] || statusMeta.ok;
            const wc = p.quality.word_count ?? '?';
            return `
                <div class="sqp-page-row ${m.cls}">
                    <span class="sqp-page-icon">${m.icon}</span>
                    <span class="sqp-page-num">Page ${p.page}</span>
                    <span class="sqp-page-status">${m.label}</span>
                    <span class="sqp-page-words">${wc} words</span>
                    ${p.quality.reason
                    ? `<span class="sqp-page-reason">${esc(p.quality.reason)}</span>`
                    : ''}
                </div>`;
        }).join('');

        // Collapsible page list
        const listId = 'sqpPageList_' + Date.now();
        pageList = `
            <div class="sqp-toggle-wrap">
                <button class="sqp-toggle-btn" onclick="
                    const el = document.getElementById('${listId}');
                    const open = el.style.display !== 'none';
                    el.style.display = open ? 'none' : 'block';
                    this.textContent = open ? '▶ Show page-by-page breakdown' : '▼ Hide page-by-page breakdown';
                ">▶ Show page-by-page breakdown</button>
            </div>
            <div id="${listId}" class="sqp-page-list" style="display:none;">
                ${rows}
            </div>`;
    }

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="sqp-header">
            <span class="sqp-header-icon">🔍</span>
            <span class="sqp-header-title">Scan Quality Report</span>
            <span class="sqp-header-file">${esc(fileName)}</span>
        </div>
        ${banner}
        ${chips}
        ${pageList}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 2 — Render editable header fields
// ──────────────────────────────────────────────────────────────────────────────
function renderStep2Fields() {
    document.getElementById('step2FieldsGrid').innerHTML = FIELD_DEFS.map(def => {
        const val = state.matchedData[def.key] || '', filled = val.length > 0;
        return `<div class="field-fill-group">
            <div class="field-fill-label">
                ${esc(def.label)}
                <span class="fill-badge ${filled ? 'found' : 'missing'}" id="badge_${def.key}">
                    ${filled ? 'Auto-filled ✓' : 'Not detected'}
                </span>
            </div>
            <input class="input-field ${filled ? 'field-filled' : 'field-empty'}"
                   type="text" id="cf_${def.key}"
                   value="${esc(val)}"
                   placeholder="Not detected — type manually"
                   oninput="onFieldEdit('${def.key}', this.value)"/>
        </div>`;
    }).join('');
}

function onFieldEdit(key, value) {
    state.matchedData[key] = value;
    const badge = document.getElementById('badge_' + key), input = document.getElementById('cf_' + key);
    if (!badge || !input) return;
    if (value.trim()) { badge.textContent = 'Edited ✓'; badge.className = 'fill-badge edited'; input.className = 'input-field field-filled'; }
    else { badge.textContent = 'Empty'; badge.className = 'fill-badge missing'; input.className = 'input-field field-empty'; }
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 2 — Editable checklist items
// ──────────────────────────────────────────────────────────────────────────────
function renderChecklistEditor() {
    document.getElementById('checklistItemsEditor').innerHTML =
        state.checklistItems.map((item, idx) => `
        <div class="cl-item-row" id="cl-row-${idx}">
            <div class="cl-item-num">${idx + 1}</div>
            <textarea class="cl-item-text" rows="2"
                      oninput="updateChecklistItem(${idx}, this.value)">${esc(item.text)}</textarea>
            <button class="cl-del-btn" onclick="deleteChecklistItem(${idx})" title="Remove">
                <i class="fa-solid fa-xmark"></i>
            </button>
        </div>`).join('');
}

function updateChecklistItem(idx, val) { state.checklistItems[idx].text = val; }

function deleteChecklistItem(idx) {
    state.checklistItems.splice(idx, 1);
    state.checklistItems.forEach((item, i) => { item.id = i + 1; });
    renderChecklistEditor();
}

function addChecklistItem() {
    const nextId = state.checklistItems.length + 1;
    state.checklistItems.push({ id: nextId, text: '', found: null, remark: '' });
    renderChecklistEditor();
    setTimeout(() => {
        const rows = document.querySelectorAll('.cl-item-text');
        if (rows.length) rows[rows.length - 1].focus();
    }, 50);
}

function resetToDefaults() {
    if (!confirm('Reset checklist to DepEd defaults? Any custom items will be lost.')) return;
    state.checklistItems = CHECKLIST_DEFAULTS[state.checklistType].map(i => ({ ...i, found: null, remark: '' }));
    renderChecklistEditor();
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 2 → STEP 3 — AI Compliance Validation
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Builds fee-table arithmetic instructions injected into the AI prompt
 * when validating a tuition fee increase submission.
 * Instructs the AI to extract all numeric tables and verify the math.
 */
function buildFeeTableInstructions() {
    return `
SPECIAL RULES — FEE TABLE & COMPUTATION VERIFICATION (apply these strictly):

TABLE SCANNING STRATEGY — READ CAREFULLY:
  • Scan the ENTIRE document for any structure that resembles a fee schedule or price list.
  • Tables may appear in any format: formatted columns, tab-separated values, lines with dashes, or even plain text like "Tuition Fee ... ₱5,000.00".
  • Look for section headers like: "Schedule of Fees", "Tuition and Other Fees", "Miscellaneous Fees", "Other School Fees", "Fee Breakdown", "Grade Level", "Year Level".
  • A "fee table" is ANY list of labeled peso amounts that appear to belong to the same category. Even a simple bulleted list like "• Tuition: ₱4,500 • PTCA: ₱500 • Total: ₱5,000" counts.
  • Do NOT skip a section just because it is not formatted as a traditional table — scan ALL sections.
  • Extract EVERY numeric peso amount you can find (₱ symbol, "PHP", or bare numbers near fee labels).
  • If a table has sub-categories (e.g., per grade level), treat each sub-category as its own table entry.

ITEM T1 — FEE LINE-ITEM ARITHMETIC CHECK:
  • For EACH fee table or fee category found:
      - List every individual fee line item and its peso amount.
      - Compute the sum yourself (do not trust the document's stated total).
      - Compare your computed sum against the stated total for that category.
      - Tolerance: ±1 peso for rounding is acceptable.
      - CORRECT: computed sum matches stated total (within ±1 peso).
      - MISMATCH: computed sum does NOT match stated total — report the difference.
  • found=true ONLY if ALL fee tables found have arithmetically correct totals.
  • found=false if ANY table has a mismatch, OR if no fee table with individual line items could be found anywhere in the document.
  • In the remark, for EACH table report:
      Table: <category/level name>
      Line items: <fee1>=₱X, <fee2>=₱Y, … (list all found line items)
      Computed sum: ₱<your sum>
      Stated total: ₱<document total>
      Verdict: CORRECT ✓ or MISMATCH ✗ (off by ₱<difference>)
  • If no fee table with individual line items is found anywhere: set found=false and note "No fee schedule with individual line items detected."

ITEM T2 — RA 6728 INCREMENTAL PROCEEDS ALLOCATION CHECK:
  • Find the total incremental proceeds figure. It may be:
      - Stated explicitly as "Total Incremental Proceeds: ₱X"
      - Derived as: (new tuition rate − old tuition rate) × total number of students
      - Labelled as "Increase per student × enrollment" or similar
  • Find the stated peso allocations for each RA 6728 slice:
      - 70% → salaries/wages/benefits of teaching personnel
      - 20% → improvement/modernization of buildings, equipment, libraries
      - 10% → student fund/scholarship
  • Verify:
      (a) Each slice amount = stated percentage × total incremental proceeds (±1 peso tolerance).
      (b) The three slices sum to 100% of the incremental proceeds.
  • found=true if a total incremental proceeds figure AND all three slice amounts are present AND all arithmetic checks pass.
  • found=false if total is missing, OR any slice is missing, OR any arithmetic is wrong.
  • In the remark, show ALL working:
      Total incremental proceeds: ₱<amount>
      Expected 70% (teaching): ₱<computed> — Document states: ₱<stated> — <MATCH ✓ / MISMATCH ✗>
      Expected 20% (facilities): ₱<computed> — Document states: ₱<stated> — <MATCH ✓ / MISMATCH ✗>
      Expected 10% (scholarship): ₱<computed> — Document states: ₱<stated> — <MATCH ✓ / MISMATCH ✗>
      Sum check: ₱<70%> + ₱<20%> + ₱<10%> = ₱<sum> vs ₱<total> — <CORRECT ✓ / MISMATCH ✗>
`;
}

/**
 * Builds extra instructions injected into the AI prompt when validating
 * a school calendar document.  Enforces the 200–220 day rule and requires
 * explicit holiday exclusion evidence.
 */
function buildCalendarInstructions() {
    return `
SPECIAL RULES — SCHOOL CALENDAR VALIDATION (apply these strictly):

ITEM 2 — TOTAL SCHOOL DAYS (200–220 range):
  • You MUST find the actual total number of school days stated in the document.
  • COMPLIANT (found=true):  total is between 200 and 220, inclusive.
  • NON-COMPLIANT (found=false): total is less than 200 OR greater than 220.
  • NOT FOUND (found=false): no day total can be located in the document.
  • In the remark, always state the exact number you found (e.g. "Document states 198 school days — below the 200-day minimum").
  • Do NOT mark as found if only the phrase "200 school days" or similar appears without a clear enumerated or stated total.

ITEM 4 — HOLIDAYS AND NON-WORKING DAYS EXCLUDED:
  • found=true ONLY if BOTH conditions are met:
      (a) The document explicitly LISTS or NAMES at least some national/DepEd-declared holidays or non-working days.
      (b) The document explicitly STATES that those holidays are NOT counted in the total school day figure
          (e.g. "excluding national holidays", "non-working days are not included in the 200-day count", etc.).
  • found=false if holidays are merely mentioned without a clear exclusion statement.
  • found=false if the day count appears to include holidays (e.g. the calendar marks holidays as class days).
  • In the remark, quote or paraphrase the exact text that shows inclusion or exclusion.

ITEM 5 — TERM/SEMESTER BREAKDOWN:
  • The individual term/semester day counts must visibly ADD UP to the stated total.
  • If the sum of stated per-term days does not equal the stated total, mark found=false and note the discrepancy.

ITEM 8 — PER-MONTH ARITHMETIC CHECK:
  • For EACH month listed in the calendar, independently count the total weekdays (Monday–Friday) in that month, then subtract any national/declared holidays that fall on a weekday in that month.
  • Compare your computed count against the stated school days for that month in the document.
  • If ALL months match → found=true. Remark: "All monthly day counts are arithmetically correct."
  • If ANY month does not match → found=false.
  • In the remark, LIST EACH DISCREPANT MONTH on its own line in this format:
      [MONTH YEAR]: Document states X days — expected Y days (Z weekdays minus W holidays). Possible reason: <brief explanation>.
  • Also note any month where the stated count could not be independently verified.
  • Be specific — name every month with a discrepancy. Do not just say "some months may be off."
`;
}

async function runAiValidation() {
    if (!state.extractedText.trim()) {
        showMsg('validationMsg', '⚠ No document text found. Please complete Step 1 first.', 'error'); return;
    }

    // Sync manual field edits
    FIELD_DEFS.forEach(def => {
        const el = document.getElementById('cf_' + def.key);
        if (el) state.matchedData[def.key] = el.value.trim();
    });
    // Sync any textarea edits
    state.checklistItems.forEach((item, idx) => {
        const el = document.getElementById('cl-row-' + idx)?.querySelector('.cl-item-text');
        if (el) item.text = el.value.trim();
    });

    const btn = document.getElementById('runValidationBtn');
    const loader = document.getElementById('validationLoader');
    const loaderMsg = document.getElementById('validationLoaderMsg');
    btn.disabled = true; loader.classList.add('visible'); hideMsg('validationMsg');

    // Loader messages — calendar type gets more specific messages
    const isCalendar = state.checklistType === 'school_calendar';
    const isTuitionInc = state.checklistType === 'tuition_increase';
    const vMsgs = isCalendar
        ? [
            'Scanning calendar for school day count…',
            'Verifying 200–220 day range compliance…',
            'Checking holiday exclusion statements…',
            'Correcting OCR errors in header fields…',
            'Reviewing Board Resolution and signatures…',
            'Generating AI compliance remarks…'
        ]
        : isTuitionInc
            ? [
                'Checking requirements against document…',
                'Extracting fee tables and line items…',
                'Verifying fee arithmetic and totals…',
                'Checking RA 6728 70/20/10 allocation math…',
                'Correcting OCR errors in header fields…',
                'Generating AI remarks…'
            ]
            : [
                'Checking requirements against document…',
                'Correcting OCR errors in header fields…',
                'Reviewing certifications and attachments…',
                'Generating AI remarks…'
            ];

    let vi = 0;
    const vTimer = setInterval(() => { vi = (vi + 1) % vMsgs.length; loaderMsg.textContent = vMsgs[vi]; }, 1800);

    try {
        const itemsJson = JSON.stringify(state.checklistItems.map(i => ({ id: i.id, text: i.text })));

        // ── Build the prompt, with type-specific rules injected when needed ──
        const calendarBlock = isCalendar ? buildCalendarInstructions() : '';
        const feeTableBlock = isTuitionInc ? buildFeeTableInstructions() : '';

        const prompt =
            `You are a DepEd SMME compliance officer for Region III (Central Luzon), Philippines.\n` +
            `You are reviewing a school document submission for checklist compliance under D.O. No. 12, s. 1997.\n\n` +
            (isCalendar
                ? `This document is a SCHOOL CALENDAR submission. Apply the special calendar validation rules below.\n\n`
                : '') +
            (isTuitionInc
                ? `This document is a TUITION FEE INCREASE submission. Apply the fee table verification rules below.\n\n`
                : '') +
            calendarBlock +
            feeTableBlock +
            `\nEXTRACTED DOCUMENT TEXT:\n"""\n${state.extractedText}\n"""\n\n` +
            `CHECKLIST REQUIREMENTS TO VERIFY:\n${itemsJson}\n\n` +
            `For each requirement, determine if evidence of it exists in the extracted text.\n` +
            `Be strict but fair — look for actual content, not just keyword mentions.\n` +
            (isCalendar
                ? `For school calendar items, apply the SPECIAL RULES above exactly as written.\n\n`
                : isTuitionInc
                    ? `For fee table items (T1, T2), apply the FEE TABLE VERIFICATION RULES above exactly as written.\n\n`
                    : '\n') +
            `HEADER FIELD CORRECTION TASK:\n` +
            `The document was scanned and OCR may have introduced errors, especially on the cover page.\n` +
            `Based on the FULL extracted text (all pages), determine the single most accurate value for each field below.\n` +
            `Look for the value that appears most consistently and most cleanly across all pages.\n` +
            `If a field genuinely cannot be found anywhere in the text, return null.\n` +
            `Fields to correct:\n` +
            `  - schoolName: Official name of the school (e.g. "MARIAN COLLEGE OF BALIUAG, INC.")\n` +
            `  - location: School address (e.g. "586 Gil Carlos St., Baliwag, Bulacan")\n` +
            `  - govRecogNo: Government Recognition No. (e.g. "E-025 s. 1996") — must match format [Letter]-[digits] s. [year]\n` +
            `  - govPermitNo: Government Permit No. if present, otherwise null\n` +
            `  - schoolHead: Full name of the School Head / Principal (e.g. "YOLANDA R. MALLO, LPT")\n` +
            `  - syApplied: School year (e.g. "2026-2027")\n\n` +
            `Respond ONLY with a valid JSON object in this exact format, no extra text:\n` +
            `{\n` +
            `  "items": [\n` +
            `    { "id": "<item id>", "found": true|false, "remark": "<1-2 sentence explanation of why found or what is missing>" }\n` +
            `  ],\n` +
            `  "overall_status": "COMPLIANT"|"NON-COMPLIANT"|"NEEDS REVIEW",\n` +
            `  "summary": "<2-3 sentence overall compliance summary for the SMME officer>",\n` +
            `  "corrected_fields": {\n` +
            `    "schoolName": "<corrected value or null>",\n` +
            `    "location": "<corrected value or null>",\n` +
            `    "govRecogNo": "<corrected value or null>",\n` +
            `    "govPermitNo": "<corrected value or null>",\n` +
            `    "schoolHead": "<corrected value or null>",\n` +
            `    "syApplied": "<corrected value or null>"\n` +
            `  }\n` +
            (isCalendar
                ? `  , "calendar_days_found": <number or null — the exact total school days extracted from the document>\n` +
                `  , "calendar_months": [\n` +
                `      {\n` +
                `        "month": "<Month name e.g. June>",\n` +
                `        "year": <4-digit year as number>,\n` +
                `        "stated_days": <school days as stated in the document for this month — integer>,\n` +
                `        "computed_days": <your independently computed school days: total weekdays minus weekday holidays — integer>,\n` +
                `        "holidays": [ { "date": "<Day Month e.g. 12 June>", "name": "<holiday name>" } ],\n` +
                `        "status": "ok"|"discrepancy"|"unverifiable",\n` +
                `        "note": "<brief note — leave empty string if ok, explain discrepancy if not>"\n` +
                `      }\n` +
                `    ]\n`
                : '') +
            (isTuitionInc
                ? `  , "fee_tables": [\n` +
                `      {\n` +
                `        "category": "<e.g. Grade School, High School, Miscellaneous>",\n` +
                `        "line_items": [ { "label": "<fee name>", "amount": <number> } ],\n` +
                `        "stated_total": <number or null>,\n` +
                `        "computed_total": <number — sum of line_items>,\n` +
                `        "match": true|false\n` +
                `      }\n` +
                `    ],\n` +
                `  "ra6728": {\n` +
                `    "total_incremental": <number or null>,\n` +
                `    "teaching_70_stated": <number or null>, "teaching_70_expected": <number or null>, "teaching_70_match": true|false,\n` +
                `    "facilities_20_stated": <number or null>, "facilities_20_expected": <number or null>, "facilities_20_match": true|false,\n` +
                `    "scholarship_10_stated": <number or null>, "scholarship_10_expected": <number or null>, "scholarship_10_match": true|false\n` +
                `  }\n`
                : '') +
            `}`;

        const data = await callAI({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4000,
            messages: [{ role: 'user', content: prompt }]
        });

        const raw = (data.content || []).map(b => b.text || '').join('').trim();
        const clean = raw.replace(/```json|```/g, '').trim();
        const result = JSON.parse(clean);

        // Merge AI results back into state
        result.items.forEach(r => {
            const item = state.checklistItems.find(i => String(i.id) === String(r.id));
            if (item) { item.found = r.found; item.remark = r.remark || ''; }
        });
        state.aiSummary = result.summary || '';
        state.overallStatus = result.overall_status || 'NEEDS REVIEW';

        // ── Merge AI-corrected header fields ──────────────────────────────────
        // The AI reads the full text and picks the most consistent value across
        // all pages, correcting OCR errors from the (often garbled) cover page.
        // Strategy: accept the AI value when:
        //   (a) the regex found nothing (field is blank), OR
        //   (b) the regex value looks garbled (contains OCR noise patterns)
        if (result.corrected_fields) {
            const cf = result.corrected_fields;
            const garbledPatterns = {
                schoolName: v => /[^a-zA-Z0-9\s\-'.,&()]/.test(v) || /\b(MAREAN|COLEGE|BALIDAG|BALIL)\b/i.test(v),
                location: v => /[a-zA-Z]\d[a-zA-Z]/.test(v) || /\d[a-zA-Z]{2,}/.test(v) || v.split(/\s+/).length > 12,
                govRecogNo: v => !/[A-Z]\s*[-–]\s*\d{2,}\s*s\.?\s*\d{4}/i.test(v),  // must have full format: X-NNN s. YYYY
                schoolHead: v => { const words = v.split(/[\s,]+/); return words.some(w => w.length >= 5 && !(/^[A-Z]/.test(w)) && (w.match(/[a-z]/g) || []).length > 3); },
                syApplied: v => !/20\d{2}/.test(v),
            };
            ['schoolName', 'location', 'govRecogNo', 'govPermitNo', 'schoolHead', 'syApplied'].forEach(key => {
                const aiVal = cf[key];
                if (!aiVal) return; // AI returned null — don't overwrite
                const existing = state.matchedData[key] || '';
                const isBlank = !existing.trim();
                const isGarbled = garbledPatterns[key] ? garbledPatterns[key](existing) : false;
                if (isBlank || isGarbled) {
                    state.matchedData[key] = aiVal;
                    // Also update the Step 2 input field if still visible
                    const el = document.getElementById('cf_' + key);
                    if (el) el.value = aiVal;
                }
            });
        }

        // ── Store calendar-specific extracted day count for the save payload ──
        if (isCalendar && result.calendar_days_found != null) {
            state.calendarDaysFound = result.calendar_days_found;
        }
        if (isCalendar && Array.isArray(result.calendar_months)) {
            state.calendarMonths = result.calendar_months;
        }

        // ── Store fee table results for the report ──
        if (isTuitionInc) {
            state.feeTables = Array.isArray(result.fee_tables) ? result.fee_tables : [];
            state.ra6728 = result.ra6728 || null;
        }

        // Compute score
        const found = state.checklistItems.filter(i => i.found).length;
        const total = state.checklistItems.length;
        state.complianceScore = total ? Math.round((found / total) * 100) : 0;

        clearInterval(vTimer);
        loader.classList.remove('visible'); btn.disabled = false;
        markStepDone(2);
        renderReport();
        goStep(3);

    } catch (err) {
        clearInterval(vTimer);
        loader.classList.remove('visible'); btn.disabled = false;
        showMsg('validationMsg', '⚠ ' + (err.message || 'Validation failed. Please try again.'), 'error');
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// DATA QUALITY — Detect OCR artifacts and missing extracted fields
// ──────────────────────────────────────────────────────────────────────────────
function detectDataQualityIssues() {
    const issues = [];
    const d = state.matchedData;

    // ── Missing required fields ──
    const requiredFields = [
        { key: 'schoolName', label: 'School Name' },
        { key: 'location', label: 'Location / Address' },
        { key: 'govRecogNo', label: 'Government Recognition No.' },
        { key: 'schoolHead', label: 'School Head / Principal' },
        { key: 'evaluatedBy', label: 'Processed / Evaluated By' },
    ];
    requiredFields.forEach(f => {
        if (!d[f.key] || d[f.key].trim() === '') {
            issues.push({
                type: 'missing',
                field: f.label,
                message: `"${f.label}" was not detected. Please fill it in manually before saving.`,
            });
        }
    });

    // ── OCR artifact patterns ──
    const ocrChecks = [
        {
            key: 'schoolName', label: 'School Name',
            test: v => /[0-9]{3,}/.test(v) || /[^a-zA-Z0-9\s\-'.,&()]/.test(v),
            hint: 'Contains unusual characters — may be an OCR artifact. Verify the spelling matches the official letterhead.',
        },
        {
            key: 'location', label: 'Location / Address',
            test: v => /[a-zA-Z]\d[a-zA-Z]/.test(v) || /\d[a-zA-Z]{2,}/.test(v),
            hint: 'Address appears garbled (e.g. "908Gi" instead of "586 Gil"). Check against the SEC registration or letterhead.',
        },
        {
            key: 'schoolName', label: 'School Name',
            test: v => {
                // Check for likely vowel-swap or missing character OCR errors in known words
                const normalized = v.toUpperCase();
                const suspiciousPairs = [
                    ['MAREAN', 'MARIAN'], ['BALIUAG', 'BALIWAG'], ['COLEGE', 'COLLEGE'],
                    ['SCOOL', 'SCHOOL'], ['INSTUTITE', 'INSTITUTE'], ['ACADAMY', 'ACADEMY'],
                ];
                return suspiciousPairs.some(([wrong]) => normalized.includes(wrong));
            },
            hint: 'School name may contain a spelling error caused by OCR (e.g. "MAREAN" instead of "MARIAN"). Please verify.',
        },
    ];
    ocrChecks.forEach(chk => {
        const val = d[chk.key];
        if (val && chk.test(val)) {
            // Avoid duplicate messages for the same field
            if (!issues.find(i => i.type === 'ocr' && i.field === chk.label)) {
                issues.push({ type: 'ocr', field: chk.label, message: `⚠ ${chk.label}: "${val}" — ${chk.hint}` });
            }
        }
    });

    return issues;
}


function renderReport() {
    const score = state.complianceScore;
    const found = state.checklistItems.filter(i => i.found).length;
    const total = state.checklistItems.length;
    const status = state.overallStatus || (score >= 80 ? 'COMPLIANT' : score >= 50 ? 'NEEDS REVIEW' : 'NON-COMPLIANT');

    const r = 38, circ = 2 * Math.PI * r;
    const dash = (score / 100) * circ;
    const ringColor = score >= 80 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
    const badgeClass = status === 'COMPLIANT' ? 'badge-compliant' : status === 'NON-COMPLIANT' ? 'badge-noncompliant' : 'badge-review';

    // ── Calendar day-count banner (only for school_calendar type) ──
    let calendarBanner = '';
    if (state.checklistType === 'school_calendar' && state.calendarDaysFound != null) {
        const days = Number(state.calendarDaysFound);
        const inRange = days >= 200 && days <= 220;
        const bannerColor = inRange ? '#16a34a' : '#dc2626';
        const bannerIcon = inRange ? '✓' : '✗';
        calendarBanner = `
            <div class="calendar-days-banner" style="
                display:flex;align-items:center;gap:10px;padding:10px 16px;margin:12px 0 0;
                border-radius:8px;background:${inRange ? '#f0fdf4' : '#fef2f2'};
                border:1px solid ${inRange ? '#bbf7d0' : '#fecaca'};">
                <span style="font-size:22px;color:${bannerColor};">${bannerIcon}</span>
                <span style="font-size:14px;font-weight:600;color:${bannerColor};">
                    ${days} school days detected —
                    ${inRange ? 'within the 200–220 day required range' : (days < 200 ? 'BELOW the 200-day minimum' : 'ABOVE the 220-day maximum')}
                </span>
            </div>`;
    }

    document.getElementById('scoreRingWrap').innerHTML = `
        <div class="score-ring">
            <svg width="90" height="90" viewBox="0 0 90 90">
                <circle cx="45" cy="45" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="7"/>
                <circle cx="45" cy="45" r="${r}" fill="none" stroke="${ringColor}" stroke-width="7"
                        stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
                        style="transition:stroke-dasharray 1s ease"/>
            </svg>
            <div class="score-ring-label">
                <span class="score-ring-pct">${score}%</span>
                <span class="score-ring-sub">Score</span>
            </div>
        </div>
        <div class="score-meta">
            <h3>${esc(state.matchedData.schoolName || 'School Document')}</h3>
            <p>${esc(state.aiSummary || 'Validation complete.')}</p>
            <span class="overall-badge ${badgeClass}">${status}</span>
            ${calendarBanner}
        </div>`;

    // ── Summary chips ──
    document.getElementById('resultSummary').innerHTML =
        `<div class="summary-chip"><span>${found}/${total}</span> requirements found</div>` +
        `<div class="summary-chip"><span>${total - found}</span> missing</div>` +
        `<div class="summary-chip"><span>${state.extractedText.length.toLocaleString()}</span> chars extracted</div>`;

    // ── Data quality warnings panel ──
    const qualityIssues = detectDataQualityIssues();
    const warningsEl = document.getElementById('dataQualityWarnings');
    if (warningsEl) {
        if (qualityIssues.length === 0) {
            warningsEl.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;padding:10px 14px;
                    background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;
                    font-size:13px;color:#16a34a;">
                    <span style="font-size:16px;">✓</span>
                    <span>All extracted fields look clean — no OCR artifacts or missing fields detected.</span>
                </div>`;
        } else {
            const ocrIssues = qualityIssues.filter(i => i.type === 'ocr');
            const missingIssues = qualityIssues.filter(i => i.type === 'missing');
            let html = `<div style="font-size:13px;font-weight:600;color:#92400e;margin-bottom:8px;">
                <span style="font-size:15px;">⚠</span>
                &nbsp;${qualityIssues.length} data quality issue${qualityIssues.length > 1 ? 's' : ''} detected — please review before saving</div>`;

            if (ocrIssues.length) {
                html += `<div style="font-size:12px;font-weight:600;color:#78350f;margin:6px 0 4px;text-transform:uppercase;letter-spacing:0.04em;">OCR / Extraction Artifacts</div>`;
                ocrIssues.forEach(i => {
                    html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;
                        border-bottom:0.5px solid #fde68a;">
                        <span style="color:#d97706;font-size:14px;flex-shrink:0;">⚠</span>
                        <span style="color:#78350f;line-height:1.5;">${esc(i.message)}</span>
                    </div>`;
                });
            }

            if (missingIssues.length) {
                html += `<div style="font-size:12px;font-weight:600;color:#7f1d1d;margin:10px 0 4px;text-transform:uppercase;letter-spacing:0.04em;">Missing Fields — Fill in Manually</div>`;
                missingIssues.forEach(i => {
                    html += `<div style="display:flex;gap:8px;align-items:flex-start;padding:6px 0;
                        border-bottom:0.5px solid #fecaca;">
                        <span style="color:#dc2626;font-size:14px;flex-shrink:0;">✗</span>
                        <span style="color:#7f1d1d;line-height:1.5;">${esc(i.message)}</span>
                    </div>`;
                });
            }

            warningsEl.innerHTML = `<div style="background:#fffbeb;border:1px solid #fde68a;
                border-radius:8px;padding:12px 14px;">${html}</div>`;
        }
        warningsEl.style.display = 'block';
    }


    // ── Header fields ──
    document.getElementById('headerFieldsResult').innerHTML = FIELD_DEFS.map(def => `
        <div class="field-group">
            <div class="field-label">${esc(def.label)}</div>
            <div class="field-value ${state.matchedData[def.key] ? '' : 'empty'}">
                ${state.matchedData[def.key] ? esc(state.matchedData[def.key]) : 'Not detected'}
            </div>
        </div>`).join('');

    // ── Checklist with AI remarks ──
    document.getElementById('checklistResult').innerHTML = state.checklistItems.map(item => `
        <div class="check-result">
            <div class="check-icon ${item.found ? 'found' : 'missing'}">${item.found ? '✓' : '✗'}</div>
            <div class="check-body">
                <div class="check-item-id">Item ${item.id}</div>
                <div class="check-item-label">${esc(item.text)}</div>
                ${item.remark ? `<div class="check-remark ${item.found ? 'found-remark' : 'missing-remark'}">${esc(item.remark)}</div>` : ''}
            </div>
        </div>`).join('');

    // ── Calendar month grid (school_calendar type only) ──
    if (state.checklistType === 'school_calendar') {
        renderCalendarGrid();
    } else {
        const el = document.getElementById('calendarGridSection');
        if (el) el.style.display = 'none';
    }

    // ── Fee table computation results (tuition_increase type only) ──
    renderFeeTableSection();

    // ── Raw text ──
    document.getElementById('rawTextBox').textContent = state.extractedText || '(no text extracted)';

    // ── Reset save button state for new report ──
    state.savedReportId = null;
    const saveBtn = document.getElementById('saveReportBtn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save Report to Database'; }
    hideMsg('reportSaveMsg');

    markStepDone(3);
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 3 — Fee Table Computation Panel (tuition_increase type)
// ──────────────────────────────────────────────────────────────────────────────
function renderFeeTableSection() {
    // Look for or create the fee table panel
    let panel = document.getElementById('feeTableSection');
    if (!panel) {
        // Insert it just before the checklist result card in panel-3
        const checklistCard = document.getElementById('checklistResult')?.closest('.card');
        if (!checklistCard) return;
        panel = document.createElement('div');
        panel.id = 'feeTableSection';
        checklistCard.parentNode.insertBefore(panel, checklistCard);
    }

    if (state.checklistType !== 'tuition_increase' || (!state.feeTables?.length && !state.ra6728)) {
        panel.style.display = 'none';
        return;
    }

    const fmt = n => (n == null ? '—' : '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const tick = ok => ok ? `<span style="color:#16a34a;font-weight:700;">✓ MATCH</span>`
        : `<span style="color:#dc2626;font-weight:700;">✗ MISMATCH</span>`;
    const diff = (computed, stated) => {
        if (computed == null || stated == null) return '';
        const delta = Number(stated) - Number(computed);
        if (Math.abs(delta) <= 1) return '';
        const sign = delta > 0 ? '+' : '';
        return `<span style="font-size:11px;color:#dc2626;margin-left:6px;">(off by ${sign}${fmt(delta)})</span>`;
    };

    // ── Summary Banner ──
    const tables = state.feeTables || [];
    const mismatched = tables.filter(t => t.match === false);
    const ra = state.ra6728;
    const raAllOk = !ra || (ra.teaching_70_match && ra.facilities_20_match && ra.scholarship_10_match);
    const allPassed = mismatched.length === 0 && raAllOk && tables.length > 0;
    const noTables = tables.length === 0 && !ra;

    let bannerHtml = '';
    if (noTables) {
        bannerHtml = `
            <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;
                background:#fffbeb;border:1px solid #fde68a;border-radius:8px;margin-bottom:16px;">
                <span style="font-size:20px;">⚠</span>
                <div>
                    <div style="font-size:13px;font-weight:600;color:#92400e;">No fee tables detected</div>
                    <div style="font-size:12px;color:#78350f;margin-top:2px;">
                        The AI could not find any fee schedule with individual line items. 
                        The document may not include a fee breakdown, or the table may be image-based and unreadable.
                    </div>
                </div>
            </div>`;
    } else if (allPassed) {
        bannerHtml = `
            <div style="display:flex;align-items:center;gap:10px;padding:12px 16px;
                background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;margin-bottom:16px;">
                <span style="font-size:22px;color:#16a34a;">✓</span>
                <div>
                    <div style="font-size:13px;font-weight:600;color:#166534;">All fee computations verified — arithmetic is correct</div>
                    <div style="font-size:12px;color:#14532d;margin-top:2px;">
                        ${tables.length} fee table${tables.length !== 1 ? 's' : ''} scanned. All line items add up to their stated totals.
                        ${ra ? 'RA 6728 allocation math also checks out.' : ''}
                    </div>
                </div>
            </div>`;
    } else {
        const issues = [];
        if (mismatched.length) issues.push(`${mismatched.length} fee table${mismatched.length !== 1 ? 's' : ''} with arithmetic errors`);
        if (!raAllOk) issues.push('RA 6728 allocation mismatch');
        bannerHtml = `
            <div style="display:flex;align-items:flex-start;gap:10px;padding:12px 16px;
                background:#fef2f2;border:1px solid #fecaca;border-radius:8px;margin-bottom:16px;">
                <span style="font-size:22px;color:#dc2626;flex-shrink:0;">✗</span>
                <div>
                    <div style="font-size:13px;font-weight:600;color:#991b1b;">Arithmetic errors found — document requires correction</div>
                    <div style="font-size:12px;color:#7f1d1d;margin-top:2px;">
                        ${issues.join(' · ')}. The stated totals do not match the sum of line items. 
                        The school must correct these discrepancies before the application can proceed.
                    </div>
                </div>
            </div>`;
    }

    // ── Fee tables ──
    let tablesHtml = '';
    tables.forEach(t => {
        const rowsHtml = (t.line_items || []).map(li =>
            `<tr>
                <td style="padding:5px 8px;font-size:13px;color:var(--color-text-primary);">${esc(li.label)}</td>
                <td style="padding:5px 8px;font-size:13px;text-align:right;color:var(--color-text-primary);">${fmt(li.amount)}</td>
            </tr>`
        ).join('');

        const allMatch = t.match !== false;
        tablesHtml += `
            <div style="margin-bottom:16px;border:0.5px solid ${allMatch ? '#bbf7d0' : '#fecaca'};border-radius:8px;overflow:hidden;">
                <div style="padding:8px 12px;background:${allMatch ? '#f0fdf4' : '#fef2f2'};
                    display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
                    <span style="font-size:13px;font-weight:600;color:${allMatch ? '#166534' : '#991b1b'};">
                        ${esc(t.category || 'Fee Schedule')}
                    </span>
                    ${tick(allMatch)}
                </div>
                ${(t.line_items || []).length === 0
                ? `<div style="padding:10px 12px;font-size:13px;color:var(--color-text-secondary);">No individual line items extracted for this category.</div>`
                : `<table style="width:100%;border-collapse:collapse;">
                        <thead>
                            <tr style="background:var(--color-background-secondary);">
                                <th style="padding:6px 8px;text-align:left;font-size:11px;font-weight:600;
                                    color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Fee Item</th>
                                <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;
                                    color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Amount</th>
                            </tr>
                        </thead>
                        <tbody>${rowsHtml}</tbody>
                        <tfoot>
                            <tr style="border-top:1.5px solid var(--color-border-tertiary);">
                                <td style="padding:6px 8px;font-size:13px;font-weight:600;">Computed Sum (AI)</td>
                                <td style="padding:6px 8px;font-size:13px;font-weight:600;text-align:right;">${fmt(t.computed_total)}</td>
                            </tr>
                            <tr style="background:${allMatch ? '#f0fdf4' : '#fef2f2'};">
                                <td style="padding:6px 8px;font-size:13px;font-weight:700;">
                                    Stated Total ${allMatch ? '✓' : '✗'}
                                </td>
                                <td style="padding:6px 8px;font-size:13px;font-weight:700;text-align:right;
                                    color:${allMatch ? '#16a34a' : '#dc2626'};">
                                    ${fmt(t.stated_total)}${diff(t.computed_total, t.stated_total)}
                                </td>
                            </tr>
                        </tfoot>
                    </table>`
            }
            </div>`;
    });

    // ── RA 6728 allocation check ──
    let ra6728Html = '';
    if (ra && ra.total_incremental != null) {
        const allOk = ra.teaching_70_match && ra.facilities_20_match && ra.scholarship_10_match;
        const rows = [
            { label: '70% — Teaching Personnel Salaries', stated: ra.teaching_70_stated, expected: ra.teaching_70_expected, ok: ra.teaching_70_match },
            { label: '20% — Facilities & Equipment', stated: ra.facilities_20_stated, expected: ra.facilities_20_expected, ok: ra.facilities_20_match },
            { label: '10% — Student Fund / Scholarship', stated: ra.scholarship_10_stated, expected: ra.scholarship_10_expected, ok: ra.scholarship_10_match },
        ];
        ra6728Html = `
            <div style="margin-top:16px;border:0.5px solid ${allOk ? '#bbf7d0' : '#fecaca'};border-radius:8px;overflow:hidden;">
                <div style="padding:8px 12px;background:${allOk ? '#f0fdf4' : '#fef2f2'};
                    display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
                    <span style="font-size:13px;font-weight:600;color:${allOk ? '#166534' : '#991b1b'};">
                        RA 6728 — Incremental Proceeds Allocation
                    </span>
                    ${tick(allOk)}
                </div>
                <div style="padding:10px 12px;font-size:13px;color:var(--color-text-secondary);">
                    Total Incremental Proceeds: <strong style="color:var(--color-text-primary);">${fmt(ra.total_incremental)}</strong>
                </div>
                <table style="width:100%;border-collapse:collapse;">
                    <thead>
                        <tr style="background:var(--color-background-secondary);">
                            <th style="padding:6px 8px;text-align:left;font-size:11px;font-weight:600;
                                color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Allocation</th>
                            <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;
                                color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Expected</th>
                            <th style="padding:6px 8px;text-align:right;font-size:11px;font-weight:600;
                                color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Stated</th>
                            <th style="padding:6px 8px;text-align:center;font-size:11px;font-weight:600;
                                color:var(--color-text-secondary);text-transform:uppercase;letter-spacing:.04em;">Result</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rows.map(r => `<tr style="border-top:0.5px solid var(--color-border-tertiary);${r.ok ? '' : 'background:#fef2f2;'}">
                            <td style="padding:6px 8px;font-size:13px;">${esc(r.label)}</td>
                            <td style="padding:6px 8px;font-size:13px;text-align:right;color:var(--color-text-secondary);">${fmt(r.expected)}</td>
                            <td style="padding:6px 8px;font-size:13px;text-align:right;
                                color:${r.ok ? '#16a34a' : '#dc2626'};font-weight:600;">
                                ${fmt(r.stated)}${diff(r.expected, r.stated)}
                            </td>
                            <td style="padding:6px 8px;text-align:center;">${tick(r.ok)}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>`;
    }

    panel.style.display = 'block';
    panel.innerHTML = `
        <div class="card">
            <div class="card-title">
                <i class="fa-solid fa-calculator" style="margin-right:6px;color:#6366f1;"></i>
                Fee Table Arithmetic Verification
            </div>
            <div class="card-subtitle">
                The AI scanned the entire document for fee schedules and independently verified all arithmetic.
                Numbers, amounts, and table structure were not altered — only computed sums are checked against stated totals.
            </div>
            ${bannerHtml}
            ${tablesHtml || ''}
            ${ra6728Html}
        </div>`;
}

// ──────────────────────────────────────────────────────────────────────────────
// STEP 3 — Calendar Month Grid
// ──────────────────────────────────────────────────────────────────────────────
function renderCalendarGrid() {
    const section = document.getElementById('calendarGridSection');
    if (!section) return;

    const months = state.calendarMonths;
    if (!months || months.length === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = 'block';

    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    // Map holiday dates for quick lookup: "12 June 2026" → holiday name
    function buildHolidayMap(holidays, year) {
        const map = {};
        (holidays || []).forEach(h => {
            // parse "12 June" or "June 12" style
            const raw = (h.date || '').trim();
            const m1 = raw.match(/^(\d{1,2})\s+([A-Za-z]+)/);
            const m2 = raw.match(/^([A-Za-z]+)\s+(\d{1,2})/);
            let day = null, monthStr = null;
            if (m1) { day = parseInt(m1[1]); monthStr = m1[2]; }
            else if (m2) { monthStr = m2[1]; day = parseInt(m2[2]); }
            if (day && monthStr) {
                const d = new Date(`${monthStr} ${day}, ${year}`);
                if (!isNaN(d)) {
                    const key = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
                    map[key] = h.name || 'Holiday';
                }
            }
        });
        return map;
    }

    const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'];

    let html = '';

    months.forEach(m => {
        const monthIdx = MONTH_NAMES.findIndex(n => n.toLowerCase() === (m.month || '').toLowerCase());
        if (monthIdx === -1) return;
        const year = Number(m.year);
        const holidayMap = buildHolidayMap(m.holidays, year);

        const firstDay = new Date(year, monthIdx, 1).getDay(); // 0=Sun
        const daysInMonth = new Date(year, monthIdx + 1, 0).getDate();

        const statusColor = m.status === 'ok'
            ? 'var(--color-background-success)'
            : m.status === 'discrepancy'
                ? 'var(--color-background-danger)'
                : 'var(--color-background-warning)';
        const statusText = m.status === 'ok'
            ? 'var(--color-text-success)'
            : m.status === 'discrepancy'
                ? 'var(--color-text-danger)'
                : 'var(--color-text-warning)';
        const statusLabel = m.status === 'ok' ? '✓ Correct'
            : m.status === 'discrepancy' ? '⚠ Discrepancy'
                : '? Unverifiable';

        // Build calendar cells
        let cells = '';
        // Empty cells before first day
        for (let i = 0; i < firstDay; i++) {
            cells += `<div class="cal-cell cal-empty"></div>`;
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, monthIdx, d);
            const dow = date.getDay();
            const key = `${year}-${monthIdx}-${d}`;
            const isWeekend = dow === 0 || dow === 6;
            const isHoliday = !!holidayMap[key];
            const holidayName = holidayMap[key] || '';

            let cellClass = 'cal-cell';
            let tooltip = '';
            if (isWeekend) { cellClass += ' cal-weekend'; }
            else if (isHoliday) { cellClass += ' cal-holiday'; tooltip = holidayName; }
            else { cellClass += ' cal-school'; }

            cells += `<div class="${cellClass}" ${tooltip ? `title="${esc(tooltip)}"` : ''}>
                <span class="cal-day-num">${d}</span>
                ${isHoliday ? `<span class="cal-holiday-label">${esc(holidayName)}</span>` : ''}
            </div>`;
        }

        const stated = m.stated_days != null ? m.stated_days : '—';
        const computed = m.computed_days != null ? m.computed_days : '—';
        const diff = (m.stated_days != null && m.computed_days != null)
            ? m.stated_days - m.computed_days : null;

        html += `
        <div class="cal-month-card">
            <div class="cal-month-header">
                <div class="cal-month-title">${esc(m.month)} ${year}</div>
                <div class="cal-month-badges">
                    <span class="cal-badge" style="background:var(--color-background-secondary);color:var(--color-text-secondary);">
                        Stated: <strong>${stated}</strong> days
                    </span>
                    <span class="cal-badge" style="background:var(--color-background-secondary);color:var(--color-text-secondary);">
                        Computed: <strong>${computed}</strong> days
                    </span>
                    ${diff !== null && diff !== 0
                ? `<span class="cal-badge" style="background:var(--color-background-danger);color:var(--color-text-danger);">
                               Diff: ${diff > 0 ? '+' : ''}${diff}
                           </span>`
                : ''}
                    <span class="cal-badge" style="background:${statusColor};color:${statusText};">
                        ${statusLabel}
                    </span>
                </div>
            </div>
            ${m.note ? `<div class="cal-month-note">${esc(m.note)}</div>` : ''}
            <div class="cal-grid-head">
                ${DAYS.map(d => `<div class="cal-dow">${d}</div>`).join('')}
            </div>
            <div class="cal-grid">
                ${cells}
            </div>
            ${(m.holidays && m.holidays.length)
                ? `<div class="cal-holiday-list">
                       <span class="cal-holiday-list-title">Holidays excluded:</span>
                       ${m.holidays.map(h => `<span class="cal-holiday-chip">${esc(h.date)} — ${esc(h.name)}</span>`).join('')}
                   </div>`
                : `<div class="cal-holiday-list"><span style="font-size:12px;color:var(--color-text-secondary);">No holidays declared this month.</span></div>`}
        </div>`;
    });

    document.getElementById('calendarGridInner').innerHTML = html;
}


// ──────────────────────────────────────────────────────────────────────────────
// STEP 3 — Save compliance report to DB
// ──────────────────────────────────────────────────────────────────────────────
async function saveChecklistReport() {
    const btn = document.getElementById('saveReportBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    hideMsg('reportSaveMsg');

    try {
        const saveUrl = CONFIG.API_URL + "/checklist-save.php";

        const payload = {
            checklistType: state.checklistType,
            complianceScore: state.complianceScore,
            overallStatus: state.overallStatus,
            aiSummary: state.aiSummary,
            matchedData: state.matchedData,
            items: state.checklistItems,
            fileName: state.pdfFile?.name || '',
            calendarDaysFound: state.calendarDaysFound ?? null,
            calendarMonths: state.calendarMonths ?? [],
        };

        const res = await fetch(saveUrl, {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });

        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || 'Save failed.');

        state.savedReportId = json.report_id || null;
        showMsg('reportSaveMsg', '✓ Report saved successfully.' + (json.report_id ? ' (ID: ' + json.report_id + ')' : ''), 'success');
        if (btn) { btn.textContent = 'Saved ✓'; }

    } catch (err) {
        showMsg('reportSaveMsg', '⚠ ' + (err.message || 'Could not save report.'), 'error');
        if (btn) { btn.disabled = false; btn.textContent = 'Save Report to Database'; }
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// DOWNLOAD — Excel
// ──────────────────────────────────────────────────────────────────────────────
function downloadExcel() {
    const wb = XLSX.utils.book_new();
    const matched = state.matchedData, checked = state.checklistItems;
    const school = (matched.schoolName || 'school').replace(/[^a-z0-9]/gi, '_').substring(0, 30);

    // Sheet 1 — School information
    const ws1Rows = [
        ['PROCESSING CHECKLIST — COMPLIANCE REPORT'],
        ['D.O. No. 12, s. 1997 | DepEd Region III'],
        ['Source File: ' + (state.pdfFile?.name || '')],
        ['Compliance Score: ' + state.complianceScore + '%  |  Status: ' + (state.overallStatus || '')],
    ];
    if (state.checklistType === 'school_calendar' && state.calendarDaysFound != null) {
        const days = Number(state.calendarDaysFound);
        const inRange = days >= 200 && days <= 220;
        ws1Rows.push(['Calendar Days Detected: ' + days + ' (' + (inRange ? 'WITHIN 200–220 range' : 'OUT OF 200–220 range') + ')']);
    }
    ws1Rows.push([], ['FIELD', 'VALUE', 'STATUS'],
        ...FIELD_DEFS.map(d => [d.label, matched[d.key] || '', matched[d.key] ? '✓ Filled' : '✗ Empty'])
    );
    const ws1 = XLSX.utils.aoa_to_sheet(ws1Rows);
    ws1['!cols'] = [{ wch: 32 }, { wch: 55 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws1, 'School Information');

    // Sheet 2 — Checklist verification
    const ws2 = XLSX.utils.aoa_to_sheet([
        ['CHECKLIST REQUIREMENT VERIFICATION'],
        ['Overall Status: ' + (state.overallStatus || '')],
        [],
        ['ITEM', 'REQUIREMENT', 'STATUS', 'AI REMARK'],
        ...checked.map(i => ['Item ' + i.id, i.text, i.found ? '✓ FOUND' : '✗ NOT FOUND', i.remark || ''])
    ]);
    ws2['!cols'] = [{ wch: 10 }, { wch: 65 }, { wch: 14 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, ws2, 'Checklist Verification');

    // Sheet 3 — Raw text
    const ws3 = XLSX.utils.aoa_to_sheet([['AI SUMMARY'], [state.aiSummary || ''], [''], ['RAW EXTRACTED TEXT'], [state.extractedText]]);
    ws3['!cols'] = [{ wch: 100 }];
    XLSX.utils.book_append_sheet(wb, ws3, 'Raw Text');

    // Sheet 4 — Data quality issues
    const qualityIssues = detectDataQualityIssues();
    const ws4Rows = [
        ['DATA QUALITY REPORT'],
        ['Issues detected: ' + qualityIssues.length],
        [],
        ['TYPE', 'FIELD', 'ISSUE'],
        ...qualityIssues.map(i => [i.type === 'ocr' ? 'OCR Artifact' : 'Missing Field', i.field, i.message])
    ];
    if (qualityIssues.length === 0) ws4Rows.push(['', '', 'No issues detected — all fields extracted cleanly.']);
    const ws4 = XLSX.utils.aoa_to_sheet(ws4Rows);
    ws4['!cols'] = [{ wch: 18 }, { wch: 28 }, { wch: 80 }];
    XLSX.utils.book_append_sheet(wb, ws4, 'Data Quality');

    XLSX.writeFile(wb, `checklist_${school}_${Date.now()}.xlsx`);
}

// ──────────────────────────────────────────────────────────────────────────────
// DOWNLOAD — TXT
// ──────────────────────────────────────────────────────────────────────────────
function downloadTxt() {
    const matched = state.matchedData, checked = state.checklistItems;
    let out = 'PROCESSING CHECKLIST — COMPLIANCE REPORT\nD.O. No. 12, s. 1997 | DepEd Region III\n' + '='.repeat(60) + '\n';
    out += `Compliance Score: ${state.complianceScore}%\nOverall Status: ${state.overallStatus || ''}\n`;
    if (state.checklistType === 'school_calendar' && state.calendarDaysFound != null) {
        const days = Number(state.calendarDaysFound);
        out += `Calendar Days Detected: ${days} (${days >= 200 && days <= 220 ? 'WITHIN 200–220 range' : 'OUT OF 200–220 range'})\n`;
    }
    out += '\nSCHOOL INFORMATION\n' + '-'.repeat(40) + '\n';
    FIELD_DEFS.forEach(d => { out += `${d.label}: ${matched[d.key] || '(not detected)'}\n`; });
    out += '\nCHECKLIST VERIFICATION\n' + '-'.repeat(40) + '\n';
    checked.forEach(i => {
        out += `[${i.found ? '✓' : '✗'}] Item ${i.id}: ${i.text}\n`;
        if (i.remark) out += `     → ${i.remark}\n`;
    });
    if (state.aiSummary) out += '\nAI SUMMARY\n' + '-'.repeat(40) + '\n' + state.aiSummary + '\n';
    const qualityIssues = detectDataQualityIssues();
    out += '\nDATA QUALITY ISSUES\n' + '-'.repeat(40) + '\n';
    if (qualityIssues.length === 0) {
        out += 'No issues detected — all fields extracted cleanly.\n';
    } else {
        qualityIssues.forEach(i => { out += `[${i.type === 'ocr' ? 'OCR' : 'MISSING'}] ${i.field}: ${i.message}\n`; });
    }
    out += '\nRAW EXTRACTED TEXT\n' + '-'.repeat(40) + '\n' + state.extractedText;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([out], { type: 'text/plain' }));
    a.download = `checklist_${Date.now()}.txt`; a.click();
}

// ──────────────────────────────────────────────────────────────────────────────
// DOWNLOAD — Word (.docx)
// ──────────────────────────────────────────────────────────────────────────────
async function downloadWord() {
    if (!window.docx) {
        alert('Word export library failed to load. Please check your internet connection and refresh the page.');
        return;
    }
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
        AlignmentType, BorderStyle, WidthType, VerticalAlign } = window.docx;

    const matched = state.matchedData;
    const items = state.checklistItems;
    const school = (matched.schoolName || 'school').replace(/[^a-z0-9]/gi, '_').substring(0, 30);

    const PW = 10080;
    const MARGIN = 1080;
    const FONT = 'Calibri';
    const SZ_TTL = 26;
    const SZ = 22;
    const SZ_SM = 22;

    const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
    const noBorders = {
        top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
        insideH: noBorder, insideV: noBorder
    };

    function p(runs, opts = {}) {
        const children = typeof runs === 'string'
            ? [new TextRun({
                text: runs, bold: opts.bold || false, italics: opts.italic || false,
                size: opts.size || SZ, font: FONT, color: '000000'
            })]
            : runs;
        return new Paragraph({
            alignment: opts.align || AlignmentType.LEFT,
            spacing: opts.sp || { before: 0, after: 60 },
            indent: opts.indent,
            border: opts.border,
            children,
        });
    }

    function rule() {
        return new Paragraph({
            spacing: { before: 0, after: 100 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
            children: [new TextRun({ text: '', size: SZ, font: FONT })],
        });
    }

    function twoCol(leftChildren, rightChildren, leftW) {
        const rightW = PW - leftW;
        return new Table({
            width: { size: PW, type: WidthType.DXA },
            columnWidths: [leftW, rightW],
            borders: noBorders,
            rows: [new TableRow({
                children: [
                    new TableCell({
                        borders: noBorders, width: { size: leftW, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.TOP,
                        margins: { top: 0, bottom: 0, left: 0, right: 160 },
                        children: leftChildren
                    }),
                    new TableCell({
                        borders: noBorders, width: { size: rightW, type: WidthType.DXA },
                        verticalAlign: VerticalAlign.TOP,
                        margins: { top: 0, bottom: 0, left: 0, right: 0 },
                        children: rightChildren
                    }),
                ]
            })]
        });
    }

    function hRow(label, value) {
        return new TableRow({
            children: [
                new TableCell({
                    borders: noBorders, width: { size: 2700, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 0, right: 80 },
                    children: [p(label, { sp: { before: 0, after: 40 } })]
                }),
                new TableCell({
                    borders: noBorders, width: { size: PW - 2700, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 80, right: 0 },
                    children: [new Paragraph({
                        spacing: { before: 0, after: 40 },
                        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
                        children: [new TextRun({ text: value || '', size: SZ, font: FONT, color: '000000' })],
                    })],
                }),
            ]
        });
    }

    function hRowSY(label, value) {
        const L = 2700, V = 3000, S = 600, SV = PW - L - V - S;
        return new TableRow({
            children: [
                new TableCell({
                    borders: noBorders, width: { size: L, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 0, right: 80 },
                    children: [p(label, { sp: { before: 0, after: 40 } })]
                }),
                new TableCell({
                    borders: noBorders, width: { size: V, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 80, right: 100 },
                    children: [new Paragraph({
                        spacing: { before: 0, after: 40 },
                        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
                        children: [new TextRun({ text: value || '', size: SZ, font: FONT, color: '000000' })],
                    })],
                }),
                new TableCell({
                    borders: noBorders, width: { size: S, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 100, right: 100 },
                    children: [p('SY', { sp: { before: 0, after: 40 }, align: AlignmentType.CENTER })]
                }),
                new TableCell({
                    borders: noBorders, width: { size: SV, type: WidthType.DXA },
                    margins: { top: 0, bottom: 0, left: 100, right: 0 },
                    children: [new Paragraph({
                        spacing: { before: 0, after: 40 },
                        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: '000000', space: 1 } },
                        children: [new TextRun({ text: '', size: SZ, font: FONT })],
                    })],
                }),
            ]
        });
    }

    function checkItem(item, num) {
        const mark = item.found === true ? '\u2714  '
            : item.found === false ? '\u2718  '
                : '________  ';
        return p([
            new TextRun({ text: mark, bold: true, size: SZ, font: FONT, color: '000000' }),
            new TextRun({ text: num + '.  ' + item.text, size: SZ, font: FONT, color: '000000' }),
        ], { sp: { before: 0, after: 20 } });
    }

    function subItem(item, label) {
        const mark = item.found === true ? '\u2714  '
            : item.found === false ? '\u2718  '
                : '_________  ';
        return p([
            new TextRun({ text: mark, bold: true, size: SZ_SM, font: FONT, color: '000000' }),
            new TextRun({ text: '(' + label + ')  ' + item.text, size: SZ_SM, font: FONT, color: '000000' }),
        ], { sp: { before: 0, after: 20 }, indent: { left: 720 } });
    }

    const checklistParas = [];
    let mainNum = 0;
    items.forEach(item => {
        const subMatch = String(item.id).match(/^(\d+)([a-z]+)$/);
        if (subMatch) {
            checklistParas.push(subItem(item, subMatch[2]));
        } else {
            mainNum++;
            checklistParas.push(checkItem(item, mainNum));
        }
    });

    function sigLine(text, bold) {
        return new Paragraph({
            spacing: { before: 440, after: 0 },
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 1 } },
            children: [new TextRun({ text: text || '', bold: !!bold, size: SZ, font: FONT, color: '000000' })],
        });
    }

    // Determine title text based on checklist type
    const typeLabels = {
        tuition_increase: 'Processing Checklist for Application for Increase & Notation in School Fees',
        no_increase: 'Processing Checklist for No Increase Application in School Fees',
        school_calendar: 'Processing Checklist for School Calendar Submission',
    };
    const docTitle = typeLabels[state.checklistType] || typeLabels.tuition_increase;

    const doc2 = new Document({
        styles: { default: { document: { run: { font: FONT, size: SZ } } } },
        sections: [{
            properties: {
                page: {
                    size: { width: 12240, height: 15840 },
                    margin: { top: MARGIN, right: MARGIN, bottom: MARGIN, left: MARGIN },
                }
            },
            children: [
                p(docTitle,
                    { align: AlignmentType.CENTER, bold: true, size: SZ_TTL, sp: { before: 0, after: 20 } }),
                p('In Private Pre-Elementary, Elementary and Junior High Schools',
                    { align: AlignmentType.CENTER, bold: true, size: SZ_TTL, sp: { before: 0, after: 20 } }),
                p('( per D.O No. 12,  s. 1997)',
                    { align: AlignmentType.CENTER, bold: true, italic: true, size: SZ_TTL, sp: { before: 0, after: 160 } }),

                new Table({
                    width: { size: PW, type: WidthType.DXA },
                    columnWidths: [2700, PW - 2700],
                    borders: noBorders,
                    rows: [
                        hRow('Name of School:', matched.schoolName || ''),
                        hRow('Location / Address:', matched.location || ''),
                        hRow('SY applied for:', matched.syApplied || ''),
                    ]
                }),
                new Table({
                    width: { size: PW, type: WidthType.DXA },
                    columnWidths: [2700, 3000, 600, PW - 2700 - 3000 - 600],
                    borders: noBorders,
                    rows: [
                        hRowSY('Government Recognition No:', matched.govRecogNo || ''),
                        hRowSY('Government Permit No:', matched.govPermitNo || ''),
                    ]
                }),

                p('', { sp: { before: 120, after: 0 } }),

                ...checklistParas,

                p('', { sp: { before: 100, after: 0 } }),

                p('OTHER FINDINGS (specify)', { sp: { before: 60, after: 80 } }),
                rule(), rule(), rule(), rule(),

                p('', { sp: { before: 80, after: 0 } }),

                p('RECOMMENDATIONS', { sp: { before: 60, after: 80 } }),
                rule(), rule(), rule(), rule(),

                p('', { sp: { before: 160, after: 0 } }),

                twoCol(
                    [
                        p('Validated by:', { sp: { before: 0, after: 0 } }),
                        sigLine('', false),
                        p('Name', { sp: { before: 40, after: 0 } }),
                        p('', { sp: { before: 60, after: 0 } }),
                        p('RO-QAD', { sp: { before: 0, after: 0 } }),
                    ],
                    [
                        p('Processed/Evaluated by:', { sp: { before: 0, after: 0 } }),
                        sigLine(matched.evaluatedBy || 'MA. AUREA RHODORA DC. GERONIMO, PhD', true),
                        p('Chief, SGOD/ In-Charge of Private Schools', { sp: { before: 40, after: 0 } }),
                        p('', { sp: { before: 80, after: 0 } }),
                        sigLine(matched.dateReceived || '', false),
                        p('Date', { sp: { before: 40, after: 0 } }),
                    ],
                    3200
                ),
            ]
        }]
    });

    const blob = await Packer.toBlob(doc2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'checklist_' + school + '_' + Date.now() + '.docx';
    a.click();
}

// ──────────────────────────────────────────────────────────────────────────────
// START OVER
// ──────────────────────────────────────────────────────────────────────────────
function startOver() {
    state.pdfFile = null;
    state.extractedText = ''; state.matchedData = {}; state.checklistItems = [];
    state.complianceScore = 0; state.aiSummary = ''; state.overallStatus = '';
    state.savedReportId = null; state.calendarDaysFound = null; state.calendarMonths = [];
    document.getElementById('pdfFile').value = '';
    document.getElementById('pdfPill').classList.remove('visible');
    document.getElementById('extractPdfBtn').disabled = true;
    document.getElementById('step1Preview').style.display = 'none';
    state.checklistType = 'tuition_increase';
    document.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
    const firstTypeBtn = document.querySelector('.type-btn');
    if (firstTypeBtn) firstTypeBtn.classList.add('active');
    const continueBtn = document.getElementById('step1ContinueBtn');
    if (continueBtn) continueBtn.disabled = true;
    hideMsg('pdfMsg'); hideMsg('validationMsg'); hideMsg('reportSaveMsg');
    document.querySelectorAll('.step-tab').forEach(t => t.classList.remove('done'));
    goStep(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// SIDEBAR / AUTH
// ──────────────────────────────────────────────────────────────────────────────
function navigate(sectionName) {
	const routes = {
		dashboard: 'dashboard.html',
		programs: 'qatame.html',
		qatame: 'qatame.html',
		qms: 'qms.html',
		sbm: 'sbm.html',
		sgc: 'sgc.html',
		sdopir: 'sdopir.html',
		spir: 'spir.html',
		importfile: 'import-excell.html',
		speakers: 'speaker-roster.html',
		certificates: 'certificate.html',
		certificatesplitter: 'certificates-splitter.html',
		checklist: 'checklist.html',
		documentssubmittedall: 'documents-submitted-all.html',
		settings: 'main-settings.html',
		users: 'user-management.html',
		directory: 'directory.html',
		auditlogs: 'audit-logs.html',
		announcements: 'announcements.html'
	};
	if (routes[sectionName]) {
		closeMobileSidebar();
		window.location.href = routes[sectionName];
	}
}

// Sets a submenu's max-height to its actual content height (when expanded)
// or 0 (when collapsed), using an inline !important style so it always wins
// over the CSS fallback (.submenu.expanded { max-height: 300px }), which is
// too small once nested submenus are open.
function setSubmenuHeight(submenu) {
    if (!submenu) return;
    if (submenu.classList.contains('expanded')) {
        submenu.style.setProperty('max-height', submenu.scrollHeight + 'px', 'important');
    } else {
        submenu.style.setProperty('max-height', '0px', 'important');
    }
}

// Walks up through any ancestor .submenu elements and, if they're expanded,
// recalculates their height so a nested submenu opening/closing doesn't get
// clipped by a parent submenu's own fixed max-height.
function updateAncestorSubmenuHeights(el) {
    let parent = el.parentElement;
    while (parent) {
        if (parent.classList && parent.classList.contains('submenu')) {
            setSubmenuHeight(parent);
        }
        parent = parent.parentElement;
    }
}

function toggleSubmenu(menuName) {
    expandedMenus[menuName] = !expandedMenus[menuName];
    const submenu = document.getElementById(`${menuName}-submenu`);
    const arrow = document.getElementById(`${menuName}-arrow`);
    if (expandedMenus[menuName]) {
        submenu.classList.add('expanded');
        arrow.classList.add('rotate');
        arrow.parentElement.classList.add('expanded');
    } else {
        submenu.classList.remove('expanded');
        arrow.classList.remove('rotate');
        arrow.parentElement.classList.remove('expanded');
    }

    setSubmenuHeight(submenu);
    updateAncestorSubmenuHeights(submenu);

    // The call above measures ancestor submenus' scrollHeight synchronously,
    // in the same tick that this submenu's own max-height transition just
    // started. At that instant the transition hasn't progressed yet, so any
    // ancestor's scrollHeight is measured *before* this submenu has actually
    // grown/shrunk - meaning the ancestor can get locked to a height that's
    // too small (clipping later items) or briefly wrong. Once this submenu's
    // own max-height transition finishes, re-measure the ancestors again so
    // they end up sized to the real, final content height.
    submenu.addEventListener('transitionend', function onDone(e) {
        if (e.propertyName === 'max-height') {
            updateAncestorSubmenuHeights(submenu);
            submenu.removeEventListener('transitionend', onDone);
        }
    });
}
function toggleMobileSidebar() {
    document.querySelector('.sidebar')?.classList.toggle('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.toggle('open');
}
function closeMobileSidebar() {
    document.querySelector('.sidebar')?.classList.remove('mobile-open');
    document.getElementById('sidebarBackdrop')?.classList.remove('open');
}


// ──────────────────────────────────────────────────────────────────────────────
// RECORDS MODAL
// ──────────────────────────────────────────────────────────────────────────────
let _allRecords = [];
let _recordFilter = 'all';
let _recordSearch = '';

async function openRecordsModal() {
    document.getElementById('recordsModalOverlay').classList.add('open');
    document.body.style.overflow = 'hidden';
    await fetchRecords();
}

function closeRecordsModal(e) {
    if (e && e.target !== document.getElementById('recordsModalOverlay')) return;
    document.getElementById('recordsModalOverlay').classList.remove('open');
    document.body.style.overflow = '';
}

function closeDetailModal(e) {
    if (e && e.target !== document.getElementById('detailModalOverlay')) return;
    document.getElementById('detailModalOverlay').classList.remove('open');
}

async function fetchRecords() {
    const loading = document.getElementById('recordsLoading');
    const tableWrap = document.getElementById('recordsTableWrap');
    const errorDiv = document.getElementById('recordsError');

    loading.style.display = 'flex';
    tableWrap.style.display = 'none';
    errorDiv.style.display = 'none';

    try {
        const res = await fetch(CONFIG.API_URL + '/checklist-results.php', {
            method: 'GET', credentials: 'include'
        });
        const json = await res.json();
        if (!res.ok || !json.success) throw new Error(json.message || 'Failed to load records.');

        _allRecords = json.records || [];
        loading.style.display = 'none';
        tableWrap.style.display = 'block';
        renderRecordsTable();

    } catch (err) {
        loading.style.display = 'none';
        errorDiv.style.display = 'flex';
        document.getElementById('recordsErrorMsg').textContent = err.message || 'Could not load records.';
    }
}

function setRecordFilter(filter, btn) {
    _recordFilter = filter;
    document.querySelectorAll('.rec-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderRecordsTable();
}

function filterRecords() {
    _recordSearch = document.getElementById('recordsSearch').value.toLowerCase();
    renderRecordsTable();
}

function renderRecordsTable() {
    const grid = document.getElementById('recordsGrid');
    const empty = document.getElementById('recordsEmpty');
    const countLabel = document.getElementById('recordsCount');

    let filtered = _allRecords;

    if (_recordFilter !== 'all') {
        filtered = filtered.filter(r => r.overall_status === _recordFilter);
    }
    if (_recordSearch) {
        filtered = filtered.filter(r =>
            (r.school_name || '').toLowerCase().includes(_recordSearch) ||
            (r.overall_status || '').toLowerCase().includes(_recordSearch) ||
            (r.checklist_type || '').toLowerCase().includes(_recordSearch) ||
            (r.sy_applied || '').toLowerCase().includes(_recordSearch)
        );
    }

    countLabel.textContent = filtered.length + ' record' + (filtered.length !== 1 ? 's' : '');

    if (!filtered.length) {
        grid.innerHTML = '';
        empty.style.display = 'flex';
        return;
    }
    empty.style.display = 'none';

    const typeLabel = { tuition_increase: 'Tuition Increase', no_increase: 'No Increase', school_calendar: 'School Calendar' };
    const statusClass = { 'COMPLIANT': 'badge-compliant', 'NON-COMPLIANT': 'badge-noncompliant', 'NEEDS REVIEW': 'badge-review' };

    grid.innerHTML = filtered.map(r => {
        const score = Number(r.compliance_score);
        const ringColor = score >= 80 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
        const date = r.created_at ? new Date(r.created_at).toLocaleDateString('en-PH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—';
        const isCalendar = r.checklist_type === 'school_calendar';

        return `<div class="program-card" onclick="openDetailModal(${r.id})" style="cursor: pointer;">
            <div class="program-card-header" style="justify-content: space-between;">
                <div class="card-badges">
                    <span class="overall-badge ${statusClass[r.overall_status] || 'badge-review'} badge-sm status-badge" style="padding: 4px 12px; font-size: 10px;">${esc(r.overall_status || '—')}</span>
                </div>
                <div class="rec-score-wrap" style="transform: scale(0.8); transform-origin: right center;">
                    <svg width="36" height="36" viewBox="0 0 36 36">
                        <circle cx="18" cy="18" r="14" fill="none" stroke="#e2e8f0" stroke-width="4"/>
                        <circle cx="18" cy="18" r="14" fill="none" stroke="${ringColor}" stroke-width="4"
                            stroke-dasharray="${(score / 100) * 87.96} 87.96"
                            stroke-linecap="round" transform="rotate(-90 18 18)"/>
                    </svg>
                    <span class="rec-score-num" style="color:${ringColor}; font-size: 11px;">${score}%</span>
                </div>
            </div>
            <div class="program-card-body">
                <div class="card-proponent" style="color: var(--blue-mid); font-size: 11px; margin-bottom: 5px; font-weight: 700; text-transform: uppercase;">${esc(typeLabel[r.checklist_type] || r.checklist_type)}</div>
                <h3 class="card-title" style="margin-bottom: 12px;">${esc(r.school_name || '—')}</h3>
                <div class="card-meta">
                    <span><i class="fa-solid fa-location-dot"></i> ${esc(r.location || '—')}</span>
                    <span><i class="fa-solid fa-calendar-days"></i> SY ${esc(r.sy_applied || '—')}</span>
                </div>
            </div>
            <div class="program-card-footer" style="flex-direction: column; gap: 8px; align-items: stretch;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <span class="card-participants">
                        <i class="fa-solid fa-clock"></i>
                        <span class="card-participants-total">Saved ${date}</span>
                    </span>
                    <button class="btn-view-detail" style="background: none; border: none; color: var(--blue-light); font-size: 14px; cursor: pointer;" onclick="event.stopPropagation(); openDetailModal(${r.id})"><i class="fa-solid fa-arrow-right"></i></button>
                </div>
                <div style="display:flex; gap:6px; flex-wrap:wrap;" onclick="event.stopPropagation()">
                    <button onclick="generateIndorsementLetter(${r.id})" style="flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; background:#f0f9ff; border:1px solid #bae6fd; color:#0369a1; border-radius:7px; padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer; white-space:nowrap;" title="Generate Indorsement Letter">
                        <i class="fa-solid fa-file-signature"></i> Indorsement
                    </button>
                    <button onclick="openEditRecordModal(${r.id})" style="flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d; border-radius:7px; padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer;" title="Edit Record">
                        <i class="fa-solid fa-pen-to-square"></i> Edit
                    </button>
                    <button onclick="deleteRecord(${r.id})" style="flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:5px; background:#fef2f2; border:1px solid #fecaca; color:#dc2626; border-radius:7px; padding:6px 8px; font-size:11px; font-weight:600; cursor:pointer;" title="Delete Record">
                        <i class="fa-solid fa-trash"></i> Delete
                    </button>
                </div>
            </div>
        </div>`;
    }).join('');
}

function openDetailModal(id) {
    const r = _allRecords.find(x => x.id === id);
    if (!r) return;

    document.getElementById('detailModalTitle').textContent = r.school_name || 'Record #' + id;

    const typeLabel = { tuition_increase: 'Tuition Fee Increase', no_increase: 'No Increase', school_calendar: 'School Calendar' };
    const statusClass = { 'COMPLIANT': 'badge-compliant', 'NON-COMPLIANT': 'badge-noncompliant', 'NEEDS REVIEW': 'badge-review' };
    const score = Number(r.compliance_score);
    const ringColor = score >= 80 ? '#16a34a' : score >= 50 ? '#d97706' : '#dc2626';
    const date = r.created_at ? new Date(r.created_at).toLocaleString('en-PH', { dateStyle: 'medium', timeStyle: 'short' }) : '—';

    let items = [];
    try { items = JSON.parse(r.items_json || '[]'); } catch (e) { }

    let fields = {};
    try { fields = JSON.parse(r.fields_json || '{}'); } catch (e) { }

    const circ = 2 * Math.PI * 38;
    const dash = (score / 100) * circ;

    let calBanner = '';
    if (r.checklist_type === 'school_calendar' && r.calendar_days_found != null) {
        const days = Number(r.calendar_days_found);
        const inRange = r.calendar_in_range == 1;
        const bc = inRange ? '#f0fdf4' : '#fef2f2';
        const brd = inRange ? '#bbf7d0' : '#fecaca';
        const tc = inRange ? '#16a34a' : '#dc2626';
        calBanner = `<div style="display:flex;align-items:center;gap:10px;padding:10px 16px;border-radius:8px;
            background:${bc};border:1px solid ${brd};margin-top:12px;">
            <span style="font-size:20px;color:${tc};">${inRange ? '✓' : '✗'}</span>
            <span style="font-size:13px;font-weight:600;color:${tc};">
                ${days} school days — ${inRange ? 'within 200–220 day range' : (days < 200 ? 'BELOW 200-day minimum' : 'ABOVE 220-day maximum')}
            </span>
        </div>`;
    }

    const fieldLabels = {
        schoolName: 'Name of School', location: 'Location / Address', syApplied: 'SY Applied For',
        dateReceived: 'Date Received', govRecogNo: 'Govt. Recognition No.', govPermitNo: 'Govt. Permit No.',
        schoolHead: 'School Head', evaluatedBy: 'Evaluated By'
    };

    const fieldRows = Object.entries(fields).filter(([k, v]) => v).map(([k, v]) =>
        `<div class="detail-field-row">
            <div class="detail-field-label">${esc(fieldLabels[k] || k)}</div>
            <div class="detail-field-value">${esc(v)}</div>
        </div>`
    ).join('');

    const checkRows = items.map(item =>
        `<div class="detail-check-row ${item.found ? 'detail-found' : 'detail-missing'}">
            <div class="detail-check-icon">${item.found ? '✓' : '✗'}</div>
            <div class="detail-check-body">
                <div class="detail-check-id">Item ${item.id}</div>
                <div class="detail-check-text">${esc(item.text)}</div>
                ${item.remark ? `<div class="detail-check-remark">${esc(item.remark)}</div>` : ''}
            </div>
        </div>`
    ).join('');

    document.getElementById('detailModalBody').innerHTML = `
        <div class="detail-score-row">
            <div class="detail-score-ring">
                <svg width="90" height="90" viewBox="0 0 90 90">
                    <circle cx="45" cy="45" r="38" fill="none" stroke="#e2e8f0" stroke-width="7"/>
                    <circle cx="45" cy="45" r="38" fill="none" stroke="${ringColor}" stroke-width="7"
                        stroke-dasharray="${dash} ${circ}" stroke-linecap="round"
                        transform="rotate(-90 45 45)"/>
                </svg>
                <div class="score-ring-label">
                    <span class="score-ring-pct" style="color:${ringColor};">${score}%</span>
                    <span class="score-ring-sub">Score</span>
                </div>
            </div>
            <div class="detail-score-meta">
                <div class="detail-meta-row"><i class="fa-solid fa-school"></i> ${esc(r.school_name || '—')}</div>
                <div class="detail-meta-row"><i class="fa-solid fa-tag"></i> ${typeLabel[r.checklist_type] || r.checklist_type}</div>
                <div class="detail-meta-row"><i class="fa-solid fa-calendar"></i> SY ${esc(r.sy_applied || '—')}</div>
                <div class="detail-meta-row"><i class="fa-solid fa-clock"></i> Saved ${date}</div>
                <span class="overall-badge ${statusClass[r.overall_status] || 'badge-review'} badge-sm" style="margin-top:8px;display:inline-block;">${esc(r.overall_status)}</span>
                ${calBanner}
            </div>
        </div>

        ${r.ai_summary ? `<div class="detail-summary-block">
            <div class="detail-section-title"><i class="fa-solid fa-robot"></i> AI Summary</div>
            <p>${esc(r.ai_summary)}</p>
        </div>` : ''}

        ${fieldRows ? `<div class="detail-fields-block">
            <div class="detail-section-title"><i class="fa-solid fa-circle-info"></i> School Information</div>
            ${fieldRows}
        </div>` : ''}

        <div class="detail-checklist-block">
            <div class="detail-section-title"><i class="fa-solid fa-list-check"></i> Checklist Results</div>
            ${checkRows || '<p style="color:var(--muted);font-size:13px;">No checklist items recorded.</p>'}
        </div>
    `;

    // Update the footer action buttons
    const actionsDiv = document.getElementById('detailModalActions');
    if (actionsDiv) {
        const isCalendar = r.checklist_type === 'school_calendar';
        actionsDiv.innerHTML = `
            <button class="btn" onclick="generateIndorsementLetter(${r.id})" style="background:#f0f9ff; border:1px solid #bae6fd; color:#0369a1; font-weight:600;">
                <i class="fa-solid fa-file-signature"></i> Generate Indorsement
            </button>
            <button class="btn" onclick="openEditRecordModal(${r.id})" style="background:#f0fdf4; border:1px solid #bbf7d0; color:#15803d; font-weight:600;">
                <i class="fa-solid fa-pen-to-square"></i> Edit
            </button>
            <button class="btn" onclick="deleteRecord(${r.id}, true)" style="background:#fef2f2; border:1px solid #fecaca; color:#dc2626; font-weight:600;">
                <i class="fa-solid fa-trash"></i> Delete
            </button>
        `;
    }

    document.getElementById('detailModalOverlay').classList.add('open');
}

// ── DELETE RECORD ──
async function deleteRecord(id, fromDetail = false) {
    if (!confirm('Are you sure you want to delete this record? This cannot be undone.')) return;
    try {
        const res = await fetch(`${API_URL}/checklist.php?action=delete_record&id=${id}`, {
            method: 'DELETE',
            credentials: 'include'
        });
        const json = await res.json().catch(() => ({}));
        if (json.success || res.ok) {
            if (fromDetail) closeDetailModal();
            // Remove from local cache and re-render
            _allRecords = _allRecords.filter(r => r.id !== id);
            renderRecords();
            showToast('Record deleted successfully.', 'success');
        } else {
            alert('Failed to delete record: ' + (json.message || 'Unknown error'));
        }
    } catch (e) {
        alert('Network error while deleting record.');
    }
}

function showToast(msg, type = 'info') {
    let toast = document.getElementById('_globalToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = '_globalToast';
        toast.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:13px;font-weight:600;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.18);transition:opacity .3s;';
        document.body.appendChild(toast);
    }
    const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#6366f1';
    toast.style.background = bg;
    toast.style.opacity = '1';
    toast.textContent = msg;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 3000);
}

// ── EDIT RECORD MODAL ──
function openEditRecordModal(id) {
    const r = _allRecords.find(x => x.id === id);
    if (!r) return;

    let fields = {};
    try { fields = JSON.parse(r.fields_json || '{}'); } catch (e) { }

    // Remove existing edit modal if any
    const existing = document.getElementById('editRecordModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'editRecordModal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;padding:16px;';
    overlay.innerHTML = `
        <div style="background:#fff;border-radius:16px;width:100%;max-width:540px;max-height:90vh;overflow-y:auto;box-shadow:0 20px 60px rgba(0,0,0,.25);">
            <div style="padding:20px 24px 12px;border-bottom:1px solid #e5e7eb;display:flex;align-items:center;justify-content:space-between;">
                <div style="font-size:16px;font-weight:700;color:#1e293b;"><i class="fa-solid fa-pen-to-square" style="margin-right:8px;color:#6366f1;"></i>Edit Record</div>
                <button onclick="document.getElementById('editRecordModal').remove()" style="background:none;border:none;font-size:20px;cursor:pointer;color:#94a3b8;">&times;</button>
            </div>
            <div style="padding:20px 24px;">
                <div style="display:grid;gap:14px;">
                    <label style="font-size:13px;font-weight:600;color:#374151;">School Name
                        <input id="edit_schoolName" value="${esc(r.school_name || '')}" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;" />
                    </label>
                    <label style="font-size:13px;font-weight:600;color:#374151;">Location / Address
                        <input id="edit_location" value="${esc(r.location || fields.location || '')}" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;" />
                    </label>
                    <label style="font-size:13px;font-weight:600;color:#374151;">SY Applied For
                        <input id="edit_syApplied" value="${esc(r.sy_applied || fields.syApplied || '')}" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;" />
                    </label>
                    <label style="font-size:13px;font-weight:600;color:#374151;">School Head
                        <input id="edit_schoolHead" value="${esc(fields.schoolHead || '')}" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;" />
                    </label>
                    <label style="font-size:13px;font-weight:600;color:#374151;">Date Received
                        <input id="edit_dateReceived" value="${esc(fields.dateReceived || r.date_received || '')}" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;" />
                    </label>
                    <label style="font-size:13px;font-weight:600;color:#374151;">Overall Status
                        <select id="edit_status" style="margin-top:4px;width:100%;padding:8px 12px;border:1px solid #e5e7eb;border-radius:8px;font-size:13px;box-sizing:border-box;">
                            <option value="COMPLIANT" ${r.overall_status === 'COMPLIANT' ? 'selected' : ''}>COMPLIANT</option>
                            <option value="NON-COMPLIANT" ${r.overall_status === 'NON-COMPLIANT' ? 'selected' : ''}>NON-COMPLIANT</option>
                            <option value="NEEDS REVIEW" ${r.overall_status === 'NEEDS REVIEW' ? 'selected' : ''}>NEEDS REVIEW</option>
                        </select>
                    </label>
                </div>
                <div id="editRecordMsg" style="margin-top:12px;font-size:13px;"></div>
                <div style="display:flex;gap:10px;margin-top:18px;justify-content:flex-end;">
                    <button onclick="document.getElementById('editRecordModal').remove()" style="padding:9px 20px;border-radius:8px;border:1px solid #e5e7eb;background:#f9fafb;font-size:13px;font-weight:600;cursor:pointer;color:#374151;">Cancel</button>
                    <button onclick="saveEditRecord(${id})" style="padding:9px 20px;border-radius:8px;border:none;background:#6366f1;color:#fff;font-size:13px;font-weight:600;cursor:pointer;"><i class="fa-solid fa-floppy-disk" style="margin-right:5px;"></i>Save Changes</button>
                </div>
            </div>
        </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
}

async function saveEditRecord(id) {
    const r = _allRecords.find(x => x.id === id);
    if (!r) return;

    let fields = {};
    try { fields = JSON.parse(r.fields_json || '{}'); } catch (e) { }

    fields.schoolHead = document.getElementById('edit_schoolHead')?.value || fields.schoolHead || '';
    fields.dateReceived = document.getElementById('edit_dateReceived')?.value || fields.dateReceived || '';
    fields.location = document.getElementById('edit_location')?.value || r.location || '';
    fields.syApplied = document.getElementById('edit_syApplied')?.value || r.sy_applied || '';
    fields.schoolName = document.getElementById('edit_schoolName')?.value || r.school_name || '';

    const payload = {
        id,
        school_name: document.getElementById('edit_schoolName')?.value || r.school_name,
        location: document.getElementById('edit_location')?.value || r.location,
        sy_applied: document.getElementById('edit_syApplied')?.value || r.sy_applied,
        overall_status: document.getElementById('edit_status')?.value || r.overall_status,
        fields_json: JSON.stringify(fields),
    };

    const msgEl = document.getElementById('editRecordMsg');
    if (msgEl) { msgEl.style.color = '#6366f1'; msgEl.textContent = 'Saving…'; }

    try {
        const res = await fetch(`${API_URL}/checklist.php?action=update_record`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify(payload)
        });
        const json = await res.json().catch(() => ({}));
        if (json.success || res.ok) {
            // Update local cache
            Object.assign(r, {
                school_name: payload.school_name,
                location: payload.location,
                sy_applied: payload.sy_applied,
                overall_status: payload.overall_status,
                fields_json: payload.fields_json,
            });
            document.getElementById('editRecordModal')?.remove();
            renderRecords();
            showToast('Record updated successfully.', 'success');
        } else {
            if (msgEl) { msgEl.style.color = '#dc2626'; msgEl.textContent = 'Save failed: ' + (json.message || 'Unknown error'); }
        }
    } catch (e) {
        if (msgEl) { msgEl.style.color = '#dc2626'; msgEl.textContent = 'Network error.'; }
    }
}

// ── GENERATE INDORSEMENT LETTER (School Calendar only) ──
/**
 * generateIndorsementLetter(id)
 *
 * Previously auto-generated and downloaded a simple .docx.
 * Now opens the full indorsement modal (indorsement-generator.js) pre-filled
 * with the record's data so the user can review / edit before downloading.
 */
function generateIndorsementLetter(id) {
    const r = _allRecords.find(x => x.id === id);
    if (!r) return;

    let fields = {};
    try { fields = JSON.parse(r.fields_json || '{}'); } catch (e) { }

    // Pull calendar-specific values stored by the AI validator when present
    let totalDays = '';
    let startDate = '';
    let endDate = '';
    try {
        const items = JSON.parse(r.items_json || '[]');
        // Some implementations store days/dates inside fields_json
        totalDays = fields.totalDays || fields.schoolDays || '';
        startDate = fields.startDate || '';
        endDate = fields.endDate || '';
    } catch (e) { }

    const prefill = {
        checklistType: r.checklist_type || 'school_calendar',
        schoolName: r.school_name || fields.schoolName || '',
        address: r.location || fields.location || '',
        sy: r.sy_applied || fields.syApplied || '',
        totalDays,
        startDate,
        endDate,
    };

    // Close the records / detail modal so the indorsement modal sits on top cleanly
    const recOverlay = document.getElementById('recordsModalOverlay');
    if (recOverlay) recOverlay.classList.remove('open');
    const detailOverlay = document.getElementById('detailModalOverlay');
    if (detailOverlay) detailOverlay.classList.remove('open');

    // Open the full indorsement modal with the record data pre-filled
    if (typeof openIndorsementModal === 'function') {
        openIndorsementModal(prefill);
    } else {
        alert('Indorsement generator not loaded. Please ensure indorsement-generator.js is included.');
    }
}

// Add this to your AI system prompt for field extraction:
async function buildSchoolContext() {
    try {
        const res = await fetch(`${API_URL}/checklist.php?action=get_schools`, { credentials: 'include' });
        const json = await res.json();
        if (json.schools) {
            return `\nKNOWN SCHOOLS IN SDO BALIWAG (use these to correct OCR-garbled names):\n` +
                json.schools.map(s => `- ${s.canonical_name}`).join('\n');
        }
    } catch (e) { }
    return '';
}

async function logout() {
    const btn = document.getElementById('logoutBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = 'Logging out…';
    }
    try {
        await fetch(`${API_URL}/logout.php`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include'
        });
    } catch (e) {
    } finally {
        clearSessionAndRedirect();
    }
}