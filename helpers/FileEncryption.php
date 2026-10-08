<?php
/**
 * FileEncryption Helper - AES-256-GCM encryption for uploaded files
 * 
 * Uses a secure encryption key stored in environment or config.
 * Files are encrypted with a unique salt and IV for each file.
 */

class FileEncryption {
    // Magic bytes to identify encrypted files (VDRP = Valid Data Resource Protected)
    private const MAGIC_BYTES = "\x56\x44\x52\x50";
    private const CIPHER = 'AES-256-GCM';
    private const SALT_LENGTH = 16;
    private const IV_LENGTH = 12;
    private const TAG_LENGTH = 16;
    private const PBKDF2_ITERATIONS = 200000;
    
    private string $encryptionKey;
    
    /**
     * Initialize with encryption key from config or environment
     */
    public function __construct(?string $key = null) {
        // Priority: constructor param > environment variable > config constant > default
        if ($key !== null) {
            $this->encryptionKey = $key;
        } elseif (getenv('FILE_ENCRYPTION_KEY')) {
            $this->encryptionKey = getenv('FILE_ENCRYPTION_KEY');
        } elseif (defined('FILE_ENCRYPTION_KEY')) {
            $this->encryptionKey = FILE_ENCRYPTION_KEY;
        } else {
            throw new RuntimeException('FILE_ENCRYPTION_KEY is not set. Check your .env file.');
        }
    }
    
    /**
     * Encrypt file contents
     * 
     * @param string $plaintext Raw file contents
     * @return string Encrypted data with magic bytes, salt, IV, and auth tag
     */
    public function encrypt(string $plaintext): string {
        // Generate random salt and IV for this file
        $salt = random_bytes(self::SALT_LENGTH);
        $iv = random_bytes(self::IV_LENGTH);
        
        // Derive key from password using PBKDF2
        $key = hash_pbkdf2('sha256', $this->encryptionKey, $salt, self::PBKDF2_ITERATIONS, 32, true);
        
        // Encrypt with AES-256-GCM
        $tag = '';
        $ciphertext = openssl_encrypt(
            $plaintext,
            self::CIPHER,
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag
        );
        
        if ($ciphertext === false) {
            throw new Exception('Encryption failed: ' . openssl_error_string());
        }
        
        // Format: MAGIC(4) + SALT(16) + IV(12) + TAG(16) + CIPHERTEXT
        return self::MAGIC_BYTES . $salt . $iv . $tag . $ciphertext;
    }
    
    /**
     * Decrypt file contents
     * 
     * @param string $encrypted Encrypted data from encrypt()
     * @return string Decrypted file contents
     * @throws Exception If decryption fails or data is corrupted
     */
    public function decrypt(string $encrypted): string {
        // Verify minimum length
        $headerLength = strlen(self::MAGIC_BYTES) + self::SALT_LENGTH + self::IV_LENGTH + self::TAG_LENGTH;
        if (strlen($encrypted) < $headerLength) {
            throw new Exception('Invalid encrypted data: too short');
        }
        
        // Verify magic bytes
        $magic = substr($encrypted, 0, 4);
        if ($magic !== self::MAGIC_BYTES) {
            throw new Exception('Invalid encrypted data: missing magic bytes');
        }
        
        // Extract components
        $offset = 4;
        $salt = substr($encrypted, $offset, self::SALT_LENGTH);
        $offset += self::SALT_LENGTH;
        $iv = substr($encrypted, $offset, self::IV_LENGTH);
        $offset += self::IV_LENGTH;
        $tag = substr($encrypted, $offset, self::TAG_LENGTH);
        $offset += self::TAG_LENGTH;
        $ciphertext = substr($encrypted, $offset);
        
        // Derive key from password using PBKDF2
        $key = hash_pbkdf2('sha256', $this->encryptionKey, $salt, self::PBKDF2_ITERATIONS, 32, true);
        
        // Decrypt with AES-256-GCM
        $plaintext = openssl_decrypt(
            $ciphertext,
            self::CIPHER,
            $key,
            OPENSSL_RAW_DATA,
            $iv,
            $tag
        );
        
        if ($plaintext === false) {
            throw new Exception('Decryption failed: invalid key or corrupted data');
        }
        
        return $plaintext;
    }
    
    /**
     * Encrypt a file and save with .enc extension
     * 
     * @param string $sourcePath Path to source file
     * @param string|null $destPath Destination path (defaults to source.enc)
     * @return string Path to encrypted file
     */
    public function encryptFile(string $sourcePath, ?string $destPath = null): string {
        if (!file_exists($sourcePath)) {
            throw new Exception("Source file not found: $sourcePath");
        }
        
        $plaintext = file_get_contents($sourcePath);
        if ($plaintext === false) {
            throw new Exception("Failed to read source file: $sourcePath");
        }
        
        $encrypted = $this->encrypt($plaintext);
        
        $destPath = $destPath ?? $sourcePath . '.enc';
        
        if (file_put_contents($destPath, $encrypted) === false) {
            throw new Exception("Failed to write encrypted file: $destPath");
        }
        
        return $destPath;
    }
    
    /**
     * Decrypt a file
     * 
     * @param string $encryptedPath Path to encrypted file
     * @param string|null $destPath Destination path (if null, returns contents)
     * @return string Decrypted contents or destination path
     */
    public function decryptFile(string $encryptedPath, ?string $destPath = null): string {
        if (!file_exists($encryptedPath)) {
            throw new Exception("Encrypted file not found: $encryptedPath");
        }
        
        $encrypted = file_get_contents($encryptedPath);
        if ($encrypted === false) {
            throw new Exception("Failed to read encrypted file: $encryptedPath");
        }
        
        $plaintext = $this->decrypt($encrypted);
        
        if ($destPath !== null) {
            if (file_put_contents($destPath, $plaintext) === false) {
                throw new Exception("Failed to write decrypted file: $destPath");
            }
            return $destPath;
        }
        
        return $plaintext;
    }
    
    /**
     * Encrypt uploaded file directly from tmp_name
     * 
     * @param string $tmpPath Temporary upload path ($_FILES['file']['tmp_name'])
     * @param string $destPath Final destination path
     * @return bool Success status
     */
    public function encryptUploadedFile(string $tmpPath, string $destPath): bool {
        if (!is_uploaded_file($tmpPath)) {
            throw new Exception("Invalid uploaded file");
        }
        
        $plaintext = file_get_contents($tmpPath);
        if ($plaintext === false) {
            throw new Exception("Failed to read uploaded file");
        }
        
        $encrypted = $this->encrypt($plaintext);
        
        return file_put_contents($destPath, $encrypted) !== false;
    }
    
    /**
     * Check if a file is encrypted (has magic bytes)
     * 
     * @param string $filePath Path to file
     * @return bool True if file appears to be encrypted
     */
    public function isEncrypted(string $filePath): bool {
        if (!file_exists($filePath)) {
            return false;
        }
        
        $handle = fopen($filePath, 'rb');
        if (!$handle) {
            return false;
        }
        
        $magic = fread($handle, 4);
        fclose($handle);
        
        return $magic === self::MAGIC_BYTES;
    }
    
    /**
     * Get decrypted file contents for streaming/download
     * 
     * @param string $encryptedPath Path to encrypted file
     * @return string Decrypted file contents
     */
    public function getDecryptedContents(string $encryptedPath): string {
        return $this->decryptFile($encryptedPath);
    }
}
