// schema.js — Auto-generated from evaluation_db.sql

const GROUPS = {
	core: { label: 'Core', color: '#4af0a0' },
	eval: { label: 'Evaluation', color: '#6080f0' },
	analytics: { label: 'Analytics', color: '#f09040' },
	auth: { label: 'Auth', color: '#f04080' },
	files: { label: 'Files', color: '#a040f0' },
};

const TABLES = {
	users: {
		group: 'auth',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'email', type: 'varchar(255)', nullable: false },
			{ name: 'password', type: 'varchar(255)', nullable: false },
			{ name: 'full_name', type: 'varchar(255)' },
			{ name: 'status', type: "enum('active','inactive')" },
			{ name: 'email_verified', type: 'tinyint(1)' },
			{ name: 'two_factor_enabled', type: 'tinyint(1)' },
			{ name: 'role', type: 'varchar(50)' },
			{ name: 'permissions', type: 'text' },
			{ name: 'profile_picture', type: 'varchar(255)' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	login_sessions: {
		group: 'auth',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'user_id', type: 'int(11)', fk: 'users.id' },
			{ name: 'session_token', type: 'varchar(255)' },
			{ name: 'ip_address', type: 'varchar(45)' },
			{ name: 'user_agent', type: 'text' },
			{ name: 'expires_at', type: 'datetime' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	password_reset_tokens: {
		group: 'auth',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'user_id', type: 'int(11)', fk: 'users.id' },
			{ name: 'token', type: 'varchar(255)' },
			{ name: 'code', type: 'varchar(6)' },
			{ name: 'is_used', type: 'tinyint(1)' },
			{ name: 'expires_at', type: 'datetime' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	email_verification_codes: {
		group: 'auth',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'user_id', type: 'int(11)', fk: 'users.id' },
			{ name: 'code', type: 'varchar(6)' },
			{ name: 'is_used', type: 'tinyint(1)' },
			{ name: 'expires_at', type: 'datetime' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},

	// CORE
	workshops: {
		group: 'core',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'title', type: 'varchar(255)' },
			{ name: 'division_memo', type: 'varchar(255)' },
			{ name: 'description', type: 'text' },
			{ name: 'start_date', type: 'date' },
			{ name: 'end_date', type: 'date' },
			{ name: 'total_days', type: 'int(11)' },
			{ name: 'venue', type: 'varchar(255)' },
			{ name: 'total_participants', type: 'int(11)' },
			{ name: 'proponents', type: 'varchar(255)' },
			{ name: 'status', type: "enum('draft','active','completed','archived')" },
			{ name: 'created_by', type: 'int(11)', fk: 'users.id' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	workshop_days: {
		group: 'core',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_id', type: 'int(11)', fk: 'workshops.id' },
			{ name: 'day_number', type: 'int(11)' },
			{ name: 'day_date', type: 'date' },
			{ name: 'title', type: 'varchar(255)' },
			{ name: 'description', type: 'text' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	workshop_participants: {
		group: 'core',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_id', type: 'int(11)', fk: 'workshops.id' },
			{ name: 'response_id', type: 'varchar(100)' },
			{ name: 'full_name', type: 'varchar(255)' },
			{ name: 'sex', type: "enum('Male','Female','Other')" },
			{ name: 'participant_type', type: 'varchar(100)' },
			{ name: 'designation', type: 'varchar(255)' },
			{ name: 'school_office', type: 'varchar(255)' },
			{ name: 'email', type: 'varchar(255)' },
			{ name: 'attendance_status', type: "enum('registered','attended','absent')" },
			{ name: 'registered_at', type: 'timestamp' },
			{ name: 'email_sent_at', type: 'timestamp', nullable: true },
		]
	},
	resource_speakers: {
		group: 'core',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_day_id', type: 'int(11)', fk: 'workshop_days.id' },
			{ name: 'speaker_number', type: 'int(11)' },
			{ name: 'name', type: 'varchar(255)' },
			{ name: 'designation', type: 'varchar(255)' },
			{ name: 'organization', type: 'varchar(255)' },
			{ name: 'contact', type: 'varchar(100)' },
			{ name: 'topic', type: 'text' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	participant_roles: {
		group: 'core',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'role_name', type: 'varchar(100)' },
			{ name: 'description', type: 'text' },
			{ name: 'capabilities', type: 'json' },
			{ name: 'display_order', type: 'int(11)' },
			{ name: 'is_active', type: 'tinyint(1)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},

	// EVALUATION
	evaluation_programs: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'title', type: 'varchar(255)' },
			{ name: 'proponents', type: 'varchar(255)' },
			{ name: 'training_venue', type: 'varchar(255)' },
			{ name: 'inclusive_dates', type: 'varchar(255)' },
			{ name: 'qame_associates', type: 'varchar(255)' },
			{ name: 'total_participants', type: 'int(11)' },
			{ name: 'total_responses', type: 'int(11)' },
			{ name: 'avg_responses', type: 'decimal(7,4)' },
			{ name: 'pct_responses', type: 'decimal(7,4)' },
			{ name: 'overall_average', type: 'decimal(7,4)' },
			{ name: 'overall_result', type: 'varchar(100)' },
			{ name: 'detected_scale', type: 'varchar(50)' },
			{ name: 'source_filename', type: 'varchar(255)' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	evaluation_question_categories: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'name', type: 'varchar(255)' },
			{ name: 'description', type: 'text' },
			{ name: 'display_order', type: 'int(11)' },
			{ name: 'is_active', type: 'tinyint(1)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	evaluation_questions: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'category_id', type: 'int(11)', fk: 'evaluation_question_categories.id' },
			{ name: 'workshop_id', type: 'int(11)', fk: 'workshops.id', nullable: true },
			{ name: 'question_text', type: 'text' },
			{ name: 'question_type', type: "enum('rating','text','select')" },
			{ name: 'rating_min', type: 'int(11)' },
			{ name: 'rating_max', type: 'int(11)' },
			{ name: 'select_options', type: 'json' },
			{ name: 'is_for_speaker', type: 'tinyint(1)' },
			{ name: 'is_required', type: 'tinyint(1)' },
			{ name: 'display_order', type: 'int(11)' },
			{ name: 'is_active', type: 'tinyint(1)' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	evaluation_submissions: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_day_id', type: 'int(11)', fk: 'workshop_days.id' },
			{ name: 'participant_id', type: 'int(11)', fk: 'workshop_participants.id' },
			{ name: 'submitted_at', type: 'timestamp' },
		]
	},
	evaluation_answers: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'submission_id', type: 'int(11)', fk: 'evaluation_submissions.id' },
			{ name: 'question_id', type: 'int(11)', fk: 'evaluation_questions.id' },
			{ name: 'rating_value', type: 'int(11)', nullable: true, comment: 'For rating questions (1-4)' },
			{ name: 'text_value', type: 'text', nullable: true, comment: 'For open-ended text questions' },
			{ name: 'select_value', type: 'varchar(255)', nullable: true, comment: 'For dropdown questions' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	evaluation_speaker_answers: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'submission_id', type: 'int(11)', fk: 'evaluation_submissions.id' },
			{ name: 'resource_speaker_id', type: 'int(11)', fk: 'resource_speakers.id' },
			{ name: 'question_id', type: 'int(11)', fk: 'evaluation_questions.id' },
			{ name: 'rating_value', type: 'int(11)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	evaluation_reminders: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_id', type: 'int(11)' },
			{ name: 'participant_id', type: 'int(11)' },
			{ name: 'sent_by', type: 'int(11)' },
			{ name: 'sent_at', type: 'timestamp' },
		]
	},
	rating_scales: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'scale_type', type: 'varchar(50)' },
			{ name: 'min_score', type: 'decimal(5,2)' },
			{ name: 'max_score', type: 'decimal(5,2)' },
			{ name: 'level_of_agreement', type: 'varchar(100)' },
			{ name: 'descriptive_equivalent', type: 'varchar(100)' },
			{ name: 'display_order', type: 'int(11)' },
			{ name: 'is_active', type: 'tinyint(1)' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	eval_settings: {
		group: 'eval',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'setting_key', type: 'varchar(100)' },
			{ name: 'setting_value', type: 'text' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},

	// ANALYTICS
	category_averages: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(10) UNSIGNED', pk: true },
			{ name: 'program_id', type: 'int(10) UNSIGNED', fk: 'evaluation_programs.id' },
			{ name: 'day_sheet', type: 'varchar(100)', nullable: true, comment: 'NULL = overall' },
			{ name: 'category_name', type: 'varchar(255)' },
			{ name: 'average_score', type: 'decimal(7,4)' },
			{ name: 'result_label', type: 'varchar(50)' },
			{ name: 'is_overall', type: 'tinyint(1)', comment: '1 = cross-day overall row' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	column_averages: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(10) UNSIGNED', pk: true },
			{ name: 'program_id', type: 'int(10) UNSIGNED', fk: 'evaluation_programs.id' },
			{ name: 'day_sheet', type: 'varchar(100)', nullable: true },
			{ name: 'category_name', type: 'varchar(255)', nullable: true },
			{ name: 'col_index', type: 'int(11)', nullable: true, comment: 'Excel col index (0-based)' },
			{ name: 'question_header', type: 'text', nullable: true },
			{ name: 'average_score', type: 'decimal(7,4)', nullable: true },
			{ name: 'n_responses', type: 'int(10) UNSIGNED' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	respondents: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'program_id', type: 'int(11)', fk: 'evaluation_programs.id' },
			{ name: 'day_sheet', type: 'varchar(100)' },
			{ name: 'respondent_name', type: 'varchar(255)' },
			{ name: 'average_score', type: 'decimal(7,4)' },
			{ name: 'result_label', type: 'varchar(50)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	respondent_feedback: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'respondent_id', type: 'int(11)', fk: 'respondents.id' },
			{ name: 'feedback_key', type: 'varchar(255)' },
			{ name: 'feedback_value', type: 'text' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	respondent_scores: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'respondent_id', type: 'int(11)', fk: 'respondents.id' },
			{ name: 'question_header', type: 'text' },
			{ name: 'category_name', type: 'varchar(255)' },
			{ name: 'score', type: 'int(11)' },
		]
	},
	speaker_averages: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'program_id', type: 'int(11)', fk: 'evaluation_programs.id' },
			{ name: 'day_sheet', type: 'varchar(100)' },
			{ name: 'slot_number', type: 'int(11)' },
			{ name: 'speaker_name', type: 'varchar(255)' },
			{ name: 'overall_avg', type: 'decimal(7,4)' },
			{ name: 'result_label', type: 'varchar(50)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},
	speaker_criteria: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'speaker_avg_id', type: 'int(11)', fk: 'speaker_averages.id' },
			{ name: 'criterion_label', type: 'varchar(255)' },
			{ name: 'average_score', type: 'decimal(7,4)' },
		]
	},
	qame_super_categories: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'code', type: 'varchar(50)' },
			{ name: 'name', type: 'varchar(255)' },
			{ name: 'description', type: 'text' },
			{ name: 'icon', type: 'varchar(50)' },
			{ name: 'color', type: 'varchar(50)' },
			{ name: 'display_order', type: 'int(11)' },
			{ name: 'is_active', type: 'tinyint(1)' },
			{ name: 'created_at', type: 'timestamp' },
			{ name: 'updated_at', type: 'timestamp' },
		]
	},
	qame_category_mappings: {
		group: 'analytics',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'super_category_id', type: 'int(11)', fk: 'qame_super_categories.id' },
			{ name: 'category_id', type: 'int(11)', fk: 'evaluation_question_categories.id' },
			{ name: 'weight', type: 'decimal(5,2)' },
			{ name: 'created_at', type: 'timestamp' },
		]
	},

	// FILES
	program_files: {
		group: 'files',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'workshop_id', type: 'int(11)', fk: 'workshops.id' },
			{ name: 'file_name', type: 'varchar(255)' },
			{ name: 'file_type', type: 'varchar(50)' },
			{ name: 'day_session', type: 'varchar(100)' },
			{ name: 'description', type: 'text' },
			{ name: 'file_size', type: 'bigint(20)' },
			{ name: 'stored_name', type: 'varchar(255)' },
			{ name: 'uploaded_by', type: 'int(11)' },
			{ name: 'uploaded_at', type: 'timestamp' },
		]
	},
	user_files: {
		group: 'files',
		columns: [
			{ name: 'id', type: 'int(11)', pk: true },
			{ name: 'user_id', type: 'int(11)', fk: 'users.id' },
			{ name: 'file_name', type: 'varchar(255)' },
			{ name: 'stored_name', type: 'varchar(255)' },
			{ name: 'file_size', type: 'bigint(20)' },
			{ name: 'file_path', type: 'varchar(500)' },
			{ name: 'uploaded_at', type: 'timestamp' },
			{ name: 'location', type: 'varchar(255)' },
			{ name: 'item_no', type: 'varchar(50)' },
			{ name: 'headings', type: 'text' },
			{ name: 'unit', type: 'varchar(100)' },
			{ name: 'nature_of_event', type: 'varchar(255)' },
			{ name: 'status', type: "enum('pending','processing','completed','error')" },
			{ name: 'qame_report', type: 'varchar(500)' },
			{ name: 'computation_files', type: 'text' },
			{ name: 'files', type: 'text' },
		]
	},
};

// Foreign key relations: { from: 'table.col', to: 'table.col', onDelete: 'CASCADE|SET NULL' }
const RELATIONS = [
	{ from: 'category_averages.program_id', to: 'evaluation_programs.id', onDelete: 'CASCADE' },
	{ from: 'column_averages.program_id', to: 'evaluation_programs.id', onDelete: 'CASCADE' },
	{ from: 'email_verification_codes.user_id', to: 'users.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_answers.submission_id', to: 'evaluation_submissions.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_answers.question_id', to: 'evaluation_questions.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_speaker_answers.submission_id', to: 'evaluation_submissions.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_speaker_answers.resource_speaker_id', to: 'resource_speakers.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_speaker_answers.question_id', to: 'evaluation_questions.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_submissions.workshop_day_id', to: 'workshop_days.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_submissions.participant_id', to: 'workshop_participants.id', onDelete: 'CASCADE' },
	{ from: 'login_sessions.user_id', to: 'users.id', onDelete: 'CASCADE' },
	{ from: 'password_reset_tokens.user_id', to: 'users.id', onDelete: 'CASCADE' },
	{ from: 'qame_category_mappings.super_category_id', to: 'qame_super_categories.id', onDelete: 'CASCADE' },
	{ from: 'qame_category_mappings.category_id', to: 'evaluation_question_categories.id', onDelete: 'CASCADE' },
	{ from: 'resource_speakers.workshop_day_id', to: 'workshop_days.id', onDelete: 'CASCADE' },
	{ from: 'respondents.program_id', to: 'evaluation_programs.id', onDelete: 'CASCADE' },
	{ from: 'respondent_feedback.respondent_id', to: 'respondents.id', onDelete: 'CASCADE' },
	{ from: 'respondent_scores.respondent_id', to: 'respondents.id', onDelete: 'CASCADE' },
	{ from: 'speaker_averages.program_id', to: 'evaluation_programs.id', onDelete: 'CASCADE' },
	{ from: 'speaker_criteria.speaker_avg_id', to: 'speaker_averages.id', onDelete: 'CASCADE' },
	{ from: 'user_files.user_id', to: 'users.id', onDelete: 'CASCADE' },
	{ from: 'workshops.created_by', to: 'users.id', onDelete: 'SET NULL' },
	{ from: 'workshop_days.workshop_id', to: 'workshops.id', onDelete: 'CASCADE' },
	{ from: 'workshop_participants.workshop_id', to: 'workshops.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_questions.category_id', to: 'evaluation_question_categories.id', onDelete: 'CASCADE' },
	{ from: 'evaluation_questions.workshop_id', to: 'workshops.id', onDelete: 'CASCADE' },
	{ from: 'program_files.workshop_id', to: 'workshops.id', onDelete: 'CASCADE' },
];