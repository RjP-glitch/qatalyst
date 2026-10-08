// migrate.php — run once to encrypt existing files
<?php
// WARNING: Run this once, keep the key safe, then DELETE this file!

$masterPassword = 'your-strong-migration-key'; // store this securely!
$files = $pdo->query("SELECT * FROM files")->fetchAll();

foreach ($files as $file) {
    $plaintext = file_get_contents($file['path']);
    
    $salt = random_bytes(16);
    $iv   = random_bytes(12);
    $key  = hash_pbkdf2("sha256", $masterPassword, $salt, 200000, 32, true);
    
    // Prepend magic + salt + iv
    $magic     = "\x56\x44\x52\x50"; // VDRP
    $encrypted = $magic . $salt . $iv . 
                 openssl_encrypt($plaintext, 'AES-256-GCM', $key, OPENSSL_RAW_DATA, $iv, $tag);
    
    file_put_contents($file['path'] . '.enc', $encrypted);
    
    // Update DB record
    $pdo->prepare("UPDATE files SET path=?, is_encrypted=1 WHERE id=?")
        ->execute([$file['path'] . '.enc', $file['id']]);
}
echo "Done!";