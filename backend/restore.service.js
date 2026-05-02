const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const unzipper = require('unzipper');
const csv = require('fast-csv');

async function extractZip(zipPath, extractTo) {
  await fsp.mkdir(extractTo, { recursive: true });

  return new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: extractTo }))
      .on('close', resolve)
      .on('error', reject);
  });
}

function parseCsv(filePath) {
  return new Promise((resolve, reject) => {
    const rows = [];

    fs.createReadStream(filePath)
      .pipe(csv.parse({ headers: true }))
      .on('error', reject)
      .on('data', (row) => rows.push(row))
      .on('end', () => resolve(rows));
  });
}

function reviveTypes(row) {
  const result = {};

  for (const key of Object.keys(row)) {
    let value = row[key];

    if (value === '') {
    //   result[key] = null;
      continue;
    }

    // objects and arrays
    if (
        typeof value === 'string' &&
        (
            (value.trim().startsWith('[') && value.trim().endsWith(']')) ||
            (value.trim().startsWith('{') && value.trim().endsWith('}'))
        )
        ) {
        try {
            result[key] = JSON.parse(value);
            continue;
        } catch (e) {
            // keep original value if not valid JSON
        }
    }

    // date DD/MM/YYYY
    if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
      const [d, m, y] = value.split('/');
      result[key] = new Date(`${y}-${m}-${d}`);
      continue;
    }

    // number
    if (!isNaN(value) && value.trim() !== '') {
      result[key] = Number(value);
      continue;
    }

    result[key] = value;
  }

  return result;
}

async function runRestore({
  zipPath,
  config,
  getModel,
  tmpDir
}) {
  const extractDir = path.join(tmpDir, `restore_${Date.now()}`);

  await fsp.mkdir(extractDir, { recursive: true });

  try {
    await extractZip(zipPath, extractDir);

    const files = await fsp.readdir(extractDir);
    const results = [];

    for (const modelConfig of config.models) {
      const file = files.find(f => f === modelConfig.archiveName);

      if (!file) {
        results.push({
          model: modelConfig.modelName,
          status: 'missing'
        });
        continue;
      }

      const filePath = path.join(extractDir, file);
      const rows = await parseCsv(filePath);
      const Model = getModel(modelConfig.modelName);

      const docs = rows.map(reviveTypes);

      await Model.deleteMany({});
      await Model.insertMany(docs, { ordered: false });

      results.push({
        model: modelConfig.modelName,
        inserted: docs.length,
        status: 'restored'
      });
    }

    return {
      success: true,
      results
    };

  } finally {
    // ALWAYS cleanup
    await fsp.rm(extractDir, { recursive: true, force: true });
  }
}

module.exports = {
  runRestore
};