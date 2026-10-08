const express = require('express');
const fs = require('fs');
const { Document, Packer, Paragraph, TextRun } = require('docx');

const app = express();
app.use(express.json({ limit: '5mb' }));

app.post('/export/quality-report', async (req, res) => {
    try {
        const report = req.body;
        // TODO: Build the document using report data
        const doc = new Document({
            sections: [{
                properties: {},
                children: [
                    new Paragraph({
                        children: [
                            new TextRun({ text: 'Quality Report', bold: true, size: 32 }),
                        ],
                    }),
                    new Paragraph(''),
                    new Paragraph({
                        children: [
                            new TextRun('Report Data:'),
                            new TextRun({ text: JSON.stringify(report, null, 2), break: 1 })
                        ]
                    })
                ]
            }]
        });
        const buffer = await Packer.toBuffer(doc);
        res.setHeader('Content-Disposition', 'attachment; filename=quality_report.docx');
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        res.send(buffer);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

const PORT = 3001;
app.listen(PORT, () => console.log(`Quality Report Export API running on port ${PORT}`));
