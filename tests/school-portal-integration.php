<?php
/**
 * Run: php tests/school-portal-integration.php
 * Copies schema only into a random temporary database. All HTTP requests use
 * copied endpoints, a test-only database connector, and a fake email sender.
 * No real accounts, schools, sessions, or email deliveries are changed.
 */
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require dirname(__DIR__) . '/config/database.php';
ini_set('display_errors', '1');

$root = dirname(__DIR__);
$adminDb = getDB();
$testName = 'qatalyst_portal_test_' . bin2hex(random_bytes(6));
$runtime = __DIR__ . '/.runtime/' . $testName;
$process = null;
$testDb = null;
$created = false;
$passed = 0;

function check(bool $ok, string $label): void {
    global $passed;
    if (!$ok) throw new RuntimeException('FAIL: ' . $label);
    $passed++;
    echo 'PASS: ' . $label . PHP_EOL;
}
function request(string $path, string $method = 'GET', ?array $body = null, string $cookies = '', array $extraHeaders = []): array {
    global $base;
    $headers = ['Content-Type: application/json', 'Cookie: ' . $cookies, ...$extraHeaders];
    $context = stream_context_create(['http' => [
        'method' => $method, 'header' => implode("\r\n", $headers),
        'content' => $body === null ? '' : json_encode($body), 'ignore_errors' => true, 'timeout' => 20,
    ]]);
    $raw = file_get_contents($base . '/api/' . $path, false, $context);
    $responseHeaders = $http_response_header ?? [];
    preg_match('/\s(\d{3})\s/', $responseHeaders[0] ?? '', $match);
    $json = json_decode($raw ?: '', true);
    if (!is_array($json)) throw new RuntimeException('Invalid response from ' . $path . ': ' . substr($raw ?: '', 0, 600));
    return ['status' => (int)($match[1] ?? 0), 'json' => $json, 'headers' => $responseHeaders];
}
function expectStatus(array $response, int $status, string $label): void {
    check($response['status'] === $status, $label . ' (HTTP ' . $response['status'] . ': ' . ($response['json']['message'] ?? '') . ')');
}
function schoolCookie(array $response): string {
    foreach ($response['headers'] as $header) {
        if (preg_match('/^Set-Cookie: (school_session_token=[^;]+)/i', $header, $match)) return $match[1];
    }
    throw new RuntimeException('School cookie missing.');
}
function scalar(string $sql, array $params = []) {
    global $testDb;
    $stmt = $testDb->prepare($sql);
    $stmt->execute($params);
    return $stmt->fetchColumn();
}
function removeRuntime(string $path, string $expectedRoot): void {
    $real = realpath($path);
    $parent = realpath($expectedRoot);
    if (!$real || !$parent || !str_starts_with(strtolower($real), strtolower($parent) . DIRECTORY_SEPARATOR)) throw new RuntimeException('Unsafe test cleanup path.');
    $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($real, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($iterator as $item) {
        if ($item->isDir()) rmdir($item->getPathname()); else unlink($item->getPathname());
    }
    rmdir($real);
}

try {
    $adminDb->exec("CREATE DATABASE `$testName` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
    $created = true;
    $testDb = new PDO(sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', DB_HOST, DB_PORT, $testName), DB_USER, DB_PASS, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
    $testDb->exec("SET time_zone = '+08:00'");
    foreach (['users', 'public_schools', 'private_schools', 'districts', 'login_sessions', 'login_attempts', 'email_verification_codes', 'school_submissions', 'school_calendar_documents', 'user_roles'] as $table) {
        $testDb->exec("CREATE TABLE `$table` LIKE `" . str_replace('`', '``', DB_NAME) . "`.`$table`");
    }
    $testDb->exec("INSERT INTO districts (id, name) VALUES (1, 'DISTRICT 1'), (2, 'DISTRICT 2')");
    $testDb->exec("INSERT INTO public_schools (id, name, position, school_name, school_id, district, district_id, active) VALUES (1, 'Old Head', 'Principal I', 'Public Test School', '123456', 'DISTRICT 1', 1, 1)");
    $testDb->exec("INSERT INTO private_schools (id, name, school_id_no, levels, active) VALUES (1, 'Private Test School', '654321', '[\"elem\"]', 1), (777, 'Unrelated Private School', '777777', '[\"elem\"]', 1)");
    $hash = password_hash('FixturePassword!42', PASSWORD_BCRYPT);
    $stmt = $testDb->prepare('INSERT INTO users (id, email, password, full_name, status, email_verified, role, account_type, permissions, school_type, school_id, private_school_id, district_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    $stmt->execute([1, 'sdo@example.test', $hash, 'SDO Fixture', 'active', 1, 'admin', 'sdo_personnel', '[]', null, null, null, null]);
    $stmt->execute([2, 'public@example.test', $hash, 'Public User', 'active', 1, 'teacher', 'portal_user', '["dashboard","school_profile_edit"]', 'public', 1, null, 1]);
    $stmt->execute([3, 'other@example.test', $hash, 'Other Public User', 'active', 1, 'teacher', 'portal_user', '["dashboard"]', 'public', 1, null, 1]);
    $stmt->execute([4, 'orphan@example.test', $hash, 'Orphan Fixture', 'active', 1, 'admin', 'portal_user', '["dashboard","school_profile_edit","directory","users"]', 'public', 777, null, 1]);
    foreach ([1 => 'sdo-fixture', 2 => 'public-fixture', 3 => 'pending-fixture', 4 => 'orphan-fixture'] as $id => $token) {
        $testDb->prepare('INSERT INTO login_sessions (user_id, session_token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))')->execute([$id, $token]);
    }
    $testDb->exec("INSERT INTO school_submissions (id, user_id, school_id, district_id, type, title, file_name, file_path) VALUES (1, 2, 1, 1, 'calendar', 'Old Submission Title', 'fixture.pdf', 'fixture.pdf')");

    foreach (['api', 'config', 'helpers', 'models'] as $folder) mkdir($runtime . '/' . $folder, 0700, true);
    foreach (['config/security.php', 'config/auth_middleware.php', 'config/school_portal.php', 'config/audit_log.php', 'helpers/SchoolVerification.php', 'helpers/FileEncryption.php', 'models/User.php', 'api/Response.php'] as $file) copy($root . '/' . $file, $runtime . '/' . $file);
    foreach (glob($root . '/api/*.php') as $file) copy($file, $runtime . '/api/' . basename($file));
    file_put_contents($runtime . '/config/database.php', <<<'PHP'
<?php
date_default_timezone_set('Asia/Manila');
function getDB(): PDO {
    static $db;
    if (!$db) {
        $db = new PDO(getenv('QATALYST_TEST_DSN'), getenv('QATALYST_TEST_USER'), getenv('QATALYST_TEST_PASSWORD'), [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC, PDO::ATTR_EMULATE_PREPARES => false]);
        $db->exec("SET time_zone = '+08:00'");
    }
    return $db;
}
PHP);
    file_put_contents($runtime . '/helpers/EmailHelper.php', <<<'PHP'
<?php
class EmailHelper {
    public function sendVerificationCode(...$args): bool { return true; }
}
PHP);
    $socket = stream_socket_server('tcp://127.0.0.1:0', $error, $errorMessage);
    if (!$socket) throw new RuntimeException('Cannot reserve a test server port.');
    $address = stream_socket_get_name($socket, false);
    fclose($socket);
    $base = 'http://' . $address;
    $env = getenv();
    $env['QATALYST_TEST_DSN'] = sprintf('mysql:host=%s;port=%s;dbname=%s;charset=utf8mb4', DB_HOST, DB_PORT, $testName);
    $env['QATALYST_TEST_USER'] = DB_USER;
    $env['QATALYST_TEST_PASSWORD'] = DB_PASS;
    $process = proc_open([PHP_BINARY, '-S', $address, '-t', $runtime], [0 => ['pipe', 'r'], 1 => ['file', $runtime . '/server.log', 'a'], 2 => ['file', $runtime . '/server.log', 'a']], $pipes, $runtime, $env);
    if (!is_resource($process)) throw new RuntimeException('Cannot start the isolated HTTP test server.');
    fclose($pipes[0]);
    for ($attempt = 0; $attempt < 50; $attempt++) {
        $connection = @stream_socket_client('tcp://' . $address, $error, $errorMessage, 0.1);
        if ($connection) { fclose($connection); break; }
        usleep(100000);
    }
    $sdo = 'session_token=sdo-fixture';
    $public = 'school_session_token=public-fixture';
    $pending = 'school_session_token=pending-fixture';
    $orphan = 'school_session_token=orphan-fixture';
    $registration = ['first_name' => 'Private', 'last_name' => 'Fixture', 'email' => 'new@example.test', 'password' => 'FixturePassword!42', 'role' => 'admin', 'school_type' => 'private', 'school_id' => 1, 'school' => 'Tampered Name', 'grade' => '["shs"]'];

    expectStatus(request('school-portal-register.php', 'POST', [...$registration, 'school_id' => null]), 422, 'Custom school registration is rejected');
    expectStatus(request('school-portal-register.php', 'POST', [...$registration, 'school_type' => 'public', 'district_id' => 2]), 422, 'Wrong district registration is rejected');
    expectStatus(request('school-portal-register.php', 'POST', [...$registration, 'email' => ['invalid']]), 422, 'Malformed registration returns validation error');
    $res = request('school-portal-register.php', 'POST', $registration);
    expectStatus($res, 200, 'Private registration succeeds');
    $newId = (int)$res['json']['data']['user_id'];
    check(scalar('SELECT role FROM users WHERE id = ?', [$newId]) === 'teacher', 'Requested admin role cannot grant admin privileges');
    check(scalar('SELECT permissions FROM users WHERE id = ?', [$newId]) === '["dashboard"]', 'New school accounts require SDO approval');
    check(scalar('SELECT levels FROM private_schools WHERE id = 1') === '["elem"]', 'Registration cannot overwrite school levels');
    $token = $res['json']['data']['verify_token'];
    $testDb->prepare('INSERT INTO login_sessions (user_id, session_token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))')->execute([$newId, 'unverified-fixture']);
    expectStatus(request('school-portal-dashboard.php', 'GET', null, 'school_session_token=unverified-fixture'), 401, 'Old sessions cannot bypass email verification');
    expectStatus(request('user_management.php?action=approve_school&id=' . $newId, 'POST', ['approved' => true], $sdo), 422, 'SDO cannot approve an unverified account');

    $testDb->prepare('UPDATE users SET verify_token_expires = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?')->execute([$newId]);
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $token, 'action' => 'resend']), 410, 'Expired verification directs the user to sign in again');
    $res = request('school-login.php', 'POST', ['email' => 'new@example.test', 'password' => 'FixturePassword!42']);
    expectStatus($res, 200, 'Unverified login renews the verification challenge');
    check(!$res['json']['data']['email_verified'], 'Unverified login remains unverified');
    check((int)scalar('SELECT COUNT(*) FROM login_sessions WHERE user_id = ?', [$newId]) === 1, 'Unverified login does not create a full session');
    $token = $res['json']['data']['verify_token'];
    $code = scalar('SELECT code FROM email_verification_codes WHERE user_id = ? AND is_used = 0 ORDER BY id DESC LIMIT 1', [$newId]);
    $wrong = $code === '111111' ? '222222' : '111111';
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $token, 'code' => $wrong]), 401, 'Wrong verification code is rejected');
    check((int)scalar('SELECT attempts FROM email_verification_codes WHERE user_id = ? AND is_used = 0', [$newId]) === 1, 'Incorrect verification attempts are persisted');
    $res = request('school-portal-verify.php', 'POST', ['token' => $token, 'code' => $code], $sdo);
    expectStatus($res, 200, 'Correct verification succeeds');
    $private = schoolCookie($res);
    check(!array_filter($res['headers'], fn($header) => preg_match('/^Set-Cookie: session_token=/i', $header)), 'Verification does not overwrite the SDO cookie');
    check($res['json']['data']['school_name'] === 'Private Test School' && (int)$res['json']['data']['private_school_id'] === 1, 'Verification returns the correct private school');
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $token, 'code' => $code]), 410, 'Verification challenge cannot be reused');
    $res = request('school-portal-dashboard.php', 'GET', null, $private);
    expectStatus($res, 200, 'Verified account can view its pending dashboard');
    check($res['json']['data']['user']['school_approved'] === false, 'Email verification does not approve school affiliation');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['name' => 'Unauthorized Rename'], $private), 403, 'Pending account cannot change shared school records');
    expectStatus(request('school-portal-submissions.php', 'GET', null, $private), 403, 'Pending account cannot view school submissions');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['school_id_no' => 'EMP-NEW'], $private), 200, 'Pending account can save its personal staff number');
    expectStatus(request('private_schools.php', 'GET', null, $private), 401, 'School cookie cannot authenticate to SDO directory');
    expectStatus(request('main-settings.php', 'GET', null, $private), 401, 'School cookie cannot authenticate to SDO settings');
    expectStatus(request('main-settings.php', 'GET', null, $sdo), 200, 'SDO settings accepts its own session');
    expectStatus(request('private_schools.php', 'GET', null, 'session_token=' . substr($private, strlen('school_session_token='))), 401, 'Renaming the school cookie cannot bypass account separation');
    expectStatus(request('public_schools.php', 'GET', null, $orphan, ['X-Portal: school']), 401, 'Spoofed portal hint and legacy admin role cannot access SDO');
    expectStatus(request('user_management.php?action=approve_school&id=' . $newId, 'POST', ['approved' => true], $private), 401, 'School user cannot approve their own affiliation');

    expectStatus(request('user_management.php?action=approve_school&id=' . $newId, 'POST', ['approved' => true], $sdo), 200, 'SDO can approve school affiliation');
    $res = request('school-portal-profile-update.php', 'POST', ['name' => 'Private Renamed', 'street_address' => 'Test Street', 'barangay' => 'Test Barangay', 'city' => 'Baliwag', 'levels' => ['elem', 'jhs'], 'elem_admin' => 'New Principal', 'elem_contact' => '09000000001', 'registrar_name' => 'Test Registrar', 'status' => ''], $private);
    expectStatus($res, 200, 'Approved private school settings save');
    $res = request('private_schools.php', 'GET', null, $sdo . '; ' . $private);
    expectStatus($res, 200, 'SDO remains accessible with both cookies present');
    $rows = array_column($res['json']['data'], null, 'id');
    check($rows[1]['name'] === 'Private Renamed' && $rows[1]['elem_admin'] === 'New Principal' && $rows[1]['street_address'] === 'Test Street', 'School changes reflect in the SDO private directory');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['position' => 'Wrong Table Field'], $private), 422, 'Wrong school-type fields are rejected rather than ignored');

    $beforeNumber = scalar('SELECT school_id_no FROM users WHERE id = ?', [$newId]);
    $testDb->exec("CREATE TRIGGER fixture_fail_school_save BEFORE UPDATE ON private_schools FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Fixture save failure'");
    expectStatus(request('school-portal-profile-update.php', 'POST', ['school_id_no' => 'SHOULD-ROLL-BACK', 'name' => 'Failing Rename'], $private), 500, 'School write failure is reported');
    check(scalar('SELECT school_id_no FROM users WHERE id = ?', [$newId]) === $beforeNumber, 'School failure rolls back the personal update too');
    $testDb->exec('DROP TRIGGER fixture_fail_school_save');

    $res = request('school-portal-profile-update.php', 'POST', ['name' => 'New School Head', 'position' => 'Principal II', 'school_id' => '999999', 'school_name' => 'Public Renamed', 'district_id' => '2', 'email' => 'head@example.test', 'birthdate' => '1980-01-01', 'first_day_station' => '2020-06-01'], $public);
    expectStatus($res, 200, 'Approved public school settings and DepEd ID save');
    check(scalar('SELECT school_id FROM public_schools WHERE id = 1') === '999999', 'DepEd ID is independent of the internal school row ID');
    check((int)scalar('SELECT district_id FROM public_schools WHERE id = 1') === 2 && scalar('SELECT district FROM public_schools WHERE id = 1') === 'DISTRICT 2', 'School district text and ID change together');
    check((int)scalar('SELECT COUNT(*) FROM users WHERE school_id = 1 AND school_type = \'public\' AND district_id = 2') === 2, 'All linked public users receive the current district ID');
    check((int)scalar('SELECT district_id FROM school_submissions WHERE id = 1') === 1, 'Historical submission district snapshots are preserved');
    check(scalar('SELECT full_name FROM users WHERE id = 2') === 'Public User', 'School head details do not overwrite account identity');
    $res = request('school-portal-dashboard.php', 'GET', null, $public . '; ' . $sdo);
    check($res['json']['data']['school']['district'] === 'DISTRICT 2' && $res['json']['data']['school']['name'] === 'Public Renamed', 'Portal reload reflects the new public school and district');
    $res = request('get-public-schools.php?district_id=1');
    check($res['json']['data'] === [], 'Empty district list never falls back to unrelated schools');
    $res = request('documents-submitted.php?scope=all', 'GET', null, $sdo);
    expectStatus($res, 200, 'SDO submissions list loads');
    $records = $res['json']['records'];
    check(($records[0]['school_name'] ?? '') === 'Public Renamed', 'SDO submissions display the current public school name');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['email' => 'not-an-email'], $public), 422, 'Invalid directory contact email is rejected');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['birthdate' => '2026-02-31'], $public), 422, 'Impossible directory date is rejected');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['name' => 'Do Not Touch Private'], $orphan), 403, 'Missing public link cannot fall back to private school with the same ID');
    check(scalar('SELECT name FROM private_schools WHERE id = 777') === 'Unrelated Private School', 'Opposite school table remains unchanged');
    expectStatus(request('user_management.php?action=approve_school&id=4', 'POST', ['approved' => true], $sdo), 422, 'SDO cannot approve an orphaned school link');
    expectStatus(request('user_management.php?action=approve_school&id=' . $newId, 'POST', ['approved' => false], $sdo), 200, 'SDO can revoke school access');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['name' => 'Revoked Edit'], $private), 403, 'Revocation takes effect on the existing session');

    $res = request('logout.php?portal=school', 'POST', [], $sdo . '; ' . $private);
    expectStatus($res, 200, 'School logout succeeds');
    check((int)scalar("SELECT COUNT(*) FROM login_sessions WHERE session_token = 'sdo-fixture'") === 1, 'School logout preserves the SDO session');
    check((int)scalar('SELECT COUNT(*) FROM login_sessions WHERE session_token = ?', [substr($private, strlen('school_session_token='))]) === 0, 'School logout revokes the school session');
    check(!array_filter($res['headers'], fn($header) => preg_match('/^Set-Cookie: session_token=/i', $header)), 'School logout preserves the SDO cookie');

    expectStatus(request('private_schools.php?ref=school-portal-dashboard', 'GET', null, 'session_token=orphan-fixture'), 401, 'Query text cannot switch SDO account boundaries');
    expectStatus(request('private_schools.php', 'GET', null, '', ['Authorization: Bearer orphan-fixture']), 401, 'Legacy portal admin bearer token cannot access SDO');
    $res = request('school-login.php', 'POST', ['email' => 'public@example.test', 'password' => 'FixturePassword!42'], $sdo);
    expectStatus($res, 200, 'Verified public school login succeeds');
    check($res['json']['data']['email_verified'] === true && schoolCookie($res) !== '', 'Verified login issues only a school session');
    $res = request('school-portal-register.php', 'POST', [...$registration, 'email' => 'public-new@example.test', 'school_type' => 'public', 'district_id' => 2]);
    expectStatus($res, 200, 'Public registration validates the current district');
    $publicNewId = (int)$res['json']['data']['user_id'];
    $publicToken = $res['json']['data']['verify_token'];
    $publicCode = scalar('SELECT code FROM email_verification_codes WHERE user_id = ? AND is_used = 0', [$publicNewId]);
    $res = request('school-portal-verify.php', 'POST', ['token' => $publicToken, 'code' => $publicCode], $public . '; ' . $sdo);
    expectStatus($res, 200, 'Public email verification succeeds with older cookies present');
    check($res['json']['data']['school_name'] === 'Public Renamed', 'Public verification returns school name rather than school head name');
    $publicNew = schoolCookie($res);
    $res = request('school-portal-dashboard.php', 'GET', null, $publicNew);
    check((int)$res['json']['data']['user']['id'] === $publicNewId && $res['json']['data']['school']['public_birthdate'] === null, 'Verification replaces old school identity and masks directory details until approval');

    $res = request('school-portal-register.php', 'POST', [...$registration, 'email' => 'attempts@example.test']);
    expectStatus($res, 200, 'Attempt-limit fixture registers');
    $attemptId = (int)$res['json']['data']['user_id'];
    $attemptToken = $res['json']['data']['verify_token'];
    $attemptCode = scalar('SELECT code FROM email_verification_codes WHERE user_id = ? AND is_used = 0', [$attemptId]);
    for ($try = 1; $try <= 5; $try++) {
        $res = request('school-portal-verify.php', 'POST', ['token' => $attemptToken, 'code' => $attemptCode === '111111' ? '222222' : '111111']);
        expectStatus($res, $try === 5 ? 429 : 401, 'Verification wrong-attempt limit ' . $try);
    }
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $attemptToken, 'code' => $attemptCode]), 410, 'Exhausted verification code cannot be used');
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $attemptToken, 'action' => 'resend']), 200, 'Resend replaces an exhausted code');
    check((int)scalar('SELECT TIMESTAMPDIFF(SECOND, NOW(), expires_at) FROM email_verification_codes WHERE user_id = ? AND is_used = 0', [$attemptId]) <= 600, 'Resent code lifetime matches the ten-minute UI');
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $attemptToken, 'action' => 'resend']), 200, 'Second resend succeeds within limit');
    expectStatus(request('school-portal-verify.php', 'POST', ['token' => $attemptToken, 'action' => 'resend']), 429, 'Resend limit prevents repeated email delivery');

    $res = request('public_schools.php', 'PUT', ['id' => 1, 'name' => 'SDO Updated Head', 'position' => 'Principal II', 'district' => 'DISTRICT 1', 'school_id' => '999999', 'school_name' => 'Public Renamed'], $sdo);
    expectStatus($res, 200, 'SDO directory edits synchronize school district too');
    check((int)scalar('SELECT COUNT(*) FROM users WHERE school_id = 1 AND school_type = \'public\' AND district_id = 1') === 3, 'SDO district change updates every current linked account');
    $testDb->exec('UPDATE public_schools SET active = 0 WHERE id = 1');
    expectStatus(request('school-portal-profile-update.php', 'POST', ['name' => 'Inactive Edit'], $public), 403, 'Inactive linked school blocks canonical edits');
    $testDb->exec('UPDATE public_schools SET active = 1 WHERE id = 1');

    echo PHP_EOL . $passed . ' checks passed. Real school data and email delivery were not changed.' . PHP_EOL;

    if (in_array('--browser', $argv, true)) {
        foreach (['js', 'css'] as $folder) {
            mkdir($runtime . '/' . $folder);
            foreach (glob($root . '/' . $folder . '/*') as $file) if (is_file($file)) copy($file, $runtime . '/' . $folder . '/' . basename($file));
        }
        foreach (glob($root . '/*.html') as $file) copy($file, $runtime . '/' . basename($file));
        echo 'BROWSER TEST URL: ' . $base . '/school-portal.html' . PHP_EOL;
        echo 'BROWSER TEST STOP FILE: ' . $runtime . '/stop' . PHP_EOL;
        flush();
        $deadline = time() + 1800;
        while (!file_exists($runtime . '/stop') && time() < $deadline) { clearstatcache(); usleep(200000); }
    }
} finally {
    if (is_resource($process)) { proc_terminate($process); proc_close($process); }
    $testDb = null;
    if ($created) {
        if (!preg_match('/^qatalyst_portal_test_[a-f0-9]{12}$/D', $testName) || $testName === DB_NAME) throw new RuntimeException('Unsafe test database cleanup.');
        $adminDb->exec("DROP DATABASE `$testName`");
    }
    if (is_dir($runtime)) removeRuntime($runtime, __DIR__ . '/.runtime');
}
