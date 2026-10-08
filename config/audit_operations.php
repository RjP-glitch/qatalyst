<?php
/** Server-side operation journal. Reads never create activity; write outcomes are recorded at request completion. */
function auditSafeData($value, int $depth = 0) {
    if ($depth > 8) return '[nested data omitted]';
    if (is_array($value)) {
        $result = [];
        foreach ($value as $key => $item) {
            if (preg_match('/password|token|secret|session|encryption|api_key|verification_code|^code$/i', (string)$key)) continue;
            $result[$key] = auditSafeData($item, $depth + 1);
            if (count($result) >= 200) { $result['_truncated'] = true; break; }
        }
        return $result;
    }
    if (is_string($value)) {
        if (str_starts_with($value, 'data:') || strlen($value) > 16384) {
            return ['sha256' => hash('sha256', $value), 'bytes' => strlen($value)];
        }
        if (preg_match('/^[\[{]/', $value)) {
            $decoded = json_decode($value, true);
            if (is_array($decoded)) return auditSafeData($decoded, $depth + 1);
        }
    }
    return $value;
}

function auditSchoolSnapshot(PDO $pdo, array $row): array {
    $type = strtolower(trim((string)($row['school_type'] ?? '')));
    if (!in_array($type, ['public', 'private'], true)) {
        $type = !empty($row['private_school_id']) ? 'private' : (!empty($row['school_id']) ? 'public' : '');
    }
    $id = (int)($type === 'private' ? ($row['private_school_id'] ?? 0) : ($row['school_id'] ?? 0));
    if (!$id || !$type) return [];
    $table = $type === 'private' ? 'private_schools' : 'public_schools';
    $name = $type === 'private' ? 'name' : 'school_name';
    $stmt = $pdo->prepare("SELECT `$name` FROM `$table` WHERE id = ?");
    $stmt->execute([$id]);
    return ['id' => $id, 'type' => $type, 'name' => $stmt->fetchColumn() ?: ($row['school_name'] ?? null)];
}

function auditOperationTable(string $script, string $action): ?string {
    $tables = [
        'public_schools.php' => 'public_schools', 'private_schools.php' => 'private_schools',
        'directory.php' => 'personnel_directory', 'user_management.php' => 'users',
        'school-portal-profile-update.php' => 'users', 'update-school-logo.php' => 'users',
        'programs.php' => 'workshops', 'records_api.php' => 'evaluation_programs', 'save.php' => 'evaluation_programs',
        'responses.php' => 'respondents', 'delete-responses.php' => 'respondents',
        'documents-submitted.php' => 'school_submissions', 'school-portal-upload.php' => 'school_submissions',
        'school-portal-edit.php' => 'school_submissions', 'school-portal-delete.php' => 'school_submissions',
        'school-portal-submissions.php' => 'school_submissions', 'school-portal-permit.php' => 'school_submissions',
        'school-portal-calendar.php' => 'school_calendar_documents', 'school-portal-tuition.php' => 'school_tuition_documents',
        'announcements.php' => 'announcements', 'checklist-save.php' => 'checklist_results',
        'certificates_api.php' => 'workshop_participants', 'school-indorsements.php' => 'school_indorsements',
        'save-indorsement.php' => 'school_indorsements', 'school-tracker.php' => 'school_tracker_checklist',
        'main-settings.php' => null, 'settings_api.php' => null, 'questions.php' => 'evaluation_questions',
        'qame_categories.php' => 'qame_super_categories', 'evaluation_question_categories.php' => 'evaluation_question_categories',
        'column_configs.php' => 'column_configs', 'speaker_display_settings.php' => null,
        'sequence_manager_api.php' => 'evaluation_programs', 'compute_workshop.php' => 'workshops',
        'evaluation_monitoring.php' => 'workshops',
    ];
    $table = $tables[$script] ?? null;
    if ($script === 'main-settings.php') {
        if (str_contains($action, 'role')) $table = 'user_roles';
        elseif (str_contains($action, 'report_signator')) $table = 'report_signatories';
        elseif (str_contains($action, 'signator')) $table = 'school_signatories';
        elseif (str_contains($action, 'rating')) $table = 'rating_scales';
        elseif (str_contains($action, 'supporting')) $table = 'school_supporting_documents';
        elseif (str_contains($action, 'checklist')) $table = 'permit_checklist_items';
        elseif (str_contains($action, 'record') || str_contains($action, 'file')) $table = 'user_files';
        elseif (str_contains($action, 'profile') || str_contains($action, '2fa') || str_contains($action, 'revoke')) $table = 'users';
        elseif ($action === '' || in_array($action, ['post', 'put', 'patch'], true)) $table = 'users';
    }
    if (in_array($script, ['school-portal-calendar.php', 'school-portal-tuition.php'], true)) {
        if (str_contains($action, 'signator')) $table = 'school_signatories';
        elseif (str_contains($action, 'legend')) $table = 'calendar_legends';
        elseif (str_contains($action, 'supporting_upload') || str_contains($action, 'upload_supporting')) {
            $table = $script === 'school-portal-calendar.php' ? 'school_calendar_supporting_uploads' : 'school_tuition_supporting_uploads';
        }
    }
    if ($script === 'programs.php' && isset($_GET['manage_options'])) $table = 'workshop_dropdown_options';
    if ($script === 'programs.php' && isset($_GET['signatories'])) $table = 'report_signatories';
    if ($script === 'certificates_api.php' && (str_contains($action, 'file') || str_contains($action, 'upload'))) $table = 'program_files';
    return $table;
}

function auditOperationRow(PDO $pdo, ?string $table, $id, array $actor): array {
    if (!$table || !$id || !preg_match('/^\d+$/D', (string)$id)) return [];
    try {
        $stmt = $pdo->prepare("SELECT * FROM `$table` WHERE id = ? LIMIT 1");
        $stmt->execute([(int)$id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        if (($actor['account_type'] ?? '') === 'portal_user' && $row) {
            if ($table === 'users' && (int)$row['id'] !== (int)$actor['id']) return [];
            if (isset($row['user_id']) && (int)$row['user_id'] !== (int)$actor['id']) return [];
            if (isset($row['private_school_id']) && (int)$row['private_school_id'] !== (int)($actor['private_school_id'] ?? 0)) return [];
        }
        return $row;
    } catch (Throwable $e) { return []; }
}

function auditChanges(array $before, array $after): array {
    $before = auditSafeData($before);
    $after = auditSafeData($after);
    $changes = [];
    foreach (array_unique(array_merge(array_keys($before), array_keys($after))) as $key) {
        if (in_array($key, ['created_at', 'updated_at', 'last_login', 'history_json'], true)) continue;
        $old = $before[$key] ?? null;
        $new = $after[$key] ?? null;
        if ($old !== $new) $changes[$key] = ['before' => $old, 'after' => $new];
    }
    return $changes;
}

/** Keyed settings have no record ID; capture the configured values by their stable keys. */
function auditSettingsSnapshot(PDO $pdo, string $table, ?int $workshopId = null): array {
    if (!in_array($table, ['eval_settings', 'system_settings', 'speaker_display_settings'], true)) return [];
    try {
        if ($table === 'speaker_display_settings') {
            $stmt = $pdo->prepare('SELECT * FROM speaker_display_settings WHERE workshop_id <=> ? LIMIT 1');
            $stmt->execute([$workshopId]);
            return $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        }
        $stmt = $pdo->query("SELECT setting_key, setting_value FROM `$table`");
        return $stmt->fetchAll(PDO::FETCH_KEY_PAIR);
    } catch (Throwable $e) { return []; }
}

/** Replace a request snapshot with a row loaded under the operation's existing lock. */
function auditOperationBefore(string $table, array $row): void {
    if (!isset($GLOBALS['audit_operation_context'])) return;
    $GLOBALS['audit_operation_context']['before_rows'][$table . ':' . $row['id']] = ['table' => $table, 'id' => (int)$row['id'], 'row' => $row];
}

function auditTrackOperation(PDO $pdo, array $actor): void {
    if (isset($GLOBALS['audit_operation_context'])) return;
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if (!in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) return;
    $script = basename($_SERVER['SCRIPT_NAME'] ?? '');
    $allowed = ['public_schools.php', 'private_schools.php', 'directory.php', 'user_management.php',
        'school-portal-profile-update.php', 'update-school-logo.php', 'programs.php', 'records_api.php', 'save.php',
        'responses.php', 'delete-responses.php', 'documents-submitted.php', 'school-portal-upload.php',
        'school-portal-edit.php', 'school-portal-delete.php', 'school-portal-submissions.php', 'school-portal-permit.php',
        'school-portal-calendar.php', 'school-portal-tuition.php', 'announcements.php', 'checklist-save.php',
        'certificates_api.php', 'school-indorsements.php', 'save-indorsement.php', 'school-tracker.php',
        'main-settings.php', 'settings_api.php', 'questions.php', 'qame_categories.php', 'evaluation_question_categories.php',
        'column_configs.php', 'speaker_display_settings.php', 'sequence_manager_api.php', 'compute_workshop.php', 'evaluation_monitoring.php'];
    if (!in_array($script, $allowed, true)) return;
    try {
        auditEnsureTable($pdo);
        $body = json_decode(file_get_contents('php://input'), true);
        $body = is_array($body) ? $body : $_POST;
        $action = (string)($_GET['action'] ?? $body['action'] ?? strtolower($method));
        $action = substr(preg_replace('/[^a-zA-Z0-9_-]/', '', $action), 0, 48);
        $table = auditOperationTable($script, $action);
        $id = $_GET['id'] ?? $body['id'] ?? $body['document_id'] ?? $body['calendar_document_id'] ?? $body['submission_id'] ?? $body['record_id'] ?? $body['program_id'] ?? null;
        if ($script === 'school-portal-profile-update.php' || $script === 'update-school-logo.php' || ($script === 'main-settings.php' && $table === 'users')) $id = $actor['id'];
        $before = auditOperationRow($pdo, $table, $id, $actor);
        $school = auditSchoolSnapshot($pdo, $before ?: $actor);
        if (in_array($table, ['public_schools', 'private_schools'], true) && $before) {
            $school = ['id' => (int)$before['id'], 'type' => $table === 'public_schools' ? 'public' : 'private', 'name' => $before['school_name'] ?? $before['name']];
        }
        $beforeRows = [];
        if ($id && $table) $beforeRows[$table . ':' . $id] = ['table' => $table, 'id' => (int)$id, 'row' => $before];
        if ($table === 'school_submissions' && $before) {
            $linkedId = $before['tuition_document_id'] ?? $before['calendar_document_id'] ?? null;
            $linkedTable = ($before['type'] ?? '') === 'calendar' ? 'school_calendar_documents' : 'school_tuition_documents';
            if ($linkedId) $beforeRows[$linkedTable . ':' . $linkedId] = ['table' => $linkedTable, 'id' => (int)$linkedId, 'row' => auditOperationRow($pdo, $linkedTable, $linkedId, $actor)];
        }
        if ($script === 'certificates_api.php' && $table === 'workshop_participants') {
            if ($id) $beforeRows['respondents:' . $id] = ['table' => 'respondents', 'id' => (int)$id, 'row' => auditOperationRow($pdo, 'respondents', $id, $actor)];
        }
        if ($table && is_array($body['ids'] ?? null)) foreach (array_slice($body['ids'], 0, 50) as $bulkId) {
            if (!is_numeric($bulkId)) continue;
            $beforeRows[$table . ':' . $bulkId] = ['table' => $table, 'id' => (int)$bulkId, 'row' => auditOperationRow($pdo, $table, $bulkId, $actor)];
        }
        if ($script === 'school-portal-profile-update.php') {
            $link = portalResolveSchool($pdo, $actor);
            if ($link) $beforeRows[$link['table'] . ':' . $link['id']] = ['table' => $link['table'], 'id' => $link['id'], 'row' => $link['row']];
        }
        $settingsTable = $script === 'settings_api.php' ? 'eval_settings' :
            ($script === 'speaker_display_settings.php' ? 'speaker_display_settings' :
                ($script === 'main-settings.php' && $action === 'contact-info' ? 'system_settings' : null));
        $settingsWorkshop = isset($_GET['workshop_id']) ? (int)$_GET['workshop_id'] :
            (isset($body['workshop_id']) ? (int)$body['workshop_id'] : null);
        $GLOBALS['audit_operation_context'] = ['script' => $script, 'method' => $method, 'action' => $action,
            'entity_type' => $table, 'entity_id' => $id ? (string)$id : null, 'actor' => $actor,
            'target_user_id' => $table === 'users' ? ($id ? (int)$id : null) : ($before['user_id'] ?? null),
            'school' => $school, 'before_rows' => $beforeRows,
            'settings_table' => $settingsTable, 'settings_workshop' => $settingsWorkshop,
            'settings_before' => $settingsTable ? auditSettingsSnapshot($pdo, $settingsTable, $settingsWorkshop) : [],
            'requested_fields' => array_keys(auditSafeData($body)),
            'reference' => auditSafeData(array_intersect_key(array_merge($_GET, $body), array_flip(['batch_id', 'workshop_id', 'program_id', 'participant_ids', 'ids', 'title', 'status', 'reason', 'approved', 'page'])))];
        // Keep the normal response untouched while inspecting its success flag at shutdown.
        ob_start();
        ob_start();
        register_shutdown_function(static function () use ($pdo): void {
            try {
                $context = $GLOBALS['audit_operation_context'];
                $response = json_decode(ob_get_contents() ?: '', true);
                $http = http_response_code() ?: 200;
                $error = error_get_last();
                $fatal = $error && in_array($error['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true);
                $success = !$fatal && $http >= 200 && $http < 300 && is_array($response)
                    && ($response['success'] ?? !isset($response['error'])) !== false;
                if ($pdo->inTransaction()) {
                    // An unfinished operation is not a successful change; keep rollback and audit separate.
                    $pdo->rollBack();
                    $success = false;
                }
                $result = is_array($response['data'] ?? null) ? $response['data'] : [];
                $newId = $result['id'] ?? $result['document_id'] ?? $result['program_id'] ?? $response['id'] ?? $response['program_id'] ?? null;
                if (!$context['entity_id'] && $newId && $context['entity_type'] && is_numeric($newId)) {
                    $context['entity_id'] = (string)$newId;
                    $context['before_rows'][$context['entity_type'] . ':' . $newId] = ['table' => $context['entity_type'], 'id' => (int)$newId, 'row' => []];
                }
                if ($context['entity_type'] === 'users' && $context['entity_id']) $context['target_user_id'] = (int)$context['entity_id'];
                foreach (array_slice($result['submission_ids'] ?? [], 0, 50) as $submissionId) {
                    $context['before_rows']['school_submissions:' . $submissionId] = ['table' => 'school_submissions', 'id' => (int)$submissionId, 'row' => []];
                }
                $records = [];
                if ($success && $context['settings_table']) {
                    $changes = auditChanges($context['settings_before'], auditSettingsSnapshot($pdo, $context['settings_table'], $context['settings_workshop']));
                    if ($changes) $records[] = ['table' => $context['settings_table'], 'id' => $context['settings_workshop'] ?? 'global', 'changes' => $changes];
                }
                if ($success) foreach ($context['before_rows'] as $item) {
                    $after = auditOperationRow($pdo, $item['table'], $item['id'], $context['actor']);
                    $changes = auditChanges($item['row'], $after);
                    if ($changes) $records[] = ['table' => $item['table'], 'id' => $item['id'], 'changes' => $changes];
                    $subject = $after ?: $item['row'];
                    if (!$context['target_user_id'] && isset($subject['user_id'])) $context['target_user_id'] = (int)$subject['user_id'];
                    if (!$context['school']) $context['school'] = auditSchoolSnapshot($pdo, $subject);
                    if (in_array($item['table'], ['public_schools', 'private_schools'], true) && $subject) $context['school'] = [
                        'id' => $item['id'], 'type' => $item['table'] === 'public_schools' ? 'public' : 'private', 'name' => $item['row']['school_name'] ?? $item['row']['name'] ?? $subject['school_name'] ?? $subject['name']];
                }
                $labels = ['users' => 'account', 'public_schools' => 'public school', 'private_schools' => 'private school', 'school_submissions' => 'submission', 'school_calendar_documents' => 'calendar', 'school_tuition_documents' => 'tuition document', 'workshops' => 'program', 'evaluation_programs' => 'imported program'];
                $label = $context['entity_type'] ? ($labels[$context['entity_type']] ?? str_replace('_', ' ', $context['entity_type'])) . ($context['entity_id'] ? ' #' . $context['entity_id'] : '') : 'settings';
                $verb = ['post' => 'save', 'put' => 'update', 'patch' => 'update'][$context['action']] ?? str_replace('_', ' ', $context['action']);
                auditLog(['pdo' => $pdo, 'actor' => $context['actor'], 'user_id' => $context['actor']['id'], 'role' => $context['actor']['role'],
                    'action' => 'operation_' . $context['action'], 'module' => str_replace('.php', '', $context['script']),
                    'status' => $success ? 'success' : 'failed', 'description' => ($success ? 'Completed ' : 'Rejected or failed ') . $verb . ' on ' . $label,
                    'school' => $context['school'], 'target_user_id' => $context['target_user_id'], 'entity_type' => $context['entity_type'], 'entity_id' => $context['entity_id'],
                    'details' => ['endpoint' => $context['script'], 'method' => $context['method'], 'http_status' => $http,
                        'requested_fields' => $context['requested_fields'], 'records' => $records,
                        'reference' => $context['reference'],
                        'result' => auditSafeData(array_intersect_key(array_merge($result, is_array($response) ? $response : []), array_flip(['assigned', 'sent', 'failed', 'count', 'total']))),
                        'message' => $success ? null : substr((string)($response['message'] ?? 'Operation did not complete'), 0, 500)]]);
            } catch (Throwable $e) { error_log('Audit operation journal failed: ' . $e->getMessage()); }
        });
    } catch (Throwable $e) { error_log('Audit operation setup failed: ' . $e->getMessage()); }
}
