const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let mainWindow;

// Work out where app files live (different in dev vs packaged)
const APP_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'app')
  : __dirname;

// -- AUTO UPDATER --
const GITHUB_RAW = 'https://raw.githubusercontent.com/AaronPyper/complyfirst-updates/main/';
const FILES_TO_UPDATE = ['index.html', 'main.js', 'preload.js'];

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    const req = https.get(url, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        https.get(res.headers.location, (r2) => {
          let d = ''; r2.on('data', c => d += c); r2.on('end', () => done(d));
        }).on('error', reject);
        return;
      }
      let d = ''; res.on('data', c => d += c); res.on('end', () => done(d));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.setTimeout(10000);
  });
}

async function checkForUpdates() {
  try {
    let anyUpdated = false, indexUpdated = false;
    for (const file of FILES_TO_UPDATE) {
      try {
        const remote = await fetchRaw(GITHUB_RAW + file + '?nocache=' + Date.now());
        if (!remote || remote.length < 100 || remote.includes('404: Not Found')) continue;
        const localPath = path.join(APP_DIR, file);
        const local = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
        if (remote.trim() !== local.trim()) {
          fs.writeFileSync(localPath, remote, 'utf8');
          console.log('[AutoUpdate] Updated:', file);
          anyUpdated = true;
          if (file === 'index.html') indexUpdated = true;
        }
      } catch(e) { console.log('[AutoUpdate] Could not fetch', file, ':', e.message); }
    }
    if (anyUpdated && mainWindow) {
      setTimeout(() => {
        mainWindow.webContents.send(indexUpdated ? 'update-complete' : 'update-needs-restart');
      }, 500);
    }
  } catch(e) { console.log('[AutoUpdate] Check failed:', e.message); }
}

// -- CREATE WINDOW --
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#182457',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'ComplyFirst - Document Intelligence'
  });
  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  setTimeout(checkForUpdates, 3000);
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob: filesystem: app:"] } });
  });
  createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

// -- CHECK OLLAMA --
ipcMain.handle('check-ollama', async () => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/tags', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          done({ running: true, models: (p.models || []).map(m => m.name) });
        } catch(e) { done({ running: true, models: [] }); }
      });
    });
    req.on('error', (e) => done({ running: false, models: [], error: e.message, code: e.code }));
    req.on('timeout', () => { req.destroy(); done({ running: false, models: [], error: 'Connection timed out', code: 'TIMEOUT' }); });
    req.setTimeout(5000);
    req.end();
  });
});

// -- CHECK MODEL --
ipcMain.handle('check-model', async (event, model) => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request({ hostname: '127.0.0.1', port: 11434, path: '/api/tags', method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          const models = (p.models || []).map(m => m.name);
          const base = model.replace(':latest', '').toLowerCase();
          const found = models.some(m => {
            const mb = m.replace(':latest', '').toLowerCase();
            return mb === base || mb.startsWith(base) || base.startsWith(mb);
          });
          done({ found, models });
        } catch(e) { done({ found: false, models: [], error: e.message }); }
      });
    });
    req.on('error', e => done({ found: false, models: [], error: e.message }));
    req.setTimeout(5000); req.on('timeout', () => { req.destroy(); done({ found: false, error: 'Timeout' }); });
    req.end();
  });
});

// -- CALL OLLAMA --
ipcMain.handle('call-ollama', async (event, { system, userMessage, model }) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'llama3.2',
      prompt: system + '\n\nGenerate a document for: ' + userMessage + '\n\nDocument:',
      stream: false,
      options: { temperature: 0.7, num_predict: 4000, num_ctx: 8192 }
    });
    const options = {
      hostname: '127.0.0.1', port: 11434, path: '/api/generate', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    let data = '', settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const req = http.request(options, (res) => {
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const p = JSON.parse(data);
          if (p.error) done({ success: false, error: String(p.error) });
          else done({ success: true, text: p.response || '' });
        } catch(e) { done({ success: false, error: 'Parse error: ' + e.message }); }
      });
    });
    req.on('error', e => done({ success: false, error: 'Cannot connect to Ollama: ' + e.message }));
    req.on('timeout', () => { req.destroy(); done({ success: false, error: 'Timed out after 4 minutes. Try again.' }); });
    req.setTimeout(240000);
    req.write(body); req.end();
  });
});

// -- SAVE DOCX --
ipcMain.handle('save-docx', async (event, { buffer, filename }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Word Document', defaultPath: filename,
    filters: [{ name: 'Word Document', extensions: ['docx'] }]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try { fs.writeFileSync(filePath, Buffer.from(buffer)); shell.showItemInFolder(filePath); return { success: true, filePath }; }
  catch(e) { return { success: false, error: e.message }; }
});

// -- SAVE PDF --
ipcMain.handle('save-pdf', async (event, { buffer, filename }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF', defaultPath: filename,
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try { fs.writeFileSync(filePath, Buffer.from(buffer)); shell.showItemInFolder(filePath); return { success: true, filePath }; }
  catch(e) { return { success: false, error: e.message }; }
});

// -- GENERATE DOCX --
ipcMain.handle('generate-docx', async (event, { title, type, det, sections, ref, date }) => {
  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, BorderStyle, WidthType, ShadingType, ImageRun, ExternalHyperlink } = require('docx');

    const NAVY = '182457', TEAL = '41CFBA', MUTED = '6b7a99';
    const TEXT = '2a3350', LIGHT = 'eef1fa', BORDER = 'dde3f0', WHITE = 'FFFFFF';

    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const iconData = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;

    const thin = { style: BorderStyle.SINGLE, size: 1, color: BORDER };
    const cellBorders = { top: thin, bottom: thin, left: thin, right: thin };
    const none = { style: BorderStyle.NONE };
    const noneBorders = { top: none, bottom: none, left: none, right: none };

    const children = [];

    // Cover - top meta row
    children.push(new Table({
      width: { size: 9360, type: WidthType.DXA }, columnWidths: [4680, 4680],
      rows: [
        new TableRow({ children: [
          new TableCell({ borders: noneBorders, margins: { top: 120, bottom: 60, left: 200, right: 200 },
            children: [new Paragraph({ children: [new TextRun({ text: date, size: 18, font: 'Arial', color: MUTED })] })] }),
          new TableCell({ borders: noneBorders, margins: { top: 120, bottom: 60, left: 200, right: 200 },
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'Ref: ' + ref, size: 18, font: 'Arial', color: MUTED })] })] })
        ]}),
        new TableRow({ children: [new TableCell({
          columnSpan: 2, borders: noneBorders, margins: { top: 80, bottom: 60, left: 200, right: 200 },
          children: [new Paragraph({ children: [
            ...(iconData ? [new ImageRun({ data: iconData, type: 'png', transformation: { width: 28, height: 28 } }), new TextRun({ text: '  ', size: 28 })] : []),
            new TextRun({ text: 'comply', size: 28, bold: true, font: 'Arial', color: NAVY }),
            new TextRun({ text: 'first', size: 28, bold: true, font: 'Georgia', color: NAVY, italics: true })
          ]})]
        })]}),
        new TableRow({ children: [new TableCell({
          columnSpan: 2, borders: noneBorders, margins: { top: 0, bottom: 40, left: 200, right: 200 },
          children: [new Paragraph({ children: [new TextRun({ text: 'WELCOME TO COMPLYFIRST', size: 16, font: 'Arial', color: MUTED })] })]
        })]}),
        new TableRow({ children: [new TableCell({
          columnSpan: 2, borders: noneBorders, margins: { top: 0, bottom: 80, left: 200, right: 200 },
          children: [new Paragraph({ children: [new TextRun({ text: title, size: 52, bold: true, font: 'Georgia', color: NAVY })] })]
        })]}),
        new TableRow({ children: [new TableCell({
          columnSpan: 2, borders: noneBorders, margins: { top: 0, bottom: 80, left: 200, right: 200 },
          children: [new Paragraph({ children: [
            new TextRun({ text: det.name, size: 28, bold: true, font: 'Arial', color: NAVY }),
            new TextRun({ text: '  |  ' + det.role + '  |  ' + det.dept, size: 22, font: 'Arial', color: MUTED })
          ]})]
        })]}),
        new TableRow({ children: [new TableCell({
          columnSpan: 2, borders: noneBorders, margins: { top: 0, bottom: 80, left: 200, right: 200 },
          children: [new Paragraph({ children: [new TextRun({ text: 'Start: ' + det.start + '  |  Manager: ' + det.manager, size: 20, font: 'Arial', color: MUTED })] })]
        })]}),
        new TableRow({ children: [
          new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 6, color: TEAL }, bottom: none, left: none, right: none },
            margins: { top: 80, bottom: 80, left: 200, right: 200 },
            children: [new Paragraph({ children: [new TextRun({ text: 'COMPLYFIRST LTD', size: 14, font: 'Arial', color: MUTED })] })] }),
          new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 6, color: TEAL }, bottom: none, left: none, right: none },
            margins: { top: 80, bottom: 80, left: 200, right: 200 },
            children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'CONFIDENTIAL', size: 14, font: 'Arial', color: MUTED })] })] })
        ]})
      ]
    }));

    children.push(new Paragraph({ children: [], spacing: { before: 280, after: 0 } }));
    children.push(new Paragraph({
      children: [new TextRun({ text: type + '  |  ' + date, size: 18, font: 'Arial', color: MUTED })],
      spacing: { before: 0, after: 200 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER } }
    }));

    // Body sections
    for (const sec of sections) {
      if (sec.heading) {
        children.push(new Paragraph({
          children: [new TextRun({ text: sec.heading.toUpperCase(), size: 20, bold: true, font: 'Arial', color: NAVY })],
          spacing: { before: 280, after: 80 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: TEAL } }
        }));
      }

      for (const item of sec.items) {
        if (item.type === 'paragraph') {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const parts = item.text.split(urlRegex);
          const paraChildren = [];
          parts.forEach(part => {
            if (!part) return;
            if (urlRegex.test(part)) {
              paraChildren.push(new ExternalHyperlink({ link: part, children: [
                new TextRun({ text: part, size: 22, font: 'Arial', color: TEAL, underline: { type: 'single', color: TEAL } })
              ]}));
            } else {
              paraChildren.push(new TextRun({ text: part, size: 22, font: 'Arial', color: TEXT }));
            }
            urlRegex.lastIndex = 0;
          });
          children.push(new Paragraph({
            children: paraChildren.length ? paraChildren : [new TextRun({ text: item.text, size: 22, font: 'Arial', color: TEXT })],
            spacing: { before: 50, after: 50 }
          }));

        } else if (item.type === 'checkbox') {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: '\u2610  ', size: 22, font: 'Arial', color: NAVY }),
              new TextRun({ text: item.text, size: 22, font: 'Arial', color: TEXT })
            ],
            spacing: { before: 40, after: 40 }, indent: { left: 360 }
          }));

        } else if (item.type === 'table' && item.rows && item.rows.length > 0) {
          const cols = item.rows[0].length || 1;
          const totalW = 9000, colW = Math.floor(totalW / cols);
          children.push(new Table({
            width: { size: totalW, type: WidthType.DXA },
            columnWidths: Array(cols).fill(colW),
            rows: item.rows.map((row, ri) => new TableRow({
              tableHeader: ri === 0,
              children: row.map(cell => new TableCell({
                borders: cellBorders,
                width: { size: colW, type: WidthType.DXA },
                shading: ri === 0 ? { fill: NAVY, type: ShadingType.CLEAR } : ri % 2 === 0 ? { fill: LIGHT, type: ShadingType.CLEAR } : { fill: WHITE, type: ShadingType.CLEAR },
                margins: { top: 90, bottom: 90, left: 140, right: 140 },
                children: [new Paragraph({ children: [new TextRun({
                  text: String(cell || ''), size: 20, font: 'Arial',
                  bold: ri === 0, color: ri === 0 ? WHITE : TEXT
                })] })]
              }))
            }))
          }));
          children.push(new Paragraph({ children: [], spacing: { before: 100 } }));

        } else if (item.type === 'signature') {
          children.push(new Paragraph({ children: [], spacing: { before: 240 },
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER } }
          }));
          item.lines.forEach(line => {
            const parts = line.split(/\s{2,}/).filter(p => p.trim());
            children.push(new Paragraph({
              children: parts.map(p => new TextRun({ text: p + '          ', size: 20, font: 'Arial', color: MUTED })),
              spacing: { before: 100, after: 100 }
            }));
          });
        }
      }
    }

    // Footer
    children.push(
      new Paragraph({ children: [], spacing: { before: 320 } }),
      new Paragraph({
        children: [new TextRun({ text: 'COMPLYFIRST LTD  |  CONFIDENTIAL  |  complyfirst.co', size: 16, font: 'Arial', color: MUTED })],
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER } },
        spacing: { before: 100 }
      })
    );

    const doc = new Document({
      styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
      sections: [{ properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 1080, bottom: 1080, left: 1080 } }
      }, children }]
    });

    const buffer = await Packer.toBuffer(doc);
    return { success: true, buffer: Array.from(buffer) };
  } catch(e) { return { success: false, error: e.message }; }
});

// -- GENERATE PDF --
ipcMain.handle('generate-pdf', async (event, { title, type, det, sections, ref, date }) => {
  try {
    const PDFDocument = require('pdfkit');

    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const iconData = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;

    const NAVY = '#182457', TEAL = '#41CFBA', MUTED = '#6b7a99';
    const TEXT = '#2a3350', LIGHT = '#eef1fa', BORDER = '#dde3f0', WHITE = '#ffffff';

    const doc = new PDFDocument({ size: 'A4', margin: 50,
      info: { Title: title, Author: 'ComplyFirst Ltd', Creator: 'ComplyFirst Document Intelligence' }
    });

    const chunks = [];
    doc.on('data', c => chunks.push(c));
    const pageW = doc.page.width - 100;

    function addPageHeader() {
      if (iconData) doc.image(iconData, 50, 28, { width: 18, height: 18 });
      const tx = iconData ? 74 : 50;
      doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold').text('comply', tx, 33, { continued: true })
         .font('Helvetica-Oblique').text('first  ', { continued: true })
         .font('Helvetica').fillColor(MUTED).text(title, { width: pageW - 80 });
      doc.moveTo(50, 54).lineTo(50 + pageW, 54).lineWidth(1).strokeColor(TEAL).stroke();
      doc.y = 66;
    }

    function checkPage() {
      if (doc.y > doc.page.height - 100) { doc.addPage(); addPageHeader(); }
    }

    // Cover
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text(date, 50, 50, { continued: true, width: pageW }).text('Ref: ' + ref, { align: 'right' });

    let logoY = 70;
    if (iconData) doc.image(iconData, 50, logoY, { width: 32, height: 32 });
    doc.fontSize(18).fillColor(NAVY)
       .font('Helvetica-Bold').text('comply', iconData ? 90 : 50, logoY + 7, { continued: true })
       .font('Helvetica-Oblique').text('first');

    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text('WELCOME TO COMPLYFIRST', 50, logoY + 46, { characterSpacing: 1.5 });

    doc.fontSize(26).fillColor(NAVY).font('Helvetica-Bold')
       .text(title, 50, logoY + 62, { width: pageW });

    const titleH = doc.heightOfString(title, { fontSize: 26, width: pageW });
    const nameY = logoY + 72 + titleH;
    const nameW = Math.min(doc.widthOfString(det.name, { fontSize: 13 }) + 24, pageW);
    doc.roundedRect(50, nameY, nameW, 26, 4).fillAndStroke(LIGHT, BORDER);
    doc.fontSize(13).fillColor(NAVY).font('Helvetica-Bold').text(det.name, 62, nameY + 6);

    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(det.role + '  |  ' + det.dept + '  |  Start: ' + det.start + '  |  Manager: ' + det.manager,
             50, nameY + 34, { width: pageW });

    const divY = nameY + 54;
    doc.moveTo(50, divY).lineTo(50 + pageW, divY).lineWidth(2).strokeColor(TEAL).stroke();
    doc.y = divY + 16;

    // Body
    for (const sec of sections) {
      checkPage();
      if (sec.heading) {
        doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold')
           .text(sec.heading.toUpperCase(), 50, doc.y + 10, { width: pageW, characterSpacing: 1 });
        doc.moveTo(50, doc.y + 3).lineTo(50 + pageW, doc.y + 3).lineWidth(1.5).strokeColor(TEAL).stroke();
        doc.y = doc.y + 10;
      }

      for (const item of sec.items) {
        checkPage();

        if (item.type === 'paragraph') {
          const urlRegex = /(https?:\/\/[^\s]+)/g;
          const parts = item.text.split(urlRegex);
          if (parts.length > 1) {
            let startY = doc.y, startX = 50, first = true;
            parts.forEach((part, i) => {
              if (!part) return;
              const isUrl = urlRegex.test(part);
              urlRegex.lastIndex = 0;
              const hasMore = parts.slice(i+1).some(p => p);
              if (isUrl) {
                doc.fontSize(10).fillColor(TEAL).font('Helvetica')
                   .text(part, { link: part, underline: true, continued: hasMore });
              } else {
                if (first) {
                  doc.fontSize(10).fillColor(TEXT).font('Helvetica')
                     .text(part, 50, doc.y, { width: pageW, continued: hasMore });
                } else {
                  doc.fontSize(10).fillColor(TEXT).font('Helvetica')
                     .text(part, { width: pageW, continued: hasMore });
                }
              }
              first = false;
            });
          } else {
            doc.fontSize(10).fillColor(TEXT).font('Helvetica').text(item.text, 50, doc.y, { width: pageW });
          }
          doc.moveDown(0.35);

        } else if (item.type === 'checkbox') {
          const cy = doc.y;
          doc.rect(50, cy + 1, 10, 10).lineWidth(1).strokeColor(BORDER).stroke();
          doc.fontSize(10).fillColor(TEXT).font('Helvetica').text(item.text, 68, cy, { width: pageW - 18 });
          doc.moveDown(0.25);

        } else if (item.type === 'table' && item.rows && item.rows.length > 0) {
          const cols = item.rows[0].length || 1;
          const cw = pageW / cols;
          const rh = 20;
          item.rows.forEach((row, ri) => {
            checkPage();
            const ry = doc.y;
            row.forEach((cell, ci) => {
              const cx = 50 + ci * cw;
              if (ri === 0) doc.rect(cx, ry, cw, rh).fillColor(NAVY).fill();
              else if (ri % 2 === 0) doc.rect(cx, ry, cw, rh).fillColor(LIGHT).fill();
              doc.rect(cx, ry, cw, rh).lineWidth(0.5).strokeColor(BORDER).stroke();
              doc.fontSize(9).fillColor(ri === 0 ? WHITE : TEXT)
                 .font(ri === 0 ? 'Helvetica-Bold' : 'Helvetica')
                 .text(String(cell || ''), cx + 5, ry + 5, { width: cw - 10, height: rh - 6, ellipsis: true });
            });
            doc.y = ry + rh;
          });
          doc.moveDown(0.6);

        } else if (item.type === 'signature') {
          doc.moveDown(0.8);
          doc.moveTo(50, doc.y).lineTo(50 + pageW, doc.y).lineWidth(0.5).strokeColor(BORDER).stroke();
          doc.moveDown(0.4);
          item.lines.forEach(line => {
            const parts = line.split(/\s{2,}/).filter(p => p.trim());
            const sw = pageW / Math.max(parts.length, 1);
            const sy = doc.y;
            parts.forEach((p, i) => {
              doc.moveTo(50 + i*sw, sy + 20).lineTo(50 + i*sw + sw*0.8, sy + 20)
                 .lineWidth(0.5).strokeColor(MUTED).stroke();
              doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(p, 50 + i*sw, sy + 24, { width: sw*0.85 });
            });
            doc.y = sy + 38;
          });
        }
      }
    }

    // Footer
    doc.moveDown(1.5);
    if (doc.y > doc.page.height - 60) doc.addPage();
    doc.moveTo(50, doc.y).lineTo(50 + pageW, doc.y).lineWidth(0.5).strokeColor(BORDER).stroke();
    doc.moveDown(0.4);
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text('COMPLYFIRST LTD  |  CONFIDENTIAL  |  complyfirst.co', 50, doc.y, { align: 'center', width: pageW });

    doc.end();

    return new Promise((resolve) => {
      doc.on('end', () => resolve({ success: true, buffer: Array.from(Buffer.concat(chunks)) }));
      doc.on('error', e => resolve({ success: false, error: e.message }));
    });
  } catch(e) { return { success: false, error: e.message }; }
});
