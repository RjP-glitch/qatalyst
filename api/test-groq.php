<?php
$envPath = dirname(__DIR__) . '/.env';
echo 'ENV path: ' . $envPath . '<br>';
echo 'File exists: ' . (is_file($envPath) ? 'YES' : 'NO') . '<br>';

$lines = file($envPath, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
foreach ($lines as $line) {
    if (strpos($line, 'GROQ') !== false) {
        echo 'Found: ' . htmlspecialchars($line) . '<br>';
    }
}