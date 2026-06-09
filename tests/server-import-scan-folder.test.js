const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zhifa-scan-folder-'));
process.env.NOTE_PUBLISHER_CONFIG_DIR = path.join(tempRoot, 'config');
process.env.NOTE_PUBLISHER_DATA_DIR = path.join(tempRoot, 'data');

const { startServer, stopServer } = require('../src/server.js');

before(async () => {
  await startServer({ port: 3212, host: '127.0.0.1', silent: true });
});

after(async () => {
  await stopServer();
});

function requestJson({ method, urlPath, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 3212,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(raw || '{}') });
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function writeImage(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

test('scan-folder supports content group with direct note folders', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'direct-notes');
  writeImage(path.join(root, '中考语法', '001', '1.jpg'));
  writeImage(path.join(root, '中考语法', '002', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 1);
  assert.equal(response.body[0].topic, '中考语法');
  assert.equal(response.body[0].contentGroup, '中考语法');
  assert.equal(response.body[0].scanMode, 'multi');
  assert.deepEqual(
    response.body[0].notes.map(note => note.folderName),
    ['001', '002']
  );
  assert.deepEqual(
    response.body[0].notes.map(note => note.contentGroup),
    ['中考语法', '中考语法']
  );
});

test('scan-folder supports ppt topic note folders and shared covers', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'ppt-topic-notes');
  writeImage(path.join(root, '中考语法', '七下语法', 'cover.jpg'));
  writeImage(path.join(root, '中考语法', '七下语法', '封面.jpg'));
  writeImage(path.join(root, '中考语法', '七下语法', '001', '1.jpg'));
  writeImage(path.join(root, '中考语法', '七下语法', '002', '0.jpg'));
  writeImage(path.join(root, '中考语法', '七下语法', '002', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 1);
  const group = response.body[0];
  assert.equal(group.topic, '中考语法');
  assert.equal(group.contentGroup, '中考语法');
  assert.equal(group.scanMode, 'multi');
  assert.equal(group.notes.length, 2);

  const firstNote = group.notes.find(note => note.folderName === '001');
  assert.ok(firstNote);
  assert.equal(firstNote.contentGroup, '中考语法');
  assert.equal(firstNote.accountGroup, '中考语法');
  assert.equal(firstNote.pptTopic, '七下语法');
  assert.equal(firstNote.noteTitle, '001');
  assert.equal(firstNote.noteKey, '中考语法/七下语法/001');
  assert.equal(firstNote.images[0].name, 'cover.jpg');
  assert.equal(firstNote.firstImagePath, firstNote.images[0].path);
  assert.match(firstNote.warnings.join('\n'), /共享封面候选超过 1 个/);

  const secondNote = group.notes.find(note => note.folderName === '002');
  assert.ok(secondNote);
  assert.equal(secondNote.images[0].name, '0.jpg');
  assert.equal(secondNote.firstImagePath, secondNote.images[0].path);
});

test('scan-folder treats 0(1) style root covers as shared covers for ppt topic notes', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'ppt-topic-macos-cover-variants');
  writeImage(path.join(root, '教务资料', '小升初总复习专项_语文剧本杀', '0(1).jpg'));
  writeImage(path.join(root, '教务资料', '小升初总复习专项_语文剧本杀', '0(2).jpg'));
  writeImage(path.join(root, '教务资料', '小升初总复习专项_语文剧本杀', '1', '1.jpg'));
  writeImage(path.join(root, '教务资料', '小升初总复习专项_语文剧本杀', '11', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.length, 1);
  const group = response.body[0];
  assert.equal(group.topic, '教务资料');
  assert.equal(group.notes.length, 2);

  const firstNote = group.notes.find(note => note.folderName === '1');
  const secondNote = group.notes.find(note => note.folderName === '11');
  assert.ok(firstNote);
  assert.ok(secondNote);
  assert.equal(firstNote.pptTopic, '小升初总复习专项_语文剧本杀');
  assert.equal(secondNote.pptTopic, '小升初总复习专项_语文剧本杀');
  assert.equal(firstNote.images[0].name, '0(1).jpg');
  assert.equal(secondNote.images[0].name, '0(1).jpg');
  assert.match(firstNote.noteKey, /教务资料\/小升初总复习专项_语文剧本杀\/1/);
});

test('scan-folder expands ppt topic folders without shared root cover', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'ppt-topic-with-note-owned-covers');
  writeImage(path.join(root, '综合类', '中考数学考前指导', '7', '0.jpg'));
  writeImage(path.join(root, '综合类', '中考数学考前指导', '7', '1.jpg'));
  writeImage(path.join(root, '综合类', '中考数学考前指导', '8', '封面.jpg'));
  writeImage(path.join(root, '综合类', '中考数学考前指导', '8', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  const group = response.body[0];
  assert.equal(group.topic, '综合类');
  assert.deepEqual(
    group.notes.map(note => note.noteKey),
    ['综合类/中考数学考前指导/7', '综合类/中考数学考前指导/8']
  );
  assert.deepEqual(
    group.notes.map(note => note.pptTopic),
    ['中考数学考前指导', '中考数学考前指导']
  );
  assert.equal(group.notes[0].images[0].name, '0.jpg');
  assert.equal(group.notes[1].images[0].name, '封面.jpg');
});

test('scan-folder blocks mixed ppt topic root media and child note folders', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'ppt-topic-mixed-root-and-child-media');
  writeImage(path.join(root, '综合类', '中考数学考前指导', '1.jpg'));
  writeImage(path.join(root, '综合类', '中考数学考前指导', '7', '1.jpg'));
  writeImage(path.join(root, '综合类', '中考数学考前指导', '8', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.body.code, 'mixed_import_structure');
  assert.match(response.body.error, /综合类\/中考数学考前指导/);
});

test('scan-folder keeps nested image folders under ppt topic notes', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'ppt-topic-nested-images');
  writeImage(path.join(root, '教务资料', '期末家长会', 'cover.jpg'));
  writeImage(path.join(root, '教务资料', '期末家长会', '001', '图片', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  const note = response.body[0].notes[0];
  assert.equal(note.noteKey, '教务资料/期末家长会/001');
  assert.equal(note.images[0].name, 'cover.jpg');
  assert.equal(note.images[1].name, '1.jpg');
});

test('scan-folder keeps direct note folders with nested asset directory', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'direct-note-nested-assets');
  writeImage(path.join(root, '教务资料', '001', '课件截图', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  const note = response.body[0].notes[0];
  assert.equal(note.noteKey, '教务资料/001');
  assert.equal(note.pptTopic, '');
  assert.equal(note.images[0].name, '1.jpg');
});

test('scan-folder keeps direct note folders with numeric nested asset directory when no shared cover', { concurrency: false }, async (t) => {
  const root = path.join(tempRoot, 'direct-note-nested-number-assets');
  writeImage(path.join(root, '教务资料', '001', '1', '1.jpg'));

  const response = await requestJson({
    method: 'POST',
    urlPath: '/api/import/scan-folder',
    body: { folderPath: root },
  });

  assert.equal(response.statusCode, 200);
  const note = response.body[0].notes[0];
  assert.equal(note.noteKey, '教务资料/001');
  assert.equal(note.pptTopic, '');
  assert.equal(note.images[0].name, '1.jpg');
});
