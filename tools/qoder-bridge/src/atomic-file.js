'use strict';

const fs = require('node:fs');

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A handle without FILE_SHARE_DELETE forbids rename but still allows writes;
// both the installer and the uninstaller need a way through such a lock.
function overwriteInPlace(file, data) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomic(file, data) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, data);
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      // Antivirus and the search indexer briefly hold freshly written files on
      // Windows; a rename over an existing archive is only retried for that.
      const transient = error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EBUSY';
      if (!transient) {
        fs.rmSync(temp, { force: true });
        throw error;
      }
      if (attempt >= 20) {
        fs.rmSync(temp, { force: true });
        if (error.code === 'EBUSY' || error.code === 'EPERM') {
          overwriteInPlace(file, data);
          return;
        }
        throw error;
      }
      sleepSync(250);
    }
  }
}

module.exports = { writeFileAtomic };
