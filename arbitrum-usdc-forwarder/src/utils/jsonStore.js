'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny synchronous JSON file store. Used for two small, low-frequency-write
 * pieces of state (processed tx hashes, last scanned block), so sync fs
 * calls are simpler and safer here than adding a database dependency.
 */
class JsonStore {
  constructor(filePath, defaultValue) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!fs.existsSync(filePath)) {
      this.data = defaultValue;
      this._flush();
    } else {
      try {
        this.data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        // Corrupt file — fall back to default rather than crash-looping.
        this.data = defaultValue;
        this._flush();
      }
    }
  }

  get() {
    return this.data;
  }

  set(value) {
    this.data = value;
    this._flush();
  }

  _flush() {
    // Atomic-ish write: write to temp file then rename, to avoid leaving a
    // half-written/corrupt file if the process dies mid-write.
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmpPath, this.filePath);
  }
}

module.exports = { JsonStore };
