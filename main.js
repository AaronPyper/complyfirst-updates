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
      options: { temperature: 0.7, num_predict: 4000, num_ctx: 8192 }
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
    req.on('timeout', () => { req.destroy(); done({ success: false, error: 'Timed out after 4 minutes. Ollama may still be loading the model — wait 30 seconds and try again.' }); });
    req.setTimeout(240000);
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
            AlignmentType, BorderStyle, WidthType, ShadingType, ImageRun,
            HorizontalPositionAlign, VerticalPositionAlign, TextWrappingType } = require('docx');
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const iconPath = pathLocal.join(__dirname, 'assets', 'icon.png');
    const iconData = fsLocal.existsSync(iconPath) ? fsLocal.readFileSync(iconPath) : null;

    // Exact brand colours matching the app preview
    const NAVY      = '182457';  // --navy
    const NAVY_TEXT = '2a3350';  // body text
    const TEAL      = '41CFBA';  // --teal (section underline)
    const LIGHT     = 'eef1fa';  // alternating table rows
    const MUTED     = '6b7a99';  // muted text
    const BORDER_C  = 'dde3f0';  // borders
    const WHITE     = 'FFFFFF';

    const thinBorder  = { style: BorderStyle.SINGLE, size: 1,  color: BORDER_C };
    const cellBorders = { top: thinBorder, bottom: thinBorder, left: thinBorder, right: thinBorder };

    const children = [];

    // ── COVER HEADER (navy background table matching app preview) ──
    const coverTopMeta = new TableRow({
      children: [
        new TableCell({
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { fill: NAVY, type: ShadingType.CLEAR },
          margins: { top: 120, bottom: 60, left: 200, right: 200 },
          children: [new Paragraph({ children: [new TextRun({ text: date.toUpperCase(), size: 16, font: 'Arial', color: 'AABBCC', bold: false })] })]
        }),
        new TableCell({
          borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { fill: NAVY, type: ShadingType.CLEAR },
          margins: { top: 120, bottom: 60, left: 200, right: 200 },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'JIRA: ' + ref, size: 16, font: 'Arial', color: 'AABBCC' })] })]
        })
      ]
    });

    const logoChildren = [];
    if (iconData) {
      logoChildren.push(new ImageRun({ data: iconData, type: 'png', transformation: { width: 28, height: 28 } }));
      logoChildren.push(new TextRun({ text: '  ', size: 28 }));
    }
    logoChildren.push(new TextRun({ text: 'comply', size: 28, bold: true, font: 'Arial', color: WHITE }));
    logoChildren.push(new TextRun({ text: 'first', size: 28, bold: true, font: 'Georgia', color: WHITE, italics: true }));

    const coverLogoRow = new TableRow({
      children: [new TableCell({
        columnSpan: 2,
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 60, bottom: 80, left: 200, right: 200 },
        children: [new Paragraph({ children: logoChildren })]
      })]
    });

    const coverWelcomeRow = new TableRow({
      children: [new TableCell({
        columnSpan: 2,
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 0, bottom: 40, left: 200, right: 200 },
        children: [new Paragraph({ children: [new TextRun({ text: 'WELCOME TO COMPLYFIRST', size: 16, font: 'Arial', color: 'AABBCC', allCaps: true })] })]
      })]
    });

    const coverTitleRow = new TableRow({
      children: [new TableCell({
        columnSpan: 2,
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 0, bottom: 100, left: 200, right: 200 },
        children: [new Paragraph({ children: [new TextRun({ text: title, size: 52, bold: true, font: 'Georgia', color: WHITE })] })]
      })]
    });

    const coverNameRow = new TableRow({
      children: [new TableCell({
        columnSpan: 2,
        borders: { top: { style: BorderStyle.NONE }, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
        shading: { fill: NAVY, type: ShadingType.CLEAR },
        margins: { top: 0, bottom: 120, left: 200, right: 200 },
        children: [new Paragraph({ children: [
          new TextRun({ text: det.name, size: 28, bold: true, font: 'Arial', color: WHITE }),
          new TextRun({ text: '  ·  ' + det.role + '  ·  ' + det.dept, size: 22, font: 'Arial', color: 'AABBCC' })
        ]})]
      })]
    });

    const dividerLine = { style: BorderStyle.SINGLE, size: 2, color: '2d4070', space: 1 };
    const coverBottomRow = new TableRow({
      children: [
        new TableCell({
          borders: { top: dividerLine, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { fill: NAVY, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 120, left: 200, right: 200 },
          children: [new Paragraph({ children: [new TextRun({ text: 'COMPLYFIRST LTD', size: 14, font: 'Arial', color: 'AABBCC', allCaps: true })] })]
        }),
        new TableCell({
          borders: { top: dividerLine, bottom: { style: BorderStyle.NONE }, left: { style: BorderStyle.NONE }, right: { style: BorderStyle.NONE } },
          shading: { fill: NAVY, type: ShadingType.CLEAR },
          margins: { top: 80, bottom: 120, left: 200, right: 200 },
          children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: 'CONFIDENTIAL', size: 14, font: 'Arial', color: 'AABBCC', allCaps: true })] })]
        })
      ]
    });

    // Cover table
    children.push(new Table({
      width: { size: 9360, type: WidthType.DXA },
      columnWidths: [4680, 4680],
      rows: [coverTopMeta, coverLogoRow, coverWelcomeRow, coverTitleRow, coverNameRow, coverBottomRow]
    }));

    // Spacing after cover
    children.push(new Paragraph({ children: [], spacing: { before: 320, after: 0 } }));

    // Sub-header with role details
    children.push(new Paragraph({
      children: [
        new TextRun({ text: 'Start Date: ', size: 20, font: 'Arial', color: MUTED, bold: true }),
        new TextRun({ text: det.start + '   ', size: 20, font: 'Arial', color: NAVY_TEXT }),
        new TextRun({ text: 'Manager: ', size: 20, font: 'Arial', color: MUTED, bold: true }),
        new TextRun({ text: det.manager + '   ', size: 20, font: 'Arial', color: NAVY_TEXT }),
        new TextRun({ text: 'Type: ', size: 20, font: 'Arial', color: MUTED, bold: true }),
        new TextRun({ text: type, size: 20, font: 'Arial', color: NAVY_TEXT }),
      ],
      spacing: { before: 0, after: 240 },
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C, space: 1 } }
    }));

    // ── DOCUMENT BODY SECTIONS ──
    for (const sec of sections) {
      if (sec.heading) {
        // Section heading matching app preview: uppercase, navy text, teal underline
        children.push(new Paragraph({
          children: [new TextRun({
            text: sec.heading.toUpperCase(),
            size: 20, bold: true, font: 'Arial', color: NAVY, allCaps: true
          })],
          spacing: { before: 320, after: 100 },
          border: { bottom: { style: BorderStyle.SINGLE, size: 8, color: TEAL, space: 1 } }
        }));
      }

      for (const item of sec.items) {
        if (item.type === 'paragraph') {
          children.push(new Paragraph({
            children: [new TextRun({ text: item.text, size: 22, font: 'Arial', color: NAVY_TEXT })],
            spacing: { before: 60, after: 60 },
            indent: { left: 0 }
          }));

        } else if (item.type === 'checkbox') {
          children.push(new Paragraph({
            children: [
              new TextRun({ text: '\u2610  ', size: 22, font: 'Arial', color: NAVY }),
              new TextRun({ text: item.text, size: 22, font: 'Arial', color: NAVY_TEXT })
            ],
            spacing: { before: 50, after: 50 },
            indent: { left: 360 }
          }));

        } else if (item.type === 'table' && item.rows && item.rows.length > 0) {
          const colCount = item.rows[0].length || 1;
          const totalW = 9000;
          const colW = Math.floor(totalW / colCount);
          children.push(new Table({
            width: { size: totalW, type: WidthType.DXA },
            columnWidths: Array(colCount).fill(colW),
            rows: item.rows.map((row, ri) => new TableRow({
              tableHeader: ri === 0,
              children: row.map(cell => new TableCell({
                borders: cellBorders,
                width: { size: colW, type: WidthType.DXA },
                shading: ri === 0
                  ? { fill: NAVY, type: ShadingType.CLEAR }
                  : ri % 2 === 0
                    ? { fill: LIGHT, type: ShadingType.CLEAR }
                    : { fill: WHITE, type: ShadingType.CLEAR },
                margins: { top: 90, bottom: 90, left: 140, right: 140 },
                children: [new Paragraph({
                  children: [new TextRun({
                    text: cell,
                    size: 20,
                    font: 'Arial',
                    bold: ri === 0,
                    color: ri === 0 ? WHITE : NAVY_TEXT
                  })]
                })]
              }))
            }))
          }));
          children.push(new Paragraph({ children: [], spacing: { before: 120, after: 0 } }));

        } else if (item.type === 'signature') {
          children.push(new Paragraph({ children: [], spacing: { before: 320 },
            border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C } }
          }));
          item.lines.forEach(line => {
            const parts = line.split(/\s{2,}/).filter(p => p.trim());
            children.push(new Paragraph({
              children: parts.map(p => new TextRun({ text: p + '     ', size: 20, font: 'Arial', color: MUTED })),
              spacing: { before: 100, after: 100 }
            }));
          });
        }
      }
    }

    // ── FOOTER ──
    children.push(
      new Paragraph({ children: [], spacing: { before: 400 } }),
      new Paragraph({
        children: [new TextRun({ text: 'COMPLYFIRST LTD  ·  CONFIDENTIAL  ·  complyfirst.co', size: 16, font: 'Arial', color: MUTED, allCaps: true })],
        alignment: AlignmentType.CENTER,
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: BORDER_C } },
        spacing: { before: 120 }
      })
    );

    const doc = new Document({
      styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
      sections: [{ properties: {
        page: {
          size: { width: 11906, height: 16838 },
          margin: { top: 720, right: 1080, bottom: 1080, left: 1080 }
        }
      }, children }]
    });

    const buffer = await Packer.toBuffer(doc);
    return { success: true, buffer: Array.from(buffer) };
  } catch(e) {
    return { success: false, error: e.message };
  }
});
