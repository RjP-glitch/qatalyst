// Run: node tests/user-management-delete.test.cjs
// Exercise the real page handler with a fake server and DOM; no accounts are deleted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../js/user-management.js'), 'utf8');

function page(fetchResponse) {
    const calls = [];
    const context = vm.createContext({
        CONFIG: { API_URL: '/api' },
        URLSearchParams,
        window: { location: { search: '?tab=portal' }, addEventListener() {} },
        document: { addEventListener() {}, getElementById: () => ({ value: '42' }) },
        fetch: async (url, options) => {
            calls.push({ url, options });
            if (fetchResponse instanceof Error) throw fetchResponse;
            return { json: async () => fetchResponse };
        },
        NotificationSystem: { fetchNotifications: async () => calls.push('notifications') },
        record: (event) => calls.push(event),
    });
    vm.runInContext(source, context);
    vm.runInContext(`
        showToast = (message, type) => record({ message, type });
        closeDeleteModal = () => record('close');
        loadUsers = async () => record('users');
    `, context);
    return { calls, run: () => vm.runInContext('confirmDeleteUser()', context) };
}

(async () => {
    const success = page({ success: true });
    await success.run();
    const request = success.calls[0];
    assert.equal(request.url, '/api/user_management.php?action=delete&id=42');
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.credentials, 'include');
    assert.equal(request.options.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.options.body), {});
    assert.deepEqual(success.calls.slice(1).map(event => typeof event === 'string' ? event : `${event.type}: ${event.message}`),
        ['success: User deleted', 'close', 'users', 'notifications']);
    console.log('PASS: Delete sends valid JSON and refreshes users and notifications after success');

    const denied = page({ success: false, message: 'You cannot delete your own account' });
    await denied.run();
    assert.equal(denied.calls.length, 2);
    assert.equal(denied.calls[1].message, 'You cannot delete your own account');
    assert.equal(denied.calls[1].type, 'error');
    console.log('PASS: Server rejection stays visible and preserves the confirmation dialog');

    const unavailable = page(new Error('Connection failed'));
    await unavailable.run();
    assert.equal(unavailable.calls.length, 2);
    assert.equal(unavailable.calls[1].message, 'Network error');
    assert.equal(unavailable.calls[1].type, 'error');
    console.log('PASS: Connection failure does not report deletion success');
})().catch(error => { console.error(error); process.exitCode = 1; });
