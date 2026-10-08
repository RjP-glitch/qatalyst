<?php
/**
 * Verification Code Model
 */

class VerificationCode {
    private $conn;
    private $table = 'email_verification_codes';

    public function __construct($pdo) {
        $this->conn = $pdo;
    }

    /**
     * Generate and save verification code
     */
    public function generateCode($user_id) {
        // Generate 6-digit code
        $code = str_pad(random_int(0, 999999), 6, '0', STR_PAD_LEFT);
        
        // Expires in 10 minutes
        $expires_at = date('Y-m-d H:i:s', strtotime('+10 minutes'));

        $query = "INSERT INTO " . $this->table . " (user_id, code, expires_at) VALUES (?, ?, ?)";
        $stmt = $this->conn->prepare($query);

        if (!$stmt) {
            return false;
        }

        $stmt->bind_param("iss", $user_id, $code, $expires_at);
        $stmt->execute();

        return $code;
    }

    /**
     * Verify code
     */
    public function verifyCode($user_id, $code) {
        $query = "SELECT id, is_used, expires_at FROM " . $this->table . " 
                  WHERE user_id = ? AND code = ? AND is_used = FALSE
                  ORDER BY created_at DESC LIMIT 1";
        
        $stmt = $this->conn->prepare($query);

        if (!$stmt) {
            return null;
        }

        $stmt->bind_param("is", $user_id, $code);
        $stmt->execute();
        $result = $stmt->get_result();

        if ($result->num_rows === 0) {
            return null;
        }

        $row = $result->fetch_assoc();

        // Check if code is expired
        if (strtotime($row['expires_at']) < time()) {
            return null;
        }

        return $row;
    }

    /**
     * Mark code as used
     */
    public function markAsUsed($code_id) {
        $query = "UPDATE " . $this->table . " SET is_used = TRUE WHERE id = ?";
        $stmt = $this->conn->prepare($query);

        if (!$stmt) {
            return false;
        }

        $stmt->bind_param("i", $code_id);
        return $stmt->execute();
    }
}
?>