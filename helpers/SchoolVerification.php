<?php
require_once __DIR__ . '/EmailHelper.php';

/** Caller holds the user row lock, so concurrent resends cannot bypass the limit. */
function schoolCreateVerificationCode(PDO $pdo, int $userId): ?string {
    $stmt = $pdo->prepare('SELECT COUNT(*) FROM email_verification_codes WHERE user_id = ? AND created_at > DATE_SUB(NOW(), INTERVAL 10 MINUTE)');
    $stmt->execute([$userId]);
    if ((int)$stmt->fetchColumn() >= 3) return null;
    $code = (string)random_int(100000, 999999);
    $pdo->prepare('UPDATE email_verification_codes SET is_used = 1 WHERE user_id = ? AND is_used = 0')->execute([$userId]);
    $pdo->prepare('INSERT INTO email_verification_codes (user_id, code, is_used, attempts, expires_at) VALUES (?, ?, 0, 0, DATE_ADD(NOW(), INTERVAL 10 MINUTE))')->execute([$userId, $code]);
    return $code;
}

function schoolDeliverVerificationCode(array $user, ?string $code): bool {
    if ($code === null) return false;
    try {
        $sent = (new EmailHelper())->sendVerificationCode($user['email'], $code, explode(' ', trim($user['full_name']))[0]);
        if (!$sent) error_log('School verification email delivery failed for user #' . (int)$user['id']);
        return (bool)$sent;
    } catch (Throwable $e) {
        error_log('School verification email delivery failed for user #' . (int)$user['id']);
        return false;
    }
}

function schoolStartVerification(PDO $pdo, array $user): array {
    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare("SELECT id, email_verified FROM users WHERE id = ? AND account_type = 'portal_user' AND status = 'active' FOR UPDATE");
        $stmt->execute([(int)$user['id']]);
        $locked = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$locked || !empty($locked['email_verified'])) throw new RuntimeException('Verification state changed. Please sign in again.');
        $token = bin2hex(random_bytes(32));
        $pdo->prepare('UPDATE users SET verify_token = ?, verify_token_expires = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?')->execute([$token, (int)$user['id']]);
        $code = schoolCreateVerificationCode($pdo, (int)$user['id']);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }
    return ['verify_token' => $token, 'verification_email_sent' => schoolDeliverVerificationCode($user, $code)];
}
