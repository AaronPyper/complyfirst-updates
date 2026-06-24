const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#182457',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'ComplyFirst — Document Intelligence'
  });

  mainWindow.loadFile('index.html');
  mainWindow.setMenuBarVisibility(false);
  // Check for updates on launch
  setTimeout(checkForUpdates, 3000);
}


// ── AUTO UPDATER ──
const GITHUB_RAW = 'https://raw.githubusercontent.com/AaronPyper/complyfirst-updates/main/';
const FILES_TO_UPDATE = ['index.html', 'main.js'];

function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function checkForUpdates() {
  try {
    for (const file of FILES_TO_UPDATE) {
      const remoteContent = await fetchRaw(GITHUB_RAW + file + '?t=' + Date.now());
      const localPath = path.join(__dirname, file);
      const localContent = fs.existsSync(localPath) ? fs.readFileSync(localPath, 'utf8') : '';
      if (remoteContent !== localContent && remoteContent.length > 100) {
        fs.writeFileSync(localPath, remoteContent, 'utf8');
        console.log('[AutoUpdate] Updated:', file);
      }
    }
    // If main.js was updated, notify user to restart
    if (mainWindow) {
      mainWindow.webContents.send('update-complete');
    }
  } catch(e) {
    console.log('[AutoUpdate] No update available or offline:', e.message);
  }
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"]
      }
    });
  });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ── CHECK OLLAMA IS RUNNING ──
ipcMain.handle('check-ollama', async () => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (!settled) { settled = true; resolve(result); }
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/tags',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => m.name);
          done({ running: true, models, statusCode: res.statusCode });
        } catch(e) {
          // Got a response but couldn't parse — Ollama is running
          done({ running: true, models: [], statusCode: res.statusCode });
        }
      });
    });

    req.on('error', (e) => {
      done({ running: false, models: [], error: e.message, code: e.code });
    });

    req.on('timeout', () => {
      req.destroy();
      done({ running: false, models: [], error: 'Connection timed out', code: 'TIMEOUT' });
    });

    req.setTimeout(5000);
    req.end();
  });
});

// ── CHECK SPECIFIC MODEL EXISTS ──
ipcMain.handle('check-model', async (event, model) => {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };

    const req = http.request({
      hostname: '127.0.0.1', port: 11434,
      path: '/api/tags', method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const models = (parsed.models || []).map(m => m.name);
          // Fuzzy match - llama3.2 matches llama3.2:latest and vice versa
          const modelBase = model.replace(':latest','').toLowerCase();
          const found = models.some(m => {
            const mBase = m.replace(':latest','').toLowerCase();
            return mBase === modelBase || mBase.startsWith(modelBase) || modelBase.startsWith(mBase);
          });
          done({ found, models });
        } catch(e) { done({ found: false, models: [], error: e.message }); }
      });
    });
    req.on('error', e => done({ found: false, models: [], error: e.message }));
    req.setTimeout(5000);
    req.on('timeout', () => { req.destroy(); done({ found: false, error: 'Timeout' }); });
    req.end();
  });
});

// ── CALL OLLAMA ──
ipcMain.handle('call-ollama', async (event, { system, userMessage, model }) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: model || 'llama3.2',
      prompt: system + '\n\nGenerate a document for: ' + userMessage + '\n\nDocument:',
      stream: false,
      options: { temperature: 0.7, num_predict: 3000, num_ctx: 8192 }
    });

    const options = {
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/generate',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };

    let data = '';
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };

    const req = http.request(options, (res) => {
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            done({ success: false, error: String(parsed.error) });
          } else {
            const text = parsed.response || '';
            if (!text) {
              done({ success: false, error: 'Ollama returned empty response. Try again.' });
            } else {
              done({ success: true, text });
            }
          }
        } catch(e) {
          done({ success: false, error: 'Parse error: ' + e.message + ' | Raw: ' + data.slice(0, 200) });
        }
      });
    });

    req.on('error', (e) => done({ success: false, error: 'Cannot connect to Ollama: ' + e.message }));
    req.on('timeout', () => { req.destroy(); done({ success: false, error: 'Timed out after 3 minutes. Ollama may still be loading the model — wait 30 seconds and try again.' }); });
    req.setTimeout(180000);
    req.write(body);
    req.end();
  });
});

// ── SAVE .DOCX ──
ipcMain.handle('save-docx', async (event, { buffer, filename }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Document',
    defaultPath: filename,
    filters: [{ name: 'Word Document', extensions: ['docx'] }, { name: 'All Files', extensions: ['*'] }]
  });
  if (canceled || !filePath) return { success: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(buffer));
    shell.showItemInFolder(filePath);
    return { success: true, filePath };
  } catch(e) { return { success: false, error: e.message }; }
});

// ── GENERATE .DOCX ──
ipcMain.handle('generate-docx', async (event, { title, type, det, sections, ref, date }) => {
  try {
    const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
            AlignmentType, BorderStyle, WidthType, ShadingType, ImageRun } = require('docx');
    const fs = require('fs');
    const path = require('path');
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const iconData = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;

    const NAVY = '182457', TEAL = '41CFBA', LIGHT = 'eef1fa', BORDER_COLOR = 'dde3f0';
    const border = { style: BorderStyle.SINGLE, size: 1, color: BORDER_COLOR };
    const borders = { top: border, bottom: border, left: border, right: border };
    const children = [];

    // Build header paragraph with icon + wordmark
    const headerChildren = [];
    if (iconData) {
      headerChildren.push(new ImageRun({
        data: iconData, type: 'png',
        transformation: { width: 36, height: 36 }
      }));
      headerChildren.push(new TextRun({ text: '  ', size: 52 }));
    }
    headerChildren.push(new TextRun({ text: 'comply', size: 52, bold: true, font: 'Arial', color: '182457' }));
    headerChildren.push(new TextRun({ text: 'first', size: 52, bold: true, font: 'Georgia', color: '182457', italics: true }));

    children.push(
      new Paragraph({ children: headerChildren, spacing: { before: 0, after: 80 } }),
      new Paragraph({ children: [
        new TextRun({ text: 'complyfirst.co  ·  Document Intelligence Platform', size: 18, color: '5a6b8a', font: 'Arial' })
      ], spacing: { before: 0, after: 280 } }),
      new Paragraph({ children: [
        new TextRun({ text: title, size: 56, bold: true, font: 'Georgia', color: NAVY })
      ], spacing: { before: 0, after: 100 } }),
      new Paragraph({ children: [
        new TextRun({ text: det.name, size: 30, bold: true, font: 'Arial', color: NAVY })
      ], spacing: { before: 0, after: 60 } }),
      new Paragraph({ children: [
        new TextRun({ text: `${det.role}  ·  ${det.dept}`, size: 22, font: 'Arial', color: '5a6b8a' })
      ], spacing: { before: 0, after: 50 } }),
      new Paragraph({ children: [
        new TextRun({ text: `Start Date: ${det.start}  ·  Manager: ${det.manager}  ·  Ref: ${ref}`, size: 20, font: 'Arial', color: '5a6b8a' })
      ], spacing: { before: 0, after: 50 } }),
      new Paragraph({ children: [
        new TextRun({ text: `Date: ${date}  ·  Type: ${type}`, size: 20, font: 'Arial', color: '9aa0b8' })
      ], spacing: { before: 0, after: 160 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: NAVY, space: 1 } } })
    );

    for (const sec of sections) {
      if (sec.heading) {
        children.push(new Paragraph({
          children: [new TextRun({ text: sec.heading.toUpperCase(), size: 20, bold: true, font: 'Arial', color: NAVY })],
          spacing: { before: 280, after: 80 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '41CFBA', space: 1 } }
        }));
      }
      for (const item of sec.items) {
        if (item.type === 'paragraph') {
          children.push(new Paragraph({
            children: [new TextRun({ text: item.text, size: 22, font: 'Arial', color: '2a3350' })],
            spacing: { before: 50, after: 50 }
          }));
        } else if (item.type === 'checkbox') {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: '\u2610  ', size: 22, font: 'Arial', color: NAVY }),
              new TextRun({ text: item.text, size: 22, font: 'Arial', color: '2a3350' })
            ],
            spacing: { before: 40, after: 40 }, indent: { left: 360 }
          }));
        } else if (item.type === 'table' && item.rows && item.rows.length > 0) {
          const colCount = item.rows[0].length || 1;
          const totalW = 9000;
          const colW = Math.floor(totalW / colCount);
          children.push(new Table({
            width: { size: totalW, type: WidthType.DXA },
            columnWidths: Array(colCount).fill(colW),
            rows: item.rows.map((row, ri) => new TableRow({
              children: row.map(cell => new TableCell({
                borders, width: { size: colW, type: WidthType.DXA },
                shading: ri === 0 ? { fill: NAVY, type: ShadingType.CLEAR } : ri % 2 === 0 ? { fill: LIGHT, type: ShadingType.CLEAR } : {},
                margins: { top: 80, bottom: 80, left: 120, right: 120 },
                children: [new Paragraph({ children: [new TextRun({
                  text: cell, size: 20, font: 'Arial', bold: ri === 0,
                  color: ri === 0 ? 'FFFFFF' : '2a3350'
                })] })]
              }))
            }))
          }));
          children.push(new Paragraph({ children: [], spacing: { before: 80 } }));
        } else if (item.type === 'signature') {
          children.push(
            new Paragraph({ children: [], spacing: { before: 200 }, border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR } } }),
            ...item.lines.map(line => new Paragraph({
              children: [new TextRun({ text: line, size: 20, font: 'Arial', color: '5a6b8a' })],
              spacing: { before: 100, after: 100 }
            }))
          );
        }
      }
    }

    children.push(
      new Paragraph({ children: [], spacing: { before: 280 } }),
      new Paragraph({
        children: [new TextRun({ text: 'COMPLYFIRST LTD  ·  CONFIDENTIAL  ·  complyfirst.co', size: 16, font: 'Arial', color: '9aa0b8' })],
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_COLOR } },
        spacing: { before: 100 }
      })
    );

    const doc = new Document({
      styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
      sections: [{ properties: {
        page: { size: { width: 11906, height: 16838 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } }
      }, children }]
    });

    const buffer = await Packer.toBuffer(doc);
    return { success: true, buffer: Array.from(buffer) };
  } catch(e) {
    return { success: false, error: e.message };
  }
});
