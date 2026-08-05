const { execFile } = require('child_process');
const path = require('path');
const os = require('os');

// 教师产品资产库路径与 CLI 工作目录：与 ~/teacher 项目约定的固定位置一致
// （见 ai-writer.js 红线④注释、~/teacher/codex-skills/teacher-product-assets）。
const DEFAULT_DB_PATH = path.join(os.homedir(), 'teacher', 'publish-library', '.asset-db', 'assets.sqlite3');
const CLI_CWD = path.join(os.homedir(), 'teacher', 'codex-skills', 'teacher-product-assets');
const CLI_TIMEOUT_MS = 15000;

// 只读调用 teacher_product_assets CLI：note-match / product-find 内部都用
// connect_readonly() 打开资产库，不会触发 schema 迁移或任何写操作。
function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'python3',
      ['-m', 'teacher_product_assets.cli', ...args],
      { cwd: CLI_CWD, timeout: CLI_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const wrapped = new Error(
            `teacher_product_assets CLI 执行失败：${err.message}${stderr ? '\nstderr: ' + String(stderr).slice(0, 500) : ''}`
          );
          wrapped.reason = 'query_failed';
          return reject(wrapped);
        }
        try {
          resolve(JSON.parse(stdout));
        } catch (parseErr) {
          const wrapped = new Error(`teacher_product_assets CLI 输出不是合法 JSON：${parseErr.message}`);
          wrapped.reason = 'query_failed';
          reject(wrapped);
        }
      }
    );
  });
}

// 给定笔记目录绝对路径，返回该产品已登记的 artifact_key 数组。
// 查不到归属（未登记 / unlinked_note）或查询本身失败，都抛错并在 err.reason
// 上区分：'not_registered' | 'query_failed'，调用方按此 fail-closed（不设置
// availableArtifacts，validateGenerated 红线④对提到配套件的正文一律打回），
// 但可以用 reason 写出可排查的日志。
async function getAvailableArtifacts(noteDirPath, dbPath = DEFAULT_DB_PATH) {
  if (!noteDirPath || typeof noteDirPath !== 'string') {
    const err = new Error('缺少笔记目录路径，无法查询配套件清单');
    err.reason = 'query_failed';
    throw err;
  }

  const matchResult = await runCli(['note-match', '--db', dbPath, '--note-dir', noteDirPath]);

  if (matchResult.result_state !== 'already_registered' || !matchResult.existing_link) {
    const err = new Error(`笔记目录未在资产库登记归属（result_state=${matchResult.result_state}）：${noteDirPath}`);
    err.reason = 'not_registered';
    throw err;
  }

  const link = matchResult.existing_link;
  if (link.link_type !== 'linked') {
    const err = new Error(`笔记目录已登记为 unlinked_note（未关联具体产品）：${noteDirPath}`);
    err.reason = 'not_registered';
    throw err;
  }

  const productCode = link.product_code;
  if (!productCode) {
    const err = new Error(`账本记录 linked 但 product_code 为空，判定为查询异常：${noteDirPath}`);
    err.reason = 'query_failed';
    throw err;
  }

  const findResult = await runCli(['product-find', '--db', dbPath, '--query', productCode]);
  const candidate = Array.isArray(findResult.candidates)
    ? findResult.candidates.find(c => c.product_code === productCode)
    : null;

  if (!candidate) {
    const err = new Error(`product-find 未查到 product_code=${productCode} 对应产品，判定为查询异常`);
    err.reason = 'query_failed';
    throw err;
  }

  return Array.isArray(candidate.artifact_keys) ? candidate.artifact_keys : [];
}

module.exports = { getAvailableArtifacts, DEFAULT_DB_PATH };
