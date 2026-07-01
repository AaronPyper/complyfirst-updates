const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs   = require('fs');
const http  = require('http');
const https = require('https');

let win;

// ---------- auto-updater ----------
const REPO = 'https://raw.githubusercontent.com/AaronPyper/complyfirst-updates/main/';
function fetchText(url) {
  return new Promise((res, rej) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location)
        return fetchText(r.headers.location).then(res).catch(rej);
      let d = ''; r.on('data', c => d += c); r.on('end', () => res(d));
    });
    req.on('error', rej);
    req.setTimeout(10000, () => { req.destroy(); rej(new Error('timeout')); });
  });
}
async function checkUpdates() {
  for (const f of ['index.html','main.js','preload.js']) {
    try {
      const remote = await fetchText(REPO + f + '?t=' + Date.now());
      if (!remote || remote.length < 200 || remote.includes('404: Not Found')) continue;
      const lp = path.join(__dirname, f);
      const local = fs.existsSync(lp) ? fs.readFileSync(lp, 'utf8') : '';
      if (remote.trim() !== local.trim()) {
        fs.writeFileSync(lp, remote, 'utf8');
        if (win) win.webContents.send(f === 'index.html' ? 'update-ready' : 'update-restart');
      }
    } catch (_) {}
  }
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1300, height: 880, minWidth: 960, minHeight: 660,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#182457',
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      webSecurity: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
    title: 'ComplyFirst',
  });
  win.loadFile('index.html');
  win.setMenuBarVisibility(false);
  setTimeout(checkUpdates, 5000);
}

app.whenReady().then(() => {
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': ["default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"] } });
  });
  createWindow();
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });

// ---------- helpers ----------
function ollReq(endpoint, body) {
  return new Promise((res, rej) => {
    const opts = { hostname: '127.0.0.1', port: 11434, path: endpoint, method: body ? 'POST' : 'GET' };
    if (body) opts.headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) };
    let done = false, data = '';
    const finish = r => { if (!done) { done = true; res(r); } };
    const req = http.request(opts, r => {
      r.on('data', c => data += c);
      r.on('end', () => { try { finish(JSON.parse(data)); } catch(e) { finish({ _raw: data }); } });
    });
    req.on('error', e => rej(e));
    req.setTimeout(body ? 240000 : 5000, () => { req.destroy(); rej(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

// ---------- IPC: Ollama ----------
ipcMain.handle('checkOllama', async () => {
  try {
    const p = await ollReq('/api/tags', null);
    return { ok: true, models: (p.models || []).map(m => m.name) };
  } catch(e) { return { ok: false, error: e.message, code: e.code }; }
});

ipcMain.handle('checkModel', async (_, model) => {
  try {
    const p = await ollReq('/api/tags', null);
    const models = (p.models || []).map(m => m.name);
    const base = model.replace(':latest','').toLowerCase();
    const found = models.some(m => m.replace(':latest','').toLowerCase().includes(base));
    return { found, models };
  } catch(e) { return { found: false, models: [], error: e.message }; }
});

ipcMain.handle('generate', async (_, { system, prompt, model }) => {
  try {
    const body = JSON.stringify({
      model: model || 'llama3.2',
      prompt: system + '\n\nTask: ' + prompt + '\n\nDocument output:',
      stream: false,
      options: { temperature: 0.7, num_predict: 4000, num_ctx: 8192 },
    });
    const p = await ollReq('/api/generate', body);
    if (p.error) return { ok: false, error: String(p.error) };
    if (!p.response) return { ok: false, error: 'Ollama returned empty response. Try again.' };
    return { ok: true, text: p.response };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ---------- IPC: save file ----------
ipcMain.handle('save', async (_, { buffer, filename, ext, label }) => {
  const { filePath, canceled } = await dialog.showSaveDialog(win, {
    title: 'Save ' + label, defaultPath: filename,
    filters: [{ name: label, extensions: [ext] }],
  });
  if (canceled || !filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(filePath, Buffer.from(buffer));
    shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  } catch(e) { return { ok: false, error: e.message }; }
});

// ---------- IPC: make Word document ----------
ipcMain.handle('makeDocx', async (_, { title, type, det, secs, ref, date }) => {
  try {
    const {
      Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
      AlignmentType, BorderStyle, WidthType, ShadingType, ImageRun, ExternalHyperlink,
    } = require('docx');

    const C = { NAVY:'182457', TEAL:'41CFBA', MUTED:'6b7a99', BODY:'2a3350', LIGHT:'eef1fa', BORD:'dde3f0', WHITE:'FFFFFF' };
    const nb  = { style: BorderStyle.NONE };
    const nob = { top:nb, bottom:nb, left:nb, right:nb };
    const th  = { style: BorderStyle.SINGLE, size:1, color: C.BORD };
    const cb  = { top:th, bottom:th, left:th, right:th };

    const iconBuf = (() => { const p = path.join(__dirname,'assets','icon.png'); return fs.existsSync(p) ? fs.readFileSync(p) : null; })();

    const fullCell = (content, mt=60, mb=60) => new TableCell({
      columnSpan:2, borders:nob, margins:{ top:mt, bottom:mb, left:200, right:200 },
      children: Array.isArray(content) ? content : [content],
    });

    // Logo row
    const logoRuns = [];
    if (iconBuf) { logoRuns.push(new ImageRun({ data:iconBuf, type:'png', transformation:{ width:24, height:24 } })); logoRuns.push(new TextRun({ text:'  ', size:24 })); }
    logoRuns.push(new TextRun({ text:'comply', size:24, bold:true, font:'Arial', color:C.NAVY }));
    logoRuns.push(new TextRun({ text:'first',  size:24, bold:true, font:'Georgia', color:C.NAVY, italics:true }));

    const children = [];

    // Cover table
    children.push(new Table({
      width: { size:9360, type:WidthType.DXA }, columnWidths:[4680,4680],
      rows: [
        // date | ref
        new TableRow({ children:[
          new TableCell({ borders:nob, margins:{ top:120,bottom:60,left:200,right:200 }, children:[new Paragraph({ children:[new TextRun({ text:date, size:18, font:'Arial', color:C.MUTED })] })] }),
          new TableCell({ borders:nob, margins:{ top:120,bottom:60,left:200,right:200 }, children:[new Paragraph({ alignment:AlignmentType.RIGHT, children:[new TextRun({ text:'Ref: '+ref, size:18, font:'Arial', color:C.MUTED })] })] }),
        ]}),
        // logo
        new TableRow({ children:[fullCell(new Paragraph({ children:logoRuns }), 80, 80)] }),
        // welcome
        new TableRow({ children:[fullCell(new Paragraph({ children:[new TextRun({ text:'WELCOME TO COMPLYFIRST', size:16, font:'Arial', color:C.MUTED })] }), 40, 40)] }),
        // title
        new TableRow({ children:[fullCell(new Paragraph({ children:[new TextRun({ text:title, size:52, bold:true, font:'Georgia', color:C.NAVY })] }), 60, 100)] }),
        // name | role | dept
        new TableRow({ children:[fullCell(new Paragraph({ children:[
          new TextRun({ text:det.name, size:26, bold:true, font:'Arial', color:C.NAVY }),
          new TextRun({ text:'  |  '+det.role+'  |  '+det.dept, size:20, font:'Arial', color:C.MUTED }),
        ]}), 40, 60)] }),
        // start | manager
        new TableRow({ children:[fullCell(new Paragraph({ children:[
          new TextRun({ text:'Start: '+det.start+'  |  Manager: '+det.manager, size:18, font:'Arial', color:C.MUTED }),
        ]}), 40, 100)] }),
        // bottom bar with teal border
        new TableRow({ children:[
          new TableCell({ borders:{ top:{ style:BorderStyle.SINGLE, size:8, color:C.TEAL }, bottom:nb, left:nb, right:nb }, margins:{ top:80, bottom:100, left:200, right:200 }, children:[new Paragraph({ children:[new TextRun({ text:'COMPLYFIRST LTD', size:14, font:'Arial', color:C.MUTED })] })] }),
          new TableCell({ borders:{ top:{ style:BorderStyle.SINGLE, size:8, color:C.TEAL }, bottom:nb, left:nb, right:nb }, margins:{ top:80, bottom:100, left:200, right:200 }, children:[new Paragraph({ alignment:AlignmentType.RIGHT, children:[new TextRun({ text:'CONFIDENTIAL', size:14, font:'Arial', color:C.MUTED })] })] }),
        ]}),
      ],
    }));

    children.push(new Paragraph({ children:[], spacing:{ before:200, after:0 } }));
    children.push(new Paragraph({ children:[new TextRun({ text:type, size:18, font:'Arial', color:C.MUTED })], spacing:{ before:0, after:160 }, border:{ bottom:{ style:BorderStyle.SINGLE, size:4, color:C.BORD } } }));

    // Document body
    const urlRe = () => /(https?:\/\/[^\s]+)/g;
    for (const sec of secs) {
      if (sec.h) children.push(new Paragraph({ children:[new TextRun({ text:sec.h.toUpperCase(), size:20, bold:true, font:'Arial', color:C.NAVY })], spacing:{ before:280, after:80 }, border:{ bottom:{ style:BorderStyle.SINGLE, size:6, color:C.TEAL } } }));
      for (const item of sec.items) {
        if (item.t === 'p') {
          const re = urlRe();
          const parts = item.text.split(re);
          const runs = [];
          parts.forEach(part => {
            if (!part) return;
            re.lastIndex = 0;
            if (re.test(part)) {
              runs.push(new ExternalHyperlink({ link:part, children:[new TextRun({ text:part, size:22, font:'Arial', color:C.TEAL, underline:{ type:'single', color:C.TEAL } })] }));
            } else {
              runs.push(new TextRun({ text:part, size:22, font:'Arial', color:C.BODY }));
            }
          });
          children.push(new Paragraph({ children:runs.length?runs:[new TextRun({ text:item.text, size:22, font:'Arial', color:C.BODY })], spacing:{ before:50, after:50 } }));

        } else if (item.t === 'cb') {
          children.push(new Paragraph({ children:[
            new TextRun({ text:'\u2610  ', size:22, font:'Arial', color:C.NAVY }),
            new TextRun({ text:item.text, size:22, font:'Arial', color:C.BODY }),
          ], spacing:{ before:40, after:40 }, indent:{ left:360 } }));

        } else if (item.t === 'table' && item.rows && item.rows.length) {
          const cols = item.rows[0].length || 1;
          const cw   = Math.floor(9000 / cols);
          children.push(new Table({ width:{ size:9000, type:WidthType.DXA }, columnWidths:Array(cols).fill(cw),
            rows: item.rows.map((row, ri) => new TableRow({ tableHeader:ri===0,
              children: row.map(cell2 => new TableCell({ borders:cb, width:{ size:cw, type:WidthType.DXA },
                shading: ri===0?{ fill:C.NAVY, type:ShadingType.CLEAR }:ri%2===0?{ fill:C.LIGHT, type:ShadingType.CLEAR }:{ fill:C.WHITE, type:ShadingType.CLEAR },
                margins:{ top:90, bottom:90, left:140, right:140 },
                children:[new Paragraph({ children:[new TextRun({ text:String(cell2||''), size:20, font:'Arial', bold:ri===0, color:ri===0?C.WHITE:C.BODY })] })],
              })),
            })),
          }));
          children.push(new Paragraph({ children:[], spacing:{ before:100, after:0 } }));

        } else if (item.t === 'sig') {
          children.push(new Paragraph({ children:[], spacing:{ before:240 }, border:{ top:{ style:BorderStyle.SINGLE, size:4, color:C.BORD } } }));
          item.lines.forEach(line => {
            const pts = line.split(/\s{2,}/).filter(p => p.trim());
            children.push(new Paragraph({ children:pts.map(p => new TextRun({ text:p+'          ', size:20, font:'Arial', color:C.MUTED })), spacing:{ before:100, after:100 } }));
          });
        }
      }
    }

    children.push(new Paragraph({ children:[], spacing:{ before:320 } }));
    children.push(new Paragraph({ alignment:AlignmentType.CENTER, children:[new TextRun({ text:'COMPLYFIRST LTD  |  CONFIDENTIAL  |  complyfirst.co', size:16, font:'Arial', color:C.MUTED })], border:{ top:{ style:BorderStyle.SINGLE, size:4, color:C.BORD } }, spacing:{ before:100 } }));

    const doc = new Document({ styles:{ default:{ document:{ run:{ font:'Arial', size:22 } } } }, sections:[{ properties:{ page:{ size:{ width:11906, height:16838 }, margin:{ top:720, right:1080, bottom:1080, left:1080 } } }, children }] });
    const buf = await Packer.toBuffer(doc);
    return { ok:true, buffer:Array.from(buf) };
  } catch(e) { return { ok:false, error:e.message }; }
});

// ---------- IPC: make PDF ----------
ipcMain.handle('makePdf', async (_, { title, type, det, secs, ref, date }) => {
  try {
    const PDFDocument = require('pdfkit');
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const icon = fs.existsSync(iconPath) ? fs.readFileSync(iconPath) : null;

    const NAVY='#182457', TEAL='#41CFBA', MUTED='#6b7a99', TEXT='#2a3350', LIGHT='#eef1fa', BORD='#dde3f0', WHITE='#ffffff';

    const doc = new PDFDocument({ size:'A4', margin:50, info:{ Title:title, Author:'ComplyFirst Ltd' } });
    const chunks = []; doc.on('data', c => chunks.push(c));
    const PW = doc.page.width - 100;

    function addHeader() {
      if (icon) doc.image(icon, 50, 28, { width:18, height:18 });
      const lx = icon ? 74 : 50;
      doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold').text('comply', lx, 33, { continued:true })
         .font('Helvetica-Oblique').text('first  ', { continued:true })
         .font('Helvetica').fillColor(MUTED).text(title, { width:PW-80 });
      doc.moveTo(50,55).lineTo(50+PW,55).lineWidth(1.5).strokeColor(TEAL).stroke();
      doc.y = 68;
    }

    function checkPage() {
      if (doc.y > doc.page.height - 110) { doc.addPage(); addHeader(); }
    }

    // --- cover ---
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text(date, 50, 50, { continued:true, width:PW }).text('Ref: '+ref, { align:'right' });

    const LY = 72;
    if (icon) doc.image(icon, 50, LY, { width:32, height:32 });
    const LX = icon ? 90 : 50;
    doc.fontSize(18).fillColor(NAVY).font('Helvetica-Bold').text('comply', LX, LY+7, { continued:true }).font('Helvetica-Oblique').text('first');
    doc.fontSize(8).fillColor(MUTED).font('Helvetica').text('WELCOME TO COMPLYFIRST', 50, LY+48, { characterSpacing:1.5 });
    doc.fontSize(26).fillColor(NAVY).font('Helvetica-Bold').text(title, 50, LY+64, { width:PW });

    const TH = doc.heightOfString(title, { fontSize:26, width:PW });
    const NY = LY + 74 + TH;
    const NW = Math.min(doc.widthOfString(det.name, { fontSize:13 }) + 28, PW);
    doc.roundedRect(50, NY, NW, 28, 4).fillAndStroke(LIGHT, BORD);
    doc.fontSize(13).fillColor(NAVY).font('Helvetica-Bold').text(det.name, 64, NY+7);
    doc.fontSize(9).fillColor(MUTED).font('Helvetica')
       .text(det.role+'  |  '+det.dept+'  |  Start: '+det.start+'  |  Manager: '+det.manager, 50, NY+36, { width:PW });

    const DY = NY + 56;
    doc.moveTo(50,DY).lineTo(50+PW,DY).lineWidth(2.5).strokeColor(TEAL).stroke();
    doc.y = DY + 18;

    // --- body ---
    for (const sec of secs) {
      checkPage();
      if (sec.h) {
        doc.fontSize(9).fillColor(NAVY).font('Helvetica-Bold')
           .text(sec.h.toUpperCase(), 50, doc.y+12, { width:PW, characterSpacing:1 });
        const LB = doc.y + 4;
        doc.moveTo(50,LB).lineTo(50+PW,LB).lineWidth(1.5).strokeColor(TEAL).stroke();
        doc.y = LB + 10;
      }

      for (const item of sec.items) {
        checkPage();

        if (item.t === 'p') {
          // Split on URLs - make them clickable
          const urlRe = /(https?:\/\/[^\s]+)/g;
          const parts = item.text.split(urlRe);
          if (parts.length > 1) {
            let first = true;
            parts.forEach((part, idx) => {
              if (!part) return;
              urlRe.lastIndex = 0;
              const isUrl = urlRe.test(part);
              const more  = parts.slice(idx+1).some(p => p);
              const opts  = { continued:more, width:PW };
              if (isUrl) {
                opts.link = part; opts.underline = true;
                doc.fontSize(10).fillColor(TEAL).font('Helvetica')
                   .text(part, first?50:undefined, first?doc.y:undefined, opts);
              } else {
                doc.fontSize(10).fillColor(TEXT).font('Helvetica')
                   .text(part, first?50:undefined, first?doc.y:undefined, opts);
              }
              first = false;
            });
          } else {
            doc.fontSize(10).fillColor(TEXT).font('Helvetica').text(item.text, 50, doc.y, { width:PW });
          }
          doc.moveDown(0.35);

        } else if (item.t === 'cb') {
          const CY = doc.y;
          doc.rect(50, CY+1, 10, 10).lineWidth(1).strokeColor(BORD).stroke();
          doc.fontSize(10).fillColor(TEXT).font('Helvetica').text(item.text, 68, CY, { width:PW-18 });
          doc.moveDown(0.25);

        } else if (item.t === 'table' && item.rows && item.rows.length) {
          const cols = item.rows[0].length || 1;
          const CW = PW / cols;
          const RH = 20;
          item.rows.forEach((row, ri) => {
            checkPage();
            const RY = doc.y;
            row.forEach((cell, ci) => {
              const CX = 50 + ci*CW;
              if      (ri===0)   doc.rect(CX,RY,CW,RH).fillColor(NAVY).fill();
              else if (ri%2===0) doc.rect(CX,RY,CW,RH).fillColor(LIGHT).fill();
              doc.rect(CX,RY,CW,RH).lineWidth(0.5).strokeColor(BORD).stroke();
              doc.fontSize(9).fillColor(ri===0?WHITE:TEXT).font(ri===0?'Helvetica-Bold':'Helvetica')
                 .text(String(cell||''), CX+5, RY+5, { width:CW-10, height:RH-6, ellipsis:true });
            });
            doc.y = RY + RH;
          });
          doc.moveDown(0.6);

        } else if (item.t === 'sig') {
          doc.moveDown(0.8);
          doc.moveTo(50,doc.y).lineTo(50+PW,doc.y).lineWidth(0.5).strokeColor(BORD).stroke();
          doc.moveDown(0.4);
          item.lines.forEach(line => {
            const pts = line.split(/\s{2,}/).filter(p=>p.trim());
            const SW = PW / Math.max(pts.length,1);
            const SY = doc.y;
            pts.forEach((p,i) => {
              doc.moveTo(50+i*SW,SY+22).lineTo(50+i*SW+SW*0.8,SY+22).lineWidth(0.5).strokeColor(MUTED).stroke();
              doc.fontSize(8).fillColor(MUTED).font('Helvetica').text(p, 50+i*SW, SY+26, { width:SW*0.85 });
            });
            doc.y = SY + 40;
          });
        }
      }
    }

    // footer
    doc.moveDown(2);
    if (doc.y > doc.page.height - 70) doc.addPage();
    doc.moveTo(50,doc.y).lineTo(50+PW,doc.y).lineWidth(0.5).strokeColor(BORD).stroke();
    doc.moveDown(0.4);
    doc.fontSize(8).fillColor(MUTED).font('Helvetica')
       .text('COMPLYFIRST LTD  |  CONFIDENTIAL  |  complyfirst.co', 50, doc.y, { align:'center', width:PW });
    doc.end();

    return new Promise(res => {
      doc.on('end',  () => res({ ok:true, buffer:Array.from(Buffer.concat(chunks)) }));
      doc.on('error', e => res({ ok:false, error:e.message }));
    });
  } catch(e) { return { ok:false, error:e.message }; }
});
