<?php
ini_set('display_errors', 0);
error_reporting(E_ALL);
date_default_timezone_set('Asia/Manila');
// ─── Error log path ───────────────────────────────────────────────────────────
$logFile = __DIR__ . '/../logs/database-errors.log';
if (!is_dir(dirname($logFile))) {
    mkdir(dirname($logFile), 0755, true);
}
ini_set('error_log', $logFile);

// ─── Log helper ───────────────────────────────────────────────────────────────
function dbLog(string $msg, ?Throwable $e = null): void {
    global $logFile;
    $timestamp = date('Y-m-d H:i:s');
    $entry = "[$timestamp] $msg";
    if ($e) {
        $entry .= " | " . get_class($e) . ": " . $e->getMessage();
        $entry .= " | File: " . $e->getFile() . " Line: " . $e->getLine();
    }
    file_put_contents($logFile, $entry . PHP_EOL, FILE_APPEND);
}

// ─── Load .env ────────────────────────────────────────────────────────────────
try {
    $autoload = __DIR__ . '/../vendor/autoload.php';
    if (!file_exists($autoload)) {
        dbLog('vendor/autoload.php not found at: ' . $autoload);
        throw new RuntimeException('Autoload not found');
    }
    require_once $autoload;

    $envPath = __DIR__ . '/..';
    if (!file_exists($envPath . '/.env')) {
        dbLog('.env file not found at: ' . realpath($envPath));
        throw new RuntimeException('.env file missing');
    }

    $dotenv = Dotenv\Dotenv::createImmutable($envPath);
    $dotenv->load();
    // dbLog('.env loaded successfully');

} catch (Throwable $e) {
    dbLog('Failed to load .env', $e);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server configuration error']);
    exit;
}

// ─── Database configuration ───────────────────────────────────────────────────
define('DB_HOST', $_ENV['DB_HOST'] ?? 'localhost');
define('DB_NAME', $_ENV['DB_NAME'] ?? 'evaluation_db');
define('DB_USER', $_ENV['DB_USER'] ?? 'root');
define('DB_PASS', $_ENV['DB_PASS'] ?? '');
define('DB_PORT', $_ENV['DB_PORT'] ?? '3306');

// ─── File Encryption Key ──────────────────────────────────────────────────────
try {
    if (empty($_ENV['FILE_ENCRYPTION_KEY'])) {
        dbLog('FILE_ENCRYPTION_KEY is missing from .env');
        throw new RuntimeException('FILE_ENCRYPTION_KEY is not set in .env');
    }
    define('FILE_ENCRYPTION_KEY', $_ENV['FILE_ENCRYPTION_KEY']);
    // dbLog('FILE_ENCRYPTION_KEY loaded OK');
} catch (Throwable $e) {
    dbLog('Encryption key error', $e);
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => 'Server configuration error']);
    exit;
}

// ─── Connect ──────────────────────────────────────────────────────────────────
function getDB(): PDO {
    static $pdo = null;
    if ($pdo) return $pdo;
    try {
        $dsn = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4',
            DB_HOST, DB_PORT, DB_NAME);
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $pdo->exec("SET NAMES utf8mb4 COLLATE utf8mb4_general_ci; SET time_zone = '+08:00'");
        // dbLog('Database connected successfully');
    } catch (Throwable $e) {
        dbLog('Database connection failed', $e);
        http_response_code(500);
        echo json_encode(['success' => false, 'message' => 'Database connection error']);
        exit;
    }
    return $pdo;
}
?>
