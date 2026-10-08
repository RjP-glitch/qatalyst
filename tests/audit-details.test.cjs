const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const context = {};
vm.createContext(context);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/audit-details.js'), 'utf8'), context);

const markup = context.renderAuditChanges({ records: [{
    table: '<img src=x onerror=alert(1)>', id: '<script>alert(2)</script>',
    changes: { '<script>field</script>': { before: '<svg onload=alert(3)>', after: { comment: '<script>alert(4)</script>' } } }
}] });
assert.ok(!markup.includes('<script>') && !markup.includes('<img') && !markup.includes('<svg'));
assert.ok(markup.includes('&lt;script&gt;') && markup.includes('&lt;svg'));
console.log('PASS: Stored audit values and record labels are escaped before display');

const fingerprint = context.renderAuditChanges({ records: [{ table: 'users', id: 2, changes: { photo: { before: null, after: { sha256: 'abc', bytes: 42 } } } }] });
assert.ok(fingerprint.includes('(empty)') && fingerprint.includes('abc (42 bytes)'));
console.log('PASS: Missing values and file fingerprints remain readable');
assert.equal(context.renderAuditChanges(null), '');
assert.equal(context.renderAuditChanges({ records: [] }), '');
console.log('PASS: Legacy entries without change details remain compatible');
