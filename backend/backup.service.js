const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const moment = require('moment');
const csv = require('fast-csv');
const archiver = require('archiver');

function formatDateForCsv(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${day}/${month}/${year}`;
}

function isDateLikeString(value) {
  if (typeof value !== 'string') {
    return false;
  }

  return (
    /^\d{4}-\d{2}-\d{2}T/.test(value) ||
    /^[A-Z][a-z]{2} [A-Z][a-z]{2} \d{2} \d{4}/.test(value)
  );
}

function normalizeCsvRow(rawRow) {
  const row = { ...(rawRow || {}) };

  for (const key of Object.keys(row)) {
    if (Array.isArray(row[key])) {
      row[key] = row[key].some(item => item && typeof item === 'object')
        ? JSON.stringify(row[key])
        : row[key].join(',');
    }

    if (
      row[key] &&
      typeof row[key] === 'object' &&
      !(row[key] instanceof Date) &&
      key !== '_id'
    ) {
      row[key] = JSON.stringify(row[key]);
    }

    if (row[key] instanceof Date || isDateLikeString(row[key])) {
      row[key] = formatDateForCsv(row[key]);
    }

    if (key === '_id' && row[key] && typeof row[key] === 'object') {
      row[key] = String(row[key]);
    }
  }

  return row;
}

function getHeadersFromAllRows(rows) {
  const headers = [];
  const seen = new Set();

  for (const row of rows || []) {
    for (const key of Object.keys(row || {})) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }

  return headers;
}

async function writeCsv(filePath, rows, headerOrder = null) {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(filePath);

    // UTF-8 BOM for Hebrew in Excel on Windows
    ws.write('\uFEFF', 'utf8');

    let headers = headerOrder;

    if (!headers && rows && rows.length > 0) {
      headers = getHeadersFromAllRows(rows);
    }

    const csvStream = csv.format({ headers: headers || true });

    ws.on('finish', resolve);
    ws.on('error', reject);
    csvStream.on('error', reject);

    csvStream.pipe(ws);

    for (const rawRow of rows || []) {
      csvStream.write(normalizeCsvRow(rawRow));
    }

    csvStream.end();
  });
}

async function zipFiles(zipPath, files) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);

    archive.pipe(output);

    for (const file of files) {
      archive.file(file.path, { name: file.name });
    }

    archive.finalize();
  });
}

async function cleanupFiles(paths) {
  await Promise.all(
    paths.map(filePath => fsp.unlink(filePath).catch(() => {}))
  );
}

async function runBackup({
  config,
  getModel,
  uploader,
  tmpDir
}) {
  const ts = moment().format('YYYY-MM-DD_HH-mm-ss');
  const folderId = config.driveFolderId;
  const zipPath = path.join(tmpDir, `${config.zipPrefix}-${ts}.zip`);

  let createdCsvFiles = [];

  await fsp.mkdir(tmpDir, { recursive: true });

  try {
    const datasets = await Promise.all(
      config.models.map(async (modelConfig) => {
        const Model = getModel(modelConfig.modelName);
        const rows = await Model.find().lean();

        return {
          ...modelConfig,
          rows,
          count: rows.length
        };
      })
    );

    createdCsvFiles = await Promise.all(
      datasets.map(async (dataset) => {
        const csvFilename = `${dataset.key}-${ts}.csv`;
        const csvPath = path.join(tmpDir, csvFilename);

        await writeCsv(csvPath, dataset.rows, dataset.headers);

        return {
          path: csvPath,
          name: dataset.archiveName
        };
      })
    );

    await zipFiles(zipPath, createdCsvFiles);

    const uploadRes = await uploader(zipPath, folderId);

    await cleanupFiles([...createdCsvFiles.map(f => f.path), zipPath]);

    return {
      success: true,
      link: uploadRes.webViewLink,
      fileId: uploadRes.id,
      file: { filename: path.basename(zipPath) },
      models: datasets.map(d => ({
        key: d.key,
        count: d.count
      }))
    };
  } catch (error) {
    const cleanupPaths = createdCsvFiles.map(f => f.path);

    if (fs.existsSync(zipPath)) {
      cleanupPaths.push(zipPath);
    }

    await cleanupFiles(cleanupPaths);
    throw error;
  }
}

module.exports = {
  runBackup
};