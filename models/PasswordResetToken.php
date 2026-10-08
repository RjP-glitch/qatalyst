<?php
/**
 * Password Reset Token Model
 * FIXED: Timezone issue for Asia/Manila
 */

class PasswordResetToken {
    private $conn;
    private $table = 'password_reset_tokens';

    public function __construct($pdo) {
        $this->conn = $pdo;
        
        // Set timezone to Asia/Manila (Philippines)
        date_default_timezone_set('Asia/Manila');
        
        // Also set MySQL timezone to match
        try {
            $this->conn->exec("SET time_zone = '+08:00'");
        } catch (PDOException $e) {
        }
    }

    /**
     * Create a new reset token
     */
    public function createResetToken($user_id) {
        try {
            // Generate unique token
            $token = bin2hex(random_bytes(50));
            
            // Generate 6-digit code
            $code = str_pad(rand(0, 999999), 6, '0', STR_PAD_LEFT);
            
            // Set expiration (15 minutes from now) - using Asia/Manila timezone
            $expires_at = date('Y-m-d H:i:s', strtotime('+15 minutes'));
            
            // Delete any existing tokens for this user
            $delete_query = "DELETE FROM " . $this->table . " WHERE user_id = :user_id";
            $delete_stmt = $this->conn->prepare($delete_query);
            $delete_stmt->bindParam(':user_id', $user_id, PDO::PARAM_INT);
            $delete_stmt->execute();
            
            // Insert new token
            $query = "INSERT INTO " . $this->table . " 
                      (user_id, token, code, expires_at) 
                      VALUES (:user_id, :token, :code, :expires_at)";
            
            $stmt = $this->conn->prepare($query);
            
            if (!$stmt) {
                return null;
            }
            
            $stmt->bindParam(':user_id', $user_id, PDO::PARAM_INT);
            $stmt->bindParam(':token', $token, PDO::PARAM_STR);
            $stmt->bindParam(':code', $code, PDO::PARAM_STR);
            $stmt->bindParam(':expires_at', $expires_at, PDO::PARAM_STR);
            
            if ($stmt->execute()) {
                return [
                    'token' => $token,
                    'code' => $code,
                    'expires_at' => $expires_at
                ];
            }
            
            return null;
            
        } catch (PDOException $e) {
            return null;
        }
    }

    /**
     * Verify reset code
     */
    public function verifyResetCode($token, $code) {
        try {
            // Get current time in Asia/Manila timezone
            $current_time = date('Y-m-d H:i:s');
            
            $query = "SELECT * FROM " . $this->table . " 
                      WHERE token = :token 
                      AND code = :code 
                      AND is_used = 0 
                      AND expires_at > :current_time
                      LIMIT 1";
            
            $stmt = $this->conn->prepare($query);
            
            if (!$stmt) {
                return null;
            }
            
            $stmt->bindParam(':token', $token, PDO::PARAM_STR);
            $stmt->bindParam(':code', $code, PDO::PARAM_STR);
            $stmt->bindParam(':current_time', $current_time, PDO::PARAM_STR);
            
            $stmt->execute();
            
            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            
            if ($result) {
            }
            
            return $result ? $result : null;
            
        } catch (PDOException $e) {
            return null;
        }
    }

    /**
     * Mark token as used
     */
    public function markTokenAsUsed($token) {
        try {
            $query = "UPDATE " . $this->table . " 
                      SET is_used = 1 
                      WHERE token = :token";
            
            $stmt = $this->conn->prepare($query);
            
            if (!$stmt) {
                return false;
            }
            
            $stmt->bindParam(':token', $token, PDO::PARAM_STR);
            
            return $stmt->execute();
            
        } catch (PDOException $e) {
            return false;
        }
    }

    /**
     * Get token details
     */
    public function getTokenByToken($token) {
        try {
            $current_time = date('Y-m-d H:i:s');
            
            $query = "SELECT * FROM " . $this->table . " 
                      WHERE token = :token 
                      AND is_used = 0 
                      AND expires_at > :current_time
                      LIMIT 1";
            
            $stmt = $this->conn->prepare($query);
            
            if (!$stmt) {
                return null;
            }
            
            $stmt->bindParam(':token', $token, PDO::PARAM_STR);
            $stmt->bindParam(':current_time', $current_time, PDO::PARAM_STR);
            $stmt->execute();
            
            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            
            return $result ? $result : null;
            
        } catch (PDOException $e) {
            return null;
        }
    }

    /**
     * Delete expired tokens (cleanup)
     */
    public function deleteExpiredTokens() {
        try {
            $current_time = date('Y-m-d H:i:s');
            
            $query = "DELETE FROM " . $this->table . " 
                      WHERE expires_at < :current_time OR is_used = 1";
            
            $stmt = $this->conn->prepare($query);
            $stmt->bindParam(':current_time', $current_time, PDO::PARAM_STR);
            
            return $stmt->execute();
            
        } catch (PDOException $e) {
            return false;
        }
    }
}
?>