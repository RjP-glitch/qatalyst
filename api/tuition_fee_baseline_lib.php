<?php
declare(strict_types=1);

/** Shared, immutable snapshots of accepted tuition schedules. */
function ensureTuitionFeeBaselineTable(PDO $pdo): void
{
    $pdo->exec("CREATE TABLE IF NOT EXISTS school_tuition_fee_baselines (
        id INT NOT NULL AUTO_INCREMENT,
        private_school_id INT NOT NULL,
        school_year VARCHAR(20) NOT NULL,
        source_document_id INT NOT NULL,
        payload_json LONGTEXT NOT NULL,
        captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tuition_baseline_school_year (private_school_id, school_year),
        KEY idx_tuition_baseline_source (source_document_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
}

function normalizeTuitionBaselineYear(string $year): string
{
    $year = preg_replace('/^S\.Y\.\s*/i', '', trim($year));
    $year = preg_replace('/^SY\s*/i', '', (string)$year);
    return preg_replace('/\s*[\x{2010}-\x{2015}\x{2212}-]\s*/u', '-', (string)$year);
}

function saveTuitionFeeBaseline(PDO $pdo, int $schoolId, int $documentId, string $schoolYear, array $payload): void
{
    if ($schoolId <= 0 || $documentId <= 0 || trim($schoolYear) === '') return;
    ensureTuitionFeeBaselineTable($pdo);
    $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if ($encoded === false) throw new RuntimeException('Could not encode accepted tuition baseline.');

    $stmt = $pdo->prepare("INSERT INTO school_tuition_fee_baselines
            (private_school_id, school_year, source_document_id, payload_json)
        VALUES (:school_id, :school_year, :document_id, :payload)
        ON DUPLICATE KEY UPDATE
            source_document_id = VALUES(source_document_id),
            payload_json = VALUES(payload_json),
            updated_at = NOW()");
    $stmt->execute([
        ':school_id' => $schoolId,
        ':school_year' => normalizeTuitionBaselineYear($schoolYear),
        ':document_id' => $documentId,
        ':payload' => $encoded,
    ]);
}

/** Return a stored snapshot, or seed it from an older approved submission. */
function getTuitionFeeBaseline(PDO $pdo, int $schoolId, string $schoolYear): ?array
{
    if ($schoolId <= 0 || trim($schoolYear) === '') return null;
    ensureTuitionFeeBaselineTable($pdo);
    $normalizedYear = normalizeTuitionBaselineYear($schoolYear);

    $stored = $pdo->prepare("SELECT source_document_id, school_year, payload_json
        FROM school_tuition_fee_baselines
        WHERE private_school_id = :school_id AND school_year = :school_year
        LIMIT 1");
    $stored->execute([':school_id' => $schoolId, ':school_year' => $normalizedYear]);
    $row = $stored->fetch(PDO::FETCH_ASSOC);
    if ($row) {
        $payload = json_decode((string)$row['payload_json'], true);
        if (is_array($payload)) {
            return [
                'source_document_id' => (int)$row['source_document_id'],
                'school_year' => (string)$row['school_year'],
                'payload' => $payload,
            ];
        }
    }

    // Backfill accepted schedules created before baseline snapshots existed.
    $accepted = $pdo->prepare("SELECT d.id, d.proposed_sy, d.payload_json
        FROM school_tuition_documents d
        INNER JOIN school_submissions ss
            ON ss.file_path = CONCAT('school_tuition_documents:', d.id)
           AND ss.type IN ('tuition', 'no_tuition')
        WHERE d.private_school_id = :school_id
          AND LOWER(TRIM(ss.status)) IN ('approved', 'released to school')
        ORDER BY ss.updated_at DESC, d.id DESC");
    $accepted->execute([':school_id' => $schoolId]);
    foreach ($accepted->fetchAll(PDO::FETCH_ASSOC) as $candidate) {
        if (normalizeTuitionBaselineYear((string)$candidate['proposed_sy']) !== $normalizedYear) continue;
        $payload = json_decode((string)$candidate['payload_json'], true);
        if (!is_array($payload)) continue;
        saveTuitionFeeBaseline($pdo, $schoolId, (int)$candidate['id'], $normalizedYear, $payload);
        return [
            'source_document_id' => (int)$candidate['id'],
            'school_year' => $normalizedYear,
            'payload' => $payload,
        ];
    }
    return null;
}

/** Convert shared/legacy fee fields into comparable per-grade amounts. */
function tuitionBaselineFeeMap(array $payload, string $suffix): array
{
    $map = [];
    foreach (['kinder', 'elem', 'jhs', 'shs'] as $level) {
        $section = is_array($payload[$level] ?? null) ? $payload[$level] : [];
        $levelMap = [];
        foreach ($section as $key => $value) {
            if (!str_ends_with((string)$key, $suffix)) continue;
            $field = substr((string)$key, 0, -strlen($suffix));
            if ($field === 'total' || str_ends_with($field, '_total')) continue;
            $levelMap[$field] = round((float)$value, 2);
        }

        $elemGradeFields = ['e1_tuition','e2_tuition','e3_tuition','e4_tuition','e5_tuition','e6_tuition'];
        $hasElemGradeAmount = false;
        foreach ($elemGradeFields as $field) {
            if (($levelMap[$field] ?? 0) > 0) { $hasElemGradeAmount = true; break; }
        }
        if ($level === 'elem' && array_key_exists('e_tuition', $levelMap)
            && !$hasElemGradeAmount && $levelMap['e_tuition'] > 0) {
            $shared = $levelMap['e_tuition'];
            unset($levelMap['e_tuition']);
            foreach (range(1, 6) as $grade) $levelMap['e' . $grade . '_tuition'] = $shared;
        }
        $jhsGradeFields = ['j7_tuition','j8_tuition','j9_tuition','j10_tuition'];
        $hasJhsGradeAmount = false;
        foreach ($jhsGradeFields as $field) {
            if (($levelMap[$field] ?? 0) > 0) { $hasJhsGradeAmount = true; break; }
        }
        if ($level === 'jhs' && array_key_exists('j_tuition', $levelMap)
            && !$hasJhsGradeAmount && $levelMap['j_tuition'] > 0) {
            $shared = $levelMap['j_tuition'];
            unset($levelMap['j_tuition']);
            foreach (range(7, 10) as $grade) $levelMap['j' . $grade . '_tuition'] = $shared;
        }
        if ($level === 'shs') {
            $hasPerGradeValues = false;
            foreach ($levelMap as $field => $amount) {
                if ((str_starts_with($field, 's11_') || str_starts_with($field, 's12_')) && $amount > 0) {
                    $hasPerGradeValues = true;
                    break;
                }
            }
            foreach ($levelMap as $field => $amount) {
                if (!preg_match('/^s_(.+)$/', $field, $match)) continue;
                $suffixName = $match[1];
                $g11 = 's11_' . $suffixName;
                $g12 = 's12_' . $suffixName;
                if ($hasPerGradeValues && !array_key_exists($g11, $levelMap) && !array_key_exists($g12, $levelMap)) {
                    $levelMap[$g11] = $amount;
                    $levelMap[$g12] = $amount;
                }
                if ($hasPerGradeValues) unset($levelMap[$field]);
            }
            if (!$hasPerGradeValues) {
                foreach (array_keys($levelMap) as $field) {
                    if (str_starts_with($field, 's11_') || str_starts_with($field, 's12_')) unset($levelMap[$field]);
                }
            }
        }
        $map[$level] = $levelMap;
    }
    return $map;
}

/** Return field keys whose submitted current values differ from the accepted baseline. */
function compareTuitionCurrentToBaseline(array $payload, array $baselinePayload): array
{
    $actual = tuitionBaselineFeeMap($payload, '_curr');
    $expected = tuitionBaselineFeeMap($baselinePayload, '_prop');
    $mismatches = [];
    foreach (['kinder', 'elem', 'jhs', 'shs'] as $level) {
        $keys = array_unique(array_merge(array_keys($actual[$level] ?? []), array_keys($expected[$level] ?? [])));
        foreach ($keys as $key) {
            $a = (float)($actual[$level][$key] ?? 0);
            $e = (float)($expected[$level][$key] ?? 0);
            if (abs($a - $e) > 0.01) $mismatches[] = $level . '.' . $key;
        }
    }
    return $mismatches;
}
