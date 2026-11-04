const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(context, filename) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../js', filename), 'utf8'), context);
}

const summary = vm.createContext({
    CONFIG: { API_URL: '/api' }, window: { addEventListener() {} }, document: { addEventListener() {} },
});
load(summary, 'program-summary.js');
const cases = [
    [{ start_date: '2026-05-12', end_date: '2026-05-14' }, 'May 12–14, 2026'],
    [{ start_date: '2026-05-12', end_date: '2026-05-14', inclusive_dates: 'May 12, 2026' }, 'May 12–14, 2026'],
    [{ start_date: '2026-05-12', end_date: '2026-05-12' }, 'May 12, 2026'],
    [{ start_date: '2026-05-30', end_date: '2026-06-02' }, 'May 30 – Jun 2, 2026'],
    [{ start_date: '2026-12-30', end_date: '2027-01-02' }, 'Dec 30, 2026 – Jan 2, 2027'],
    [{ start_date: '2026-05-12 00:00:00', end_date: '2026-05-14 00:00:00' }, 'May 12–14, 2026'],
    [{ inclusive_dates: 'May 12–14, 2026' }, 'May 12–14, 2026'],
    [{ start_date: '2026-05-12', inclusive_dates: 'May 12–14, 2026' }, 'May 12–14, 2026'],
    [{ start_date: 'May 12–14, 2026' }, 'May 12–14, 2026'],
    [{ start_date: '2026-05-12' }, 'May 12, 2026'],
    [{ end_date: '2026-05-14' }, 'May 14, 2026'],
    [{}, '—'],
];
for (const [program, expected] of cases) {
    assert.equal(summary.formatDisplayDate(program), expected);
    // This row mapping supplies both the on-screen report and its export snapshot.
    assert.equal(summary.mapProgramRow(program).date, expected);
}
assert.equal(vm.runInContext("ProgramDateUtils.parse('2026-02-30')", summary), null);
assert.equal(vm.runInContext("ProgramDateUtils.range('2024-02-29', '2024-03-01')", summary), 'Feb 29 – Mar 1, 2024');

async function checkEditFlow() {
    const elements = {};
    const element = id => elements[id] ||= {
        value: '', dataset: {}, style: {}, classList: { add() {}, remove() {}, toggle() {} },
        appendChild() {}, innerHTML: '', textContent: '',
    };
    const requests = [];
    const alerts = [];
    let record = { id: 4, workshop_id: 7, title: 'Imported day', inclusive_dates: 'May 12, 2026' };
    const container = { id: 7, title: 'Container', start_date: '2026-05-12', end_date: '2026-05-14' };
    const edit = vm.createContext({
        CONFIG: { API_URL: '/api' }, window: { addEventListener() {} },
        localStorage: { getItem() { return null; }, setItem() {} },
        document: {
            getElementById: element, querySelectorAll() { return []; }, addEventListener() {},
            createElement() {
                return { set textContent(value) {
                    this.innerHTML = String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                } };
            },
        },
        fetch: async (url, options = {}) => {
            if (options.method) {
                const body = JSON.parse(options.body);
                requests.push({ url, method: options.method, body });
                if (options.method === 'PUT') Object.assign(container, body);
                if (options.method === 'PATCH') Object.assign(record, body);
                return { json: async () => ({ success: true }) };
            }
            if (url.includes('dropdown_options')) return { ok: false };
            if (url.includes('program_imports')) return { json: async () => ({ success: true, data: [] }) };
            if (url.includes('records_api')) return { json: async () => ({ success: true, program: record }) };
            return { json: async () => ({ success: true, data: container }) };
        },
        captureAlert: (...args) => alerts.push(args),
    });
    // Reproduce the hosted page: load only programs.js, without the date helper.
    load(edit, 'programs.js');
    for (const [program, expected] of cases) {
        edit.testProgram = program;
        assert.equal(vm.runInContext('ProgramDateUtils.display(testProgram)', edit), expected);
    }
    edit.displayPrograms([{ ...container, source: 'excel', program_type: 'container', status: 'completed' }]);
    assert.match(element('programCardGrid').innerHTML, /May 12–14, 2026/);
    assert.match(element('programsTableBody').innerHTML, /May 12–14, 2026/);
    // Pages that still include the previous helper also remain compatible.
    vm.runInContext('const ProgramDates = {};', edit);
    edit.displayPrograms([{ ...container, source: 'excel', program_type: 'container', status: 'completed' }]);
    assert.match(element('programCardGrid').innerHTML, /May 12–14, 2026/);
    vm.runInContext('populateSelect = () => {}; loadPrograms = () => {}; showAlert = captureAlert;', edit);

    await edit.openEditRecordModal(4, 'Imported day');
    assert.equal(element('erDates').value, 'May 12–14, 2026');
    assert.equal(element('erDates').readOnly, true);
    element('erEndDate').value = '2026-05-16';
    element('erEndDate').oninput();
    assert.equal(element('erDates').value, 'May 12–16, 2026');
    // Saving must refresh derived text even if the date change did not emit an input event.
    element('erEndDate').value = '2026-05-17';
    await edit.saveRecordEdit();
    assert.equal(requests[0].method, 'PUT');
    assert.equal(requests[0].body.end_date, '2026-05-17');
    assert.equal(requests[0].body.inclusive_dates, 'May 12–17, 2026');
    assert.equal(requests[1].method, 'PATCH');
    assert.ok(!('start_date' in requests[1].body), 'Container dates stay on the container');
    assert.equal(summary.formatDisplayDate(container), 'May 12–17, 2026');
    await edit.openEditRecordModal(4, 'Imported day');
    assert.equal(element('erDates').value, 'May 12–17, 2026');

    requests.length = 0;
    element('erEndDate').value = '2026-05-11';
    await edit.saveRecordEdit();
    assert.equal(requests.length, 0);
    assert.match(alerts.at(-1)[1], /End Date must be on or after Start Date/);
    element('startDate').value = '2026-05-12';
    element('endDate').value = '2026-05-11';
    await edit.saveProgramData({ preventDefault() {} });
    assert.equal(requests.length, 0);

    record = { id: 9, title: 'Legacy standalone', start_date: '2026-05-12', inclusive_dates: 'May 12–14, 2026' };
    await edit.openEditRecordModal(9, record.title);
    assert.equal(element('erContainerWorkshopId').value, '');
    assert.equal(element('erDates').readOnly, false);
    assert.equal(element('erDates').value, 'May 12–14, 2026');
    await edit.saveRecordEdit();
    assert.equal(requests[0].method, 'PATCH');
    assert.equal(requests[0].body.inclusive_dates, 'May 12–14, 2026');
    element('erStartDate').value = '2026-05-12';
    element('erEndDate').value = '2026-05-15';
    element('erStartDate').oninput();
    assert.equal(element('erDates').readOnly, true);
    assert.equal(element('erDates').value, 'May 12–15, 2026');
    requests.length = 0;
    await edit.saveRecordEdit();
    assert.equal(requests[0].body.end_date, '2026-05-15');
    assert.equal(requests[0].body.inclusive_dates, 'May 12–15, 2026');
    element('erStartDate').value = '';
    element('erEndDate').value = '';
    element('erEndDate').oninput();
    assert.equal(element('erDates').value, '');
    assert.equal(element('erDates').readOnly, false);
}

checkEditFlow().then(() => console.log('PASS: Standalone script loading, card/table rendering, summary ranges, container saves, live date updates, legacy imports, and invalid range validation'))
    .catch(error => { console.error(error); process.exitCode = 1; });
