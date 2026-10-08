<?php
/**
 * User Model
 */
class User {
    private $conn;
    private $table = 'users';

    public $id;
    public $email;
    public $password;
    public $full_name;
    public $status;
    public $email_verified;
    public $created_at;

    public function __construct($pdo) {
        $this->conn = $pdo;
    }

    /**
     * Get user by email
     */
    public function getUserByEmail($email) {
        try {
            $query = "SELECT * FROM " . $this->table . " WHERE email = :email LIMIT 1";
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return null;
            }

            $stmt->bindParam(':email', $email, PDO::PARAM_STR);
            $stmt->execute();

            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            
            return $result ? $result : null;
            
        } catch (PDOException $e) {
            return null;
        }
    }

    /**
     * Get user by ID
     */
    public function getUserById($id) {
        try {
            $query = "SELECT * FROM " . $this->table . " WHERE id = :id LIMIT 1";
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return null;
            }

            $stmt->bindParam(':id', $id, PDO::PARAM_INT);
            $stmt->execute();

            $result = $stmt->fetch(PDO::FETCH_ASSOC);
            
            return $result ? $result : null;
            
        } catch (PDOException $e) {
            return null;
        }
    }

    /**
     * Update user
     */
    public function updateUser($id, $data) {
        try {
            $updates = [];
            $params = [':id' => $id];

            $allowed_fields = ['email', 'password', 'full_name', 'status', 'email_verified', 'profile_picture', 'two_factor_enabled', 'account_type'];

            foreach ($data as $key => $value) {
                if (in_array($key, $allowed_fields)) {
                    $updates[] = "$key = :$key";
                    $params[":$key"] = $value;
                }
            }

            if (empty($updates)) {
                return false;
            }

            $query = "UPDATE " . $this->table . " SET " . implode(", ", $updates) . " WHERE id = :id";
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return false;
            }

            return $stmt->execute($params);
            
        } catch (PDOException $e) {
            return false;
        }
    }

    /**
     * Check if email exists
     */
    public function emailExists($email) {
        try {
            $query = "SELECT id FROM " . $this->table . " WHERE email = :email LIMIT 1";
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return false;
            }

            $stmt->bindParam(':email', $email, PDO::PARAM_STR);
            $stmt->execute();

            return $stmt->fetch(PDO::FETCH_ASSOC) !== false;
            
        } catch (PDOException $e) {
            return false;
        }
    }

    /**
     * Create new user
     */
    public function createUser($data) {
        try {
            $query = "INSERT INTO " . $this->table . " 
                      (email, password, full_name, status, email_verified, account_type, created_at) 
                      VALUES (:email, :password, :full_name, :status, :email_verified, :account_type, :created_at)";
            
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return false;
            }

            // Hash password if not already hashed
            $hashed_password = isset($data['password']) && strlen($data['password']) < 60 
                ? password_hash($data['password'], PASSWORD_BCRYPT) 
                : $data['password'];

            $status = $data['status'] ?? 'active';
            $email_verified = $data['email_verified'] ?? 0;
            // Admin-created accounts are always SDO personnel.
            // Self-registered portal accounts pass 'portal_user' explicitly.
            $account_type = $data['account_type'] ?? 'sdo_personnel';
            $created_at = date('Y-m-d H:i:s');

            $stmt->bindParam(':email', $data['email'], PDO::PARAM_STR);
            $stmt->bindParam(':password', $hashed_password, PDO::PARAM_STR);
            $stmt->bindParam(':full_name', $data['full_name'], PDO::PARAM_STR);
            $stmt->bindParam(':status', $status, PDO::PARAM_STR);
            $stmt->bindParam(':email_verified', $email_verified, PDO::PARAM_INT);
            $stmt->bindParam(':account_type', $account_type, PDO::PARAM_STR);
            $stmt->bindParam(':created_at', $created_at, PDO::PARAM_STR);

            if ($stmt->execute()) {
                return $this->conn->lastInsertId();
            }

            return false;
            
        } catch (PDOException $e) {
            return false;
        }
    }

    /**
     * Verify user email
     */
    public function verifyEmail($user_id) {
        try {
            $query = "UPDATE " . $this->table . " SET email_verified = 1 WHERE id = :id";
            $stmt = $this->conn->prepare($query);

            if (!$stmt) {
                return false;
            }

            $stmt->bindParam(':id', $user_id, PDO::PARAM_INT);
            return $stmt->execute();
            
        } catch (PDOException $e) {
            return false;
        }
    }
}
?>