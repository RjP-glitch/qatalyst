<?php
/** School affiliation and explicit SDO approval, independent of SDO roles. */
const SCHOOL_ACCESS_PERMISSION = 'school_profile_edit';

function portalSchoolLink(array $user): ?array {
    $type = strtolower(trim((string)($user['school_type'] ?? '')));
    if (in_array($type, ['private', 'private school'], true)) {
        $table = 'private_schools';
        $id = (int)($user['private_school_id'] ?? 0);
    } elseif (in_array($type, ['public', 'public school'], true)) {
        $table = 'public_schools';
        $id = (int)($user['school_id'] ?? 0);
    } else {
        return null;
    }
    return $id > 0 ? ['table' => $table, 'id' => $id] : null;
}

function portalResolveSchool(PDO $pdo, array $user, bool $lock = false): ?array {
    $link = portalSchoolLink($user);
    if (!$link) return null;
    $stmt = $pdo->prepare('SELECT * FROM `' . $link['table'] . '` WHERE id = ? AND active = 1 LIMIT 1' . ($lock ? ' FOR UPDATE' : ''));
    $stmt->execute([$link['id']]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ? $link + ['row' => $row] : null;
}

function portalSchoolIsApproved(array $user): bool {
    if (($user['account_type'] ?? '') !== 'portal_user' || empty($user['email_verified'])) return false;
    $perms = is_array($user['permissions'] ?? null)
        ? $user['permissions'] : json_decode($user['permissions'] ?? '[]', true);
    return is_array($perms) && in_array(SCHOOL_ACCESS_PERMISSION, $perms, true);
}

function requireSchoolApproval(array $user): void {
    if (!portalSchoolIsApproved($user) || !portalResolveSchool(getDB(), $user)) {
        http_response_code(403);
        echo json_encode(['success' => false, 'message' => 'Your school access must be approved by SDO before using this feature. Please contact SDO.']);
        exit;
    }
}

/** Resolve a district ID or a legacy district name to the canonical pair. */
function portalResolveDistrict(PDO $pdo, $id, string $name = ''): ?array {
    if ($id === '' || $id === 0 || $id === '0') return ['id' => null, 'name' => null];
    if ($id !== null) {
        if (filter_var($id, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]) === false) return null;
        $stmt = $pdo->prepare('SELECT id, name FROM districts WHERE id = ? LIMIT 1');
        $stmt->execute([(int)$id]);
    } elseif ($name !== '') {
        $stmt = $pdo->prepare('SELECT id, name FROM districts WHERE name = ? LIMIT 1');
        $stmt->execute([$name]);
    } else {
        return ['id' => null, 'name' => null];
    }
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}
