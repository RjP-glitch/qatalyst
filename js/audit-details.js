function renderAuditChanges(details) {
    if (!details || !Array.isArray(details.records) || !details.records.length) return '';
    const labels = { users: 'Account', public_schools: 'Public school', private_schools: 'Private school', school_submissions: 'Submission', school_calendar_documents: 'Calendar', school_tuition_documents: 'Tuition document', workshops: 'Program', evaluation_programs: 'Imported program' };
    const escape = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    const value = item => {
        if (item === null || item === undefined) return '(empty)';
        if (typeof item === 'object' && item.sha256) return `File or image fingerprint: ${item.sha256} (${item.bytes} bytes)`;
        return typeof item === 'object' ? JSON.stringify(item) : String(item);
    };
    return details.records.map(record => `<div style="margin-top:12px;overflow:auto;">
        <strong>${escape(labels[record.table] || record.table)} #${escape(record.id)}</strong>
        <table style="width:100%;margin-top:6px;table-layout:fixed;text-align:left;border-collapse:collapse;">
            <thead><tr><th>Changed field</th><th>Before</th><th>After</th></tr></thead><tbody>
            ${Object.entries(record.changes || {}).map(([field, change]) => `<tr>
                <td style="padding:6px;vertical-align:top;overflow-wrap:anywhere;">${escape(field.replace(/_/g, ' '))}</td>
                <td style="padding:6px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;">${escape(value(change.before))}</td>
                <td style="padding:6px;vertical-align:top;white-space:pre-wrap;overflow-wrap:anywhere;">${escape(value(change.after))}</td>
            </tr>`).join('')}</tbody></table></div>`).join('');
}
