<?php
/**
 * api.php — evaluation_db Schema API
 * Connects to your MySQL/MariaDB database and returns live schema info.
 *
 * USAGE (place on your PHP server and point to your DB):
 *   GET api.php?action=tables          → list all tables
 *   GET api.php?action=columns&table=X → columns for table X
 *   GET api.php?action=relations       → all foreign key relations
 *   GET api.php?action=schema          → full schema dump (tables + relations)
 *   GET api.php?action=count&table=X   → row count for table X
 *
 * Update the DB config below before deploying.
 */

// ============================================================
// CONFIG — update these values
// ============================================================
define('DB_HOST', 'localhost');
define('DB_PORT', '3306');
define('DB_NAME', 'evaluation_db');
define('DB_USER', 'root');         // ← your DB username
define('DB_PASS', '');             // ← your DB password
define('DB_CHARSET', 'utf8mb4');

// SECURITY: Secure CORS configuration
require_once dirname(__DIR__) . '/config/security.php';
setCorsHeaders();
setSecurityHeaders();
handlePreflight();

header('Content-Type: application/json; charset=utf-8');

// ============================================================
// DB CONNECTION
// ============================================================
function getConnection(): PDO {
    $dsn = sprintf(
        'mysql:host=%s;port=%s;dbname=%s;charset=%s',
        DB_HOST, DB_PORT, DB_NAME, DB_CHARSET
    );
    try {
        $pdo = new PDO($dsn, DB_USER, DB_PASS, [
            PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        return $pdo;
    } catch (PDOException $e) {
        http_response_code(500);
        echo json_encode(['error' => 'DB connection failed: ' . $e->getMessage()]);
        exit;
    }
}

// ============================================================
// HELPERS
// ============================================================

/** Return all table names in the database */
function getTables(PDO $pdo): array {
    $stmt = $pdo->query("SHOW TABLES");
    return array_map(fn($r) => array_values($r)[0], $stmt->fetchAll());
}

/** Return column definitions for a given table */
function getColumns(PDO $pdo, string $table): array {
    $stmt = $pdo->prepare("SHOW FULL COLUMNS FROM `$table`");
    $stmt->execute();
    $rows = $stmt->fetchAll();
    return array_map(function($r) {
        return [
            'name'      => $r['Field'],
            'type'      => $r['Type'],
            'nullable'  => $r['Null'] === 'YES',
            'key'       => $r['Key'],   // PRI, MUL, UNI
            'default'   => $r['Default'],
            'extra'     => $r['Extra'],
            'comment'   => $r['Comment'],
        ];
    }, $rows);
}

/** Return all foreign key relations in the database */
function getRelations(PDO $pdo): array {
    $sql = "
        SELECT
            kcu.TABLE_NAME          AS from_table,
            kcu.COLUMN_NAME         AS from_col,
            kcu.REFERENCED_TABLE_NAME  AS to_table,
            kcu.REFERENCED_COLUMN_NAME AS to_col,
            rc.DELETE_RULE          AS on_delete,
            rc.UPDATE_RULE          AS on_update,
            kcu.CONSTRAINT_NAME     AS constraint_name
        FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
        JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
            ON rc.CONSTRAINT_NAME   = kcu.CONSTRAINT_NAME
            AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
        WHERE kcu.TABLE_SCHEMA = :db
            AND kcu.REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY kcu.TABLE_NAME, kcu.COLUMN_NAME
    ";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':db' => DB_NAME]);
    return $stmt->fetchAll();
}

/** Row count for a table */
function getRowCount(PDO $pdo, string $table): int {
    $stmt = $pdo->prepare("SELECT COUNT(*) FROM `$table`");
    $stmt->execute();
    return (int)$stmt->fetchColumn();
}

/** Full schema: tables with columns, row counts, and relations */
function getFullSchema(PDO $pdo): array {
    $tables = getTables($pdo);
    $relations = getRelations($pdo);
    $schema = [];

    foreach ($tables as $tname) {
        $schema[$tname] = [
            'columns'   => getColumns($pdo, $tname),
            'row_count' => getRowCount($pdo, $tname),
        ];
    }

    return [
        'database'  => DB_NAME,
        'tables'    => $schema,
        'relations' => $relations,
        'generated' => date('c'),
    ];
}

// ============================================================
// ROUTER
// ============================================================
$action = $_GET['action'] ?? 'schema';
$table  = isset($_GET['table']) ? preg_replace('/[^a-zA-Z0-9_]/', '', $_GET['table']) : null;

$pdo = getConnection();

switch ($action) {
    case 'tables':
        echo json_encode(['tables' => getTables($pdo)]);
        break;

    case 'columns':
        if (!$table) { http_response_code(400); echo json_encode(['error' => 'Missing table param']); break; }
        echo json_encode(['table' => $table, 'columns' => getColumns($pdo, $table)]);
        break;

    case 'relations':
        echo json_encode(['relations' => getRelations($pdo)]);
        break;

    case 'count':
        if (!$table) { http_response_code(400); echo json_encode(['error' => 'Missing table param']); break; }
        echo json_encode(['table' => $table, 'count' => getRowCount($pdo, $table)]);
        break;

    case 'schema':
    default:
        echo json_encode(getFullSchema($pdo), JSON_PRETTY_PRINT);
        break;
}
?>