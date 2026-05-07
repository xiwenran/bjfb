const fs = require('fs');
const path = require('path');

function createInputError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function platformDirName(platform) {
  if (platform === 'xiaohongshu') return '小红书';
  if (platform === 'douyin') return '抖音';
  return String(platform || '未知平台');
}

function parseNoteKey(noteKey) {
  const value = String(noteKey || '').trim();
  const index = value.lastIndexOf('/');
  if (index <= 0 || index === value.length - 1) {
    throw createInputError(`无效 noteKey: ${value}`);
  }
  return {
    topic: value.slice(0, index),
    template: value.slice(index + 1),
  };
}

function countFiles(dirPath) {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) total += countFiles(fullPath);
    if (entry.isFile()) total += 1;
  }
  return total;
}

function copyNoteFolder(sourceDir, destinationDir) {
  if (fs.existsSync(destinationDir)) {
    return 0;
  }
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true, force: false, errorOnExist: true });
  return countFiles(destinationDir);
}

function ensureAbsoluteDir(dirPath, fieldName) {
  if (!dirPath || typeof dirPath !== 'string' || !path.isAbsolute(dirPath)) {
    throw createInputError(`${fieldName} 必须是绝对路径`);
  }
  return dirPath;
}

function archiveImportFolders(input) {
  const sourceRoot = ensureAbsoluteDir(input?.sourceDir, 'sourceDir');
  const targetRoot = ensureAbsoluteDir(input?.targetDir, 'targetDir');
  const schedule = Array.isArray(input?.schedule) ? input.schedule : [];
  const unscheduled = Array.isArray(input?.unscheduled) ? input.unscheduled : [];

  if (!fs.existsSync(sourceRoot) || !fs.statSync(sourceRoot).isDirectory()) {
    throw createInputError(`sourceDir 不存在或不是目录: ${sourceRoot}`);
  }
  fs.mkdirSync(targetRoot, { recursive: true });

  const errors = [];
  let arrangedCount = 0;
  let unscheduledCount = 0;
  let totalFiles = 0;
  const arrangedDestinations = new Set();

  for (const item of schedule) {
    try {
      const { topic, template } = parseNoteKey(item?.noteKey);
      const destination = path.join(targetRoot, '已安排', platformDirName(item?.platform), topic, template);
      if (arrangedDestinations.has(destination)) continue;
      arrangedDestinations.add(destination);

      const source = path.join(sourceRoot, topic, template);
      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        errors.push(`${item?.noteKey || ''}: 源目录不存在`);
        continue;
      }
      totalFiles += copyNoteFolder(source, destination);
      arrangedCount += 1;
    } catch (error) {
      errors.push(error.message);
    }
  }

  const seenUnscheduled = new Set();
  for (const noteKey of unscheduled) {
    try {
      if (seenUnscheduled.has(noteKey)) continue;
      seenUnscheduled.add(noteKey);
      const { topic, template } = parseNoteKey(noteKey);
      const source = path.join(sourceRoot, topic, template);
      const destination = path.join(targetRoot, '未安排', topic, template);

      if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
        errors.push(`${noteKey}: 源目录不存在`);
        continue;
      }
      totalFiles += copyNoteFolder(source, destination);
      unscheduledCount += 1;
    } catch (error) {
      errors.push(error.message);
    }
  }

  return {
    arrangedCount,
    unscheduledCount,
    totalFiles,
    errors,
  };
}

module.exports = {
  archiveImportFolders,
};
