const path = require('path');
const fs = require('fs');
const fsp = require('fs').promises;
const moment = require('moment');

async function cleanupFiles(paths) {
  await Promise.all(
    paths.map(filePath => fsp.unlink(filePath).catch(() => {}))
  );
}

async function runBackup({
  config,
  getModel,
  uploader,
  backupUtils,
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

        await backupUtils.writeCsv(csvPath, dataset.rows, dataset.headers);

        return {
          path: csvPath,
          name: dataset.archiveName
        };
      })
    );

    await backupUtils.zipFiles(zipPath, createdCsvFiles);

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