const backupService = require('./backup.service');
const restoreService = require('./restore.service');

module.exports = {
  runBackup: backupService.runBackup,
  runRestore: restoreService.runRestore
};