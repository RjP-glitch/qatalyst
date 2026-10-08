const API_URL = CONFIG.API_URL;
let programData = null;
let selectedDayId = null;
let questionsData = {}; // questions grouped by category_id
let categoriesData = []; // all categories
let availablePrograms = []; // list of programs for dropdown

// Category icons mapping
const categoryIcons = {
    1: 'fa-tachometer-alt',      // Program Management
    2: 'fa-bullseye',            // Objectives
    3: 'fa-book',                // Content
    4: 'fa-building',            // Venue
    5: 'fa-utensils',            // Meal/Food
    6: 'fa-users',               // Program Management Team
    7: 'fa-microphone-alt',      // Resource Speaker
    8: 'fa-comment-dots'         // Feedback
};

// Get program ID from URL
const urlParams = new URLSearchParams(window.location.search);
let programId = parseInt(urlParams.get('program_id')) || null;

// Load program data on page load
window.addEventListener('DOMContentLoaded', function () {
    // loadAvailablePrograms();
    if (programId) {
        loadProgramData();
    }
});

// Load available programs for dropdown
// async function loadAvailablePrograms() {
//     try {
//         const response = await fetch(`${API_URL}/evaluation.php?list_programs=1`);
//         const result = await response.json();

//         if (result.success && result.data) {
//             availablePrograms = result.data;
//             populateProgramDropdown();
//         }
//     } catch (error) {
//     }
// }

// Populate program dropdown
// function populateProgramDropdown() {
//     const dropdown = document.getElementById('programTitleDropdown');
//     if (!dropdown) return;

//     dropdown.innerHTML = '<option value="" disabled>Select Program</option>';

//     availablePrograms.forEach(p => {
//         const option = document.createElement('option');
//         option.value = p.id;
//         option.textContent = p.title;
//         if (programId && p.id == programId) {
//             option.selected = true;
//         }
//         dropdown.appendChild(option);
//     });
// }

// Handle program selection change
// function onProgramTitleChange(newProgramId) {
//     if (newProgramId && newProgramId != programId) {
//         programId = newProgramId;
//         // Update URL without reload
//         const newUrl = `${window.location.pathname}?program_id=${programId}`;
//         window.history.pushState({ programId }, '', newUrl);
//         // Reload program data
//         loadProgramData();
//     }
// }

// Load program data
async function loadProgramData() {
    if (!programId) {
        showAlert('info', 'Program ID not specified.');
        return;
    }

    try {
        showLoading(true);
        const response = await fetch(`${API_URL}/evaluation.php?program_id=${programId}`);
        const result = await response.json();

        if (result.success) {
            programData = result.data;

            const rawQuestions = result.data.questions || {};
            questionsData = {};
            for (const catId in rawQuestions) {
                const seen = new Set();
                questionsData[catId] = rawQuestions[catId].filter(q => {
                    if (seen.has(q.id)) return false;
                    seen.add(q.id);
                    return true;
                });
            }
            categoriesData = result.data.categories || [];

            displayProgramInfo();

            // If not submittable, show status wall and stop
            if (!programData.is_submittable) {
                showStatusBlock();
                return;
            }

            displayDays();
        }
    } catch (error) {
        showAlert('error', 'Failed to load program information');
    } finally {
        showLoading(false);
    }
}

function displayProgramInfo() {
    const programInfo = document.getElementById('programInfo');
    const status = programData.effective_status || programData.status;

    const statusConfig = {
        upcoming: { label: 'Upcoming', icon: 'fa-clock', color: '#3b82f6', bg: '#eff6ff', border: '#bfdbfe', desc: 'This program hasn\'t started yet. The form will open on the start date.' },
        ongoing: { label: 'Ongoing', icon: 'fa-circle', color: '#16a34a', bg: '#f0fdf4', border: '#bbf7d0', desc: 'This program is currently active. You may submit your evaluation.' },
        completed: { label: 'Completed', icon: 'fa-check-circle', color: '#7c3aed', bg: '#faf5ff', border: '#ddd6fe', desc: 'This program has concluded. The evaluation period is now closed.' },
        cancelled: { label: 'Cancelled', icon: 'fa-ban', color: '#dc2626', bg: '#fff1f2', border: '#fecdd3', desc: 'This program has been cancelled.' },
    };

    const cfg = statusConfig[status] || statusConfig['ongoing'];

    programInfo.innerHTML = `
        <div class="program-header-card">
            <div class="program-status-badge" style="--s-color:${cfg.color};--s-bg:${cfg.bg};--s-border:${cfg.border}">
                <i class="fas ${cfg.icon} status-pulse-icon"></i>
                <span>${cfg.label}</span>
            </div>
            <h2 class="program-title">${programData.title}</h2>
            <div class="program-meta-grid">
                <div class="program-meta-item">
                    <div class="meta-icon"><i class="fas fa-file-alt"></i></div>
                    <div class="meta-text">
                        <span class="meta-label">Division Memo</span>
                        <span class="meta-value">${programData.division_memo || 'N/A'}</span>
                    </div>
                </div>
                <div class="program-meta-item">
                    <div class="meta-icon"><i class="fas fa-calendar-alt"></i></div>
                    <div class="meta-text">
                        <span class="meta-label">Schedule</span>
                        <span class="meta-value">${formatDate(programData.start_date)} — ${formatDate(programData.end_date)}</span>
                    </div>
                </div>
                <div class="program-meta-item">
                    <div class="meta-icon"><i class="fas fa-map-marker-alt"></i></div>
                    <div class="meta-text">
                        <span class="meta-label">Venue</span>
                        <span class="meta-value">${programData.venue || 'N/A'}</span>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function showStatusBlock() {
    const status = programData.effective_status || programData.status;

    const statusConfig = {
        upcoming: {
            icon: 'fa-hourglass-start',
            color: '#3b82f6',
            bg: 'linear-gradient(135deg, #eff6ff 0%, #dbeafe 100%)',
            border: '#93c5fd',
            title: 'Evaluation Not Yet Open',
            message: 'This program hasn\'t started yet. Please come back on or after the start date to submit your evaluation.',
            badge: 'Upcoming',
            badgeBg: '#dbeafe',
            badgeColor: '#1d4ed8',
        },
        completed: {
            icon: 'fa-flag-checkered',
            color: '#7c3aed',
            bg: 'linear-gradient(135deg, #faf5ff 0%, #ede9fe 100%)',
            border: '#c4b5fd',
            title: 'Evaluation Period Closed',
            message: 'The evaluation period for this program has ended. Thank you to everyone who participated!',
            badge: 'Completed',
            badgeBg: '#ede9fe',
            badgeColor: '#6d28d9',
        },
        cancelled: {
            icon: 'fa-times-circle',
            color: '#dc2626',
            bg: 'linear-gradient(135deg, #fff1f2 0%, #ffe4e6 100%)',
            border: '#fca5a5',
            title: 'Program Cancelled',
            message: 'This program has been cancelled. Please contact the organizer for more information.',
            badge: 'Cancelled',
            badgeBg: '#fee2e2',
            badgeColor: '#b91c1c',
        },
    };

    const cfg = statusConfig[status] || statusConfig['completed'];

    // Hide the form
    document.getElementById('evaluationForm').style.display = 'none';
    document.querySelector('.submit-section').style.display = 'none';

    // Insert status wall after programInfo
    const existing = document.getElementById('statusWall');
    if (existing) existing.remove();

    const wall = document.createElement('div');
    wall.id = 'statusWall';
    wall.innerHTML = `
        <div class="status-wall" style="--sw-color:${cfg.color};--sw-bg:${cfg.bg};--sw-border:${cfg.border}">
            <div class="status-wall-inner">
                <div class="status-wall-icon-wrap">
                    <i class="fas ${cfg.icon}"></i>
                </div>
                <span class="status-wall-badge" style="background:${cfg.badgeBg};color:${cfg.badgeColor}">${cfg.badge}</span>
                <h3 class="status-wall-title">${cfg.title}</h3>
                <p class="status-wall-message">${cfg.message}</p>
                <div class="status-wall-divider"></div>
                <div class="status-wall-program-dates">
                    <i class="fas fa-calendar-alt"></i>
                    ${formatDate(programData.start_date)} — ${formatDate(programData.end_date)}
                </div>
            </div>
        </div>
    `;

    document.getElementById('programInfo').insertAdjacentElement('afterend', wall);
}

// Display workshop days
function displayDays() {
    const daySelector = document.getElementById('daySelector');
    if (!programData.days || programData.days.length === 0) {
        daySelector.innerHTML = '<p style="color: #991b1b;">No workshop days available.</p>';
        return;
    }

    daySelector.innerHTML = programData.days.map(day => `
        <div class="day-option">
            <input type="radio" id="day_${day.id}" name="workshop_day" value="${day.id}" 
                   onchange="selectDay(${day.id})">
            <label for="day_${day.id}">
                <div class="day-title">Day ${day.day_number}</div>
                <div class="day-date">${day.title || ''}</div>
                ${day.date ? `<div class="day-date">${formatDate(day.date)}</div>` : ''}
            </label>
        </div>
    `).join('');
}

// Select day and build dynamic form
function selectDay(dayId) {
    selectedDayId = dayId;
    const selectedDay = programData.days.find(d => d.id == dayId);
    const dynamicSections = document.getElementById('dynamicSections');

    // Clear previous dynamic content
    dynamicSections.innerHTML = '';

    // Build sections for each category
    categoriesData.forEach(category => {
        const categoryQuestions = questionsData[category.id] || [];
        if (categoryQuestions.length === 0) return;

        // Category 7 (Resource Speaker) is handled separately with speaker cards
        if (category.id == 7) {
            if (selectedDay && selectedDay.speakers && selectedDay.speakers.length > 0) {
                const speakerSection = buildSpeakerSection(category, categoryQuestions, selectedDay.speakers);
                dynamicSections.appendChild(speakerSection);
            }
        } else {
            const section = buildCategorySection(category, categoryQuestions);
            dynamicSections.appendChild(section);
        }
    });

    // Scroll to the first section
    const firstSection = dynamicSections.querySelector('.form-section');
    if (firstSection) {
        firstSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// Build a category section with questions
function buildCategorySection(category, questions) {
    const section = document.createElement('div');
    section.className = 'form-section';
    section.id = `category_${category.id}`;

    const icon = categoryIcons[category.id] || 'fa-question-circle';
    const isRatingCategory = questions.some(q => q.question_type === 'rating');

    let headerDesc = category.description || '';
    if (isRatingCategory && !headerDesc) {
        headerDesc = 'Rate the following: 4 - Strongly Agree · 3 - Agree · 2 - Disagree · 1 - Strongly Disagree';
    }

    section.innerHTML = `
        <div class="section-header">
            <div class="section-header-icon"><i class="fas ${icon}"></i></div>
            <div class="section-header-text">
                <h3>${category.name}</h3>
                <p>${headerDesc}</p>
            </div>
        </div>
        <div class="questions-container"></div>
    `;

    const container = section.querySelector('.questions-container');

    questions.forEach(question => {
        const questionEl = buildQuestion(question);
        container.appendChild(questionEl);
    });

    return section;
}

// Build a single question element
function buildQuestion(question) {
    const wrapper = document.createElement('div');

    if (question.question_type === 'rating') {
        wrapper.className = 'rating-question';
        wrapper.innerHTML = `
            <div class="rating-question-text">${question.question_text}</div>
            <div class="rating-options">
                ${[4, 3, 2, 1].map(rating => `
                    <div class="rating-option">
                        <input type="radio" id="q${question.id}_${rating}" 
                               name="question_${question.id}" value="${rating}" 
                               data-question-id="${question.id}"
                               ${question.is_required ? 'required' : ''}>
                        <label for="q${question.id}_${rating}">
                            <span class="rating-scale">${rating}</span>
                            <span class="rating-label">${getRatingLabel(rating)}</span>
                        </label>
                    </div>
                `).join('')}
            </div>
        `;
    } else if (question.question_type === 'select') {
        wrapper.className = 'form-group';
        const options = question.select_options || [];
        wrapper.innerHTML = `
            <label>${question.question_text} ${question.is_required ? '<span class="required">*</span>' : ''}</label>
            <select name="question_${question.id}" data-question-id="${question.id}" 
                    data-question-type="select" ${question.is_required ? 'required' : ''}>
                <option value="">Select...</option>
                ${options.map(opt => `<option value="${opt}">${opt}</option>`).join('')}
            </select>
        `;
    } else if (question.question_type === 'text') {
        wrapper.className = 'form-group';
        wrapper.innerHTML = `
            <label>${question.question_text}</label>
            <textarea name="question_${question.id}" data-question-id="${question.id}"
                      data-question-type="text" placeholder="Enter your response..."
                      ${question.is_required ? 'required' : ''}></textarea>
        `;
    }

    return wrapper;
}

// Build speaker section with dynamic questions
function buildSpeakerSection(category, questions, speakers) {
    const section = document.createElement('div');
    section.className = 'form-section';
    section.id = 'speakersSection';

    const icon = categoryIcons[category.id] || 'fa-microphone-alt';

    section.innerHTML = `
        <div class="section-header">
            <div class="section-header-icon"><i class="fas ${icon}"></i></div>
            <div class="section-header-text">
                <h3>${category.name}</h3>
                <p>Rate each speaker: 4 - Strongly Agree · 3 - Agree · 2 - Disagree · 1 - Strongly Disagree</p>
            </div>
        </div>
        <div id="speakersContainer"></div>
    `;

    const container = section.querySelector('#speakersContainer');

    speakers.forEach(speaker => {
        const speakerCard = document.createElement('div');
        speakerCard.className = 'speaker-card';

        let questionsHtml = questions.map(q => `
            <div class="rating-question">
                <div class="rating-question-text">${q.question_text}</div>
                <div class="rating-options">
                    ${[4, 3, 2, 1].map(rating => `
                        <div class="rating-option">
                            <input type="radio" id="speaker_${speaker.id}_q${q.id}_${rating}" 
                                   name="speaker_${speaker.id}_question_${q.id}" value="${rating}"
                                   data-speaker-id="${speaker.id}" data-question-id="${q.id}"
                                   ${q.is_required ? 'required' : ''}>
                            <label for="speaker_${speaker.id}_q${q.id}_${rating}">
                                <span class="rating-scale">${rating}</span>
                                <span class="rating-label">${getRatingLabel(rating)}</span>
                            </label>
                        </div>
                    `).join('')}
                </div>
            </div>
        `).join('');

        speakerCard.innerHTML = `
            <div class="speaker-header">
                <div class="speaker-name">${speaker.name}</div>
                <div class="speaker-details">
                    ${speaker.designation ? speaker.designation : ''}
                    ${speaker.organization ? ` • ${speaker.organization}` : ''}
                    ${speaker.topic ? `<br><em>${speaker.topic}</em>` : ''}
                </div>
            </div>
            ${questionsHtml}
            <input type="hidden" name="speaker_ids[]" value="${speaker.id}">
        `;

        container.appendChild(speakerCard);
    });

    return section;
}

// Get rating label
function getRatingLabel(rating) {
    const labels = {
        4: 'Strongly Agree',
        3: 'Agree',
        2: 'Disagree',
        1: 'Strongly Disagree'
    };
    return labels[rating];
}

// Submit evaluation
async function submitEvaluation() {
    const form = document.getElementById('evaluationForm');

    if (!form.checkValidity()) {
        form.reportValidity();
        return;
    }

    if (!selectedDayId) {
        showAlert('error', 'Please select a workshop day');
        return;
    }

    try {
        showLoading(true);

        const formData = new FormData(form);

        // Build participant data
        // Normalize sex to match DB enum('Male','Female') — 'Prefer not to say' is not valid
        const rawSex = formData.get('sex') || '';
        const sex = (rawSex === 'Male' || rawSex === 'Female') ? rawSex : 'Prefer not to say';

        const participantData = {
            first_name: formData.get('firstName'),
            last_name: formData.get('lastName'),
            email: formData.get('email'),
            phone: formData.get('phone'),
            sex: sex,
            age: parseInt(formData.get('age')) || null,
            organization: formData.get('organization'),
            position: formData.get('position')
        };

        // Collect answers using question IDs (using Map to deduplicate by question_id)
        const answersMap = new Map();
        const speakerAnswers = [];

        // Get all rating inputs
        document.querySelectorAll('input[type="radio"]:checked[data-question-id]').forEach(input => {
            const questionId = parseInt(input.dataset.questionId);
            const speakerId = input.dataset.speakerId ? parseInt(input.dataset.speakerId) : null;
            const value = parseInt(input.value);

            if (speakerId) {
                speakerAnswers.push({
                    speaker_id: speakerId,
                    question_id: questionId,
                    rating_value: value
                });
            } else {
                // Merge with existing entry or create new
                const existing = answersMap.get(questionId) || { question_id: questionId };
                existing.rating_value = value;
                answersMap.set(questionId, existing);
            }
        });

        // Get all select inputs
        document.querySelectorAll('select[data-question-id]').forEach(select => {
            if (select.value) {
                const questionId = parseInt(select.dataset.questionId);
                const existing = answersMap.get(questionId) || { question_id: questionId };
                existing.select_value = select.value;
                answersMap.set(questionId, existing);
            }
        });

        // Get all text inputs
        document.querySelectorAll('textarea[data-question-id]').forEach(textarea => {
            if (textarea.value.trim()) {
                const questionId = parseInt(textarea.dataset.questionId);
                const existing = answersMap.get(questionId) || { question_id: questionId };
                existing.text_value = textarea.value.trim();
                answersMap.set(questionId, existing);
            }
        });

        // Convert map to array
        const answers = Array.from(answersMap.values());

        const data = {
            program_id: programId,
            workshop_day_id: selectedDayId,
            participant: participantData,
            answers: answers,
            speaker_answers: speakerAnswers
        };

        const response = await fetch(`${API_URL}/evaluation.php`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(data)
        });

        const result = await response.json();

        if (result.success) {
            document.getElementById('formContainer').style.display = 'none';
            document.getElementById('successContainer').classList.add('show');
        } else {
            showAlert('error', result.message || 'Failed to submit evaluation');
        }
    } catch (error) {
        showAlert('error', 'Failed to submit evaluation. Please try again.');
    } finally {
        showLoading(false);
    }
}

// Show/hide loading overlay
function showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (show) {
        overlay.classList.add('show');
    } else {
        overlay.classList.remove('show');
    }
}

// Show alert message
function showAlert(type, message) {
    const alert = document.getElementById('alertMessage');
    alert.className = `alert alert-${type} show`;
    alert.textContent = message;

    // Scroll to top
    window.scrollTo({ top: 0, behavior: 'smooth' });

    setTimeout(() => {
        alert.classList.remove('show');
    }, 5000);
}

// Format date
function formatDate(dateString) {
    if (!dateString) return 'N/A';
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

// function formatSubmittedAt(dateString) {
//     if (!dateString) return 'N/A';
//     // Treat the raw DB timestamp as UTC, convert to Manila time
//     const date = new Date(dateString + 'Z');
//     return date.toLocaleString('en-PH', {
//         timeZone: 'Asia/Manila',
//         year: 'numeric',
//         month: 'short',
//         day: 'numeric',
//         hour: '2-digit',
//         minute: '2-digit'
//     });
// }