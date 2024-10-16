import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { createReadStream, stat } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { DeflateRaw, crc32, deflateRaw } from 'node:zlib';

/** ZIP64 end of central directory record size */
const ZIP64_EOCDR_SIZE = 56;

/** ZIP64 end of central directory locator size */
const ZIP64_EOCDL_SIZE = 20;

/** End of central directory record size */
const EOCDR_SIZE = 22;

const EMPTY_BUFFER = Buffer.allocUnsafe(0);

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const VERSION_NEEDED_TO_EXTRACT_UTF8 = 20;
const VERSION_NEEDED_TO_EXTRACT_ZIP64 = 45;
const VERSION_MADE_BY = (3 << 8) | 63; // 3 = unix. 63 = spec version 6.3
const FILE_NAME_IS_UTF8 = 1 << 11;
const UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;

const DATA_DESCRIPTOR_SIZE = 16;
const ZIP64_DATA_DESCRIPTOR_SIZE = 24;

/** Central directory record fixed size */
const CDR_FIXED_SIZE = 46;

/** ZIP64 extended information extra field size */
const ZIP64_EIEF_SIZE = 28;

class ByteCounter extends Transform {
  byteCount = 0;

  _transform(chunk, encoding, callback) {
    this.byteCount += chunk.length;
    callback(null, chunk);
  }
}

class Crc32Watcher extends Transform {
  crc32 = 0;

  _transform(chunk, encoding, callback) {
    this.crc32 = crc32(chunk, this.crc32);
    callback(null, chunk);
  }
}

/**
 * @typedef {Object} Options
 * @property {?Date} [mtime]
 * @property {?number} [mode]
 * @property {?boolean} [compress]
 * @property {?boolean} [forceZip64Format]
 * @property {?(Buffer|string)} [fileComment]
 * @property {?number} [size]
 */

// this class is not part of the public API
class Entry {
  static WAITING_FOR_METADATA = 0;
  static READY_TO_PUMP_FILE_DATA = 1;
  static FILE_DATA_IN_PROGRESS = 2;
  static FILE_DATA_DONE = 3;

  /**
   * @param {string} metadataPath
   * @param {boolean} isDirectory
   * @param {Options} options
   */
  constructor(metadataPath, isDirectory, options) {
    const utf8FileName = Buffer.from(metadataPath);
    this.utf8FileName = utf8FileName;
    if (utf8FileName.length > 0xffff) {
      throw new Error(`utf8 file name too long. ${utf8FileName.length} > 65535`);
    }
    this.isDirectory = isDirectory;
    this.state = Entry.WAITING_FOR_METADATA;
    this.setLastModDate(options.mtime ?? new Date());
    this.setFileAttributesMode(options.mode ?? (isDirectory ? 0o40775 : 0o100664));
    if (isDirectory) {
      this.crcAndFileSizeKnown = true;
      this.crc32 = 0;
      this.uncompressedSize = 0;
      this.compressedSize = 0;
    } else {
      // unknown so far
      this.crcAndFileSizeKnown = false;
      this.crc32 = null;
      this.uncompressedSize = options.size ?? null;
      this.compressedSize = null;
    }
    if (isDirectory) {
      this.compress = false;
    } else {
      // default is true
      this.compress = (options.compress != null) ? !!options.compress : true;
    }
    this.forceZip64Format = !!options.forceZip64Format;
    const fileComment = options.fileComment;
    if (fileComment) {
      const fileCommentBuffer = (typeof fileComment === 'string') ? Buffer.from(fileComment, 'utf8') : fileComment;
      // It should be a Buffer
      this.fileComment = fileCommentBuffer;
      if (fileCommentBuffer.length > 0xffff) {
        throw new Error('fileComment is too large');
      }
    } else {
      // no comment.
      this.fileComment = EMPTY_BUFFER;
    }
  }

  /**
   * @param {Date} date
   */
  setLastModDate(date) {
    let dosDate = 0;
    dosDate |= date.getDate() & 0x1f; // 1-31
    dosDate |= ((date.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
    dosDate |= ((date.getFullYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108
  
    let dosTime = 0;
    dosTime |= Math.floor(date.getSeconds() / 2); // 0-59, 0-29 (lose odd numbers)
    dosTime |= (date.getMinutes() & 0x3f) << 5; // 0-59
    dosTime |= (date.getHours() & 0x1f) << 11; // 0-23

    this.lastModFileTime = dosTime;
    this.lastModFileDate = dosDate;
  }

  /**
   * @param {number} mode
   */
  setFileAttributesMode(mode) {
    if ((mode & 0xffff) !== mode) {
      throw new Error(`invalid mode. expected: 0 <= ${mode} <= 65535`);
    }
    // http://unix.stackexchange.com/questions/14705/the-zip-formats-external-file-attribute/14727#14727
    this.externalFileAttributes = (mode << 16) >>> 0;
  }

  /**
   * @param {Function} doFileDataPump
   */
  setFileDataPumpFunction(doFileDataPump) {
    // doFileDataPump() should not call pumpEntries() directly. see issue #9.
    this.doFileDataPump = doFileDataPump;
    this.state = Entry.READY_TO_PUMP_FILE_DATA;
  }

  /**
   * @returns {boolean}
   */
  useZip64Format() {
    return (
      (this.forceZip64Format) ||
      (this.uncompressedSize != null && this.uncompressedSize > 0xfffffffe) ||
      (this.compressedSize != null && this.compressedSize > 0xfffffffe) ||
      (this.relativeOffsetOfLocalHeader != null && this.relativeOffsetOfLocalHeader > 0xfffffffe)
    );
  }

  /**
   * @returns {Buffer}
   */
  getLocalFileHeader() {
    let crc32 = 0;
    let compressedSize = 0;
    let uncompressedSize = 0;
    if (this.crcAndFileSizeKnown) {
      crc32 = this.crc32;
      compressedSize = this.compressedSize;
      uncompressedSize = this.uncompressedSize;
    }

    const fixedSizeStuff = Buffer.allocUnsafe(LOCAL_FILE_HEADER_FIXED_SIZE);
    let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
    if (!this.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

    // local file header signature     4 bytes  (0x04034b50)
    fixedSizeStuff.writeUInt32LE(0x04034b50, 0);
    // version needed to extract       2 bytes
    fixedSizeStuff.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_UTF8, 4);
    // general purpose bit flag        2 bytes
    fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 6);
    // compression method              2 bytes
    fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 8);
    // last mod file time              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 10);
    // last mod file date              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 12);
    // crc-32                          4 bytes
    fixedSizeStuff.writeUInt32LE(crc32, 14);
    // compressed size                 4 bytes
    fixedSizeStuff.writeUInt32LE(compressedSize, 18);
    // uncompressed size               4 bytes
    fixedSizeStuff.writeUInt32LE(uncompressedSize, 22);
    // file name length                2 bytes
    fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 26);
    // extra field length              2 bytes
    fixedSizeStuff.writeUInt16LE(0, 28);
    return Buffer.concat([
      fixedSizeStuff,
      // file name (variable size)
      this.utf8FileName,
      // extra field (variable size)
      // no extra fields
    ]);
  }

  /**
   * @returns {Buffer}
   */
  getDataDescriptor() {
    if (this.crcAndFileSizeKnown) {
      // the Mac Archive Utility requires this not be present unless we set general purpose bit 3
      return EMPTY_BUFFER;
    }
    if (!this.useZip64Format()) {
      const buffer = Buffer.allocUnsafe(DATA_DESCRIPTOR_SIZE);
      // optional signature (required according to Archive Utility)
      buffer.writeUInt32LE(0x08074b50, 0);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 4);
      // compressed size                 4 bytes
      buffer.writeUInt32LE(this.compressedSize, 8);
      // uncompressed size               4 bytes
      buffer.writeUInt32LE(this.uncompressedSize, 12);
      return buffer;
    } else {
      // ZIP64 format
      const buffer = Buffer.allocUnsafe(ZIP64_DATA_DESCRIPTOR_SIZE);
      // optional signature (unknown if anyone cares about this)
      buffer.writeUInt32LE(0x08074b50, 0);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 4);
      // compressed size                 8 bytes
      buffer.writeBigUInt64LE(BigInt(this.compressedSize), 8);
      // uncompressed size               8 bytes
      buffer.writeBigUInt64LE(BigInt(this.uncompressedSize), 16);
      return buffer;
    }
  }

  /**
   * @returns {Buffer}
   */
  getCentralDirectoryRecord() {
    const fixedSizeStuff = Buffer.allocUnsafe(CDR_FIXED_SIZE);
    let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
    if (!this.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;

    let normalCompressedSize = this.compressedSize;
    let normalUncompressedSize = this.uncompressedSize;
    let normalRelativeOffsetOfLocalHeader = this.relativeOffsetOfLocalHeader;
    let versionNeededToExtract;
    let zeiefBuffer;
    if (this.useZip64Format()) {
      normalCompressedSize = 0xffffffff;
      normalUncompressedSize = 0xffffffff;
      normalRelativeOffsetOfLocalHeader = 0xffffffff;
      versionNeededToExtract = VERSION_NEEDED_TO_EXTRACT_ZIP64;

      // ZIP64 extended information extra field
      zeiefBuffer = Buffer.allocUnsafe(ZIP64_EIEF_SIZE);
      // 0x0001                  2 bytes    Tag for this "extra" block type
      zeiefBuffer.writeUInt16LE(0x0001, 0);
      // Size                    2 bytes    Size of this "extra" block
      zeiefBuffer.writeUInt16LE(ZIP64_EIEF_SIZE - 4, 2);
      // Original Size           8 bytes    Original uncompressed file size
      zeiefBuffer.writeBigUInt64LE(BigInt(this.uncompressedSize), 4);
      // Compressed Size         8 bytes    Size of compressed data
      zeiefBuffer.writeBigUInt64LE(BigInt(this.compressedSize), 12);
      // Relative Header Offset  8 bytes    Offset of local header record
      zeiefBuffer.writeBigUInt64LE(BigInt(this.relativeOffsetOfLocalHeader), 20);
      // Disk Start Number       4 bytes    Number of the disk on which this file starts
      // (omit)
    } else {
      versionNeededToExtract = VERSION_NEEDED_TO_EXTRACT_UTF8;
      zeiefBuffer = EMPTY_BUFFER;
    }

    // central file header signature   4 bytes  (0x02014b50)
    fixedSizeStuff.writeUInt32LE(0x02014b50, 0);
    // version made by                 2 bytes
    fixedSizeStuff.writeUInt16LE(VERSION_MADE_BY, 4);
    // version needed to extract       2 bytes
    fixedSizeStuff.writeUInt16LE(versionNeededToExtract, 6);
    // general purpose bit flag        2 bytes
    fixedSizeStuff.writeUInt16LE(generalPurposeBitFlag, 8);
    // compression method              2 bytes
    fixedSizeStuff.writeUInt16LE(this.getCompressionMethod(), 10);
    // last mod file time              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileTime, 12);
    // last mod file date              2 bytes
    fixedSizeStuff.writeUInt16LE(this.lastModFileDate, 14);
    // crc-32                          4 bytes
    fixedSizeStuff.writeUInt32LE(this.crc32, 16);
    // compressed size                 4 bytes
    fixedSizeStuff.writeUInt32LE(normalCompressedSize, 20);
    // uncompressed size               4 bytes
    fixedSizeStuff.writeUInt32LE(normalUncompressedSize, 24);
    // file name length                2 bytes
    fixedSizeStuff.writeUInt16LE(this.utf8FileName.length, 28);
    // extra field length              2 bytes
    fixedSizeStuff.writeUInt16LE(zeiefBuffer.length, 30);
    // file comment length             2 bytes
    fixedSizeStuff.writeUInt16LE(this.fileComment.length, 32);
    // disk number start               2 bytes
    fixedSizeStuff.writeUInt16LE(0, 34);
    // internal file attributes        2 bytes
    fixedSizeStuff.writeUInt16LE(0, 36);
    // external file attributes        4 bytes
    fixedSizeStuff.writeUInt32LE(this.externalFileAttributes, 38);
    // relative offset of local header 4 bytes
    fixedSizeStuff.writeUInt32LE(normalRelativeOffsetOfLocalHeader, 42);

    return Buffer.concat([
      fixedSizeStuff,
      // file name (variable size)
      this.utf8FileName,
      // extra field (variable size)
      zeiefBuffer,
      // file comment (variable size)
      this.fileComment,
    ]);
  }

  /**
   * @returns {0|8}
   */
  getCompressionMethod() {
    const NO_COMPRESSION = 0;
    const DEFLATE_COMPRESSION = 8;
    return this.compress ? DEFLATE_COMPRESSION : NO_COMPRESSION;
  }
}

const eocdrSignatureBuffer = Buffer.of(0x50, 0x4b, 0x05, 0x06);

class ZipFile extends EventEmitter {
  outputStream = new PassThrough();
  entries = [];
  outputStreamCursor = 0;
  ended = false; // .end() sets this
  allDone = false; // set when we've written the last bytes
  forceZip64Eocd = false; // configurable in .end()

  /**
   * @param {string} realPath
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addFile(realPath, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    options ??= {};

    const entry = new Entry(metadataPath, false, options);
    this.entries.push(entry);
    stat(realPath, (err, stats) => {
      if (err) return this.emit('error', err);
      if (!stats.isFile()) {
        return this.emit('error', new Error(`not a file: ${realPath}`));
      }
      entry.uncompressedSize = stats.size;
      if (options.mtime == null) entry.setLastModDate(stats.mtime);
      if (options.mode == null) entry.setFileAttributesMode(stats.mode);
      entry.setFileDataPumpFunction(() => {
        const readStream = createReadStream(realPath);
        entry.state = Entry.FILE_DATA_IN_PROGRESS;
        readStream.on('error', (err) => {
          this.emit('error', err);
        });
        pumpFileDataReadStream(this, entry, readStream);
      });
      pumpEntries(this);
    });
  }

  /**
   * @param {ReadStream} readStream
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addReadStream(readStream, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    options ??= {};
    const entry = new Entry(metadataPath, false, options);
    this.entries.push(entry);
    entry.setFileDataPumpFunction(() => {
      entry.state = Entry.FILE_DATA_IN_PROGRESS;
      pumpFileDataReadStream(this, entry, readStream);
    });
    pumpEntries(this);
  }

  /**
   * @param {Buffer} buffer
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addBuffer(buffer, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    const bufferLength = buffer.length;
    if (bufferLength > 0x3fffffff) {
      throw new Error(`buffer too large: ${bufferLength} > 1073741823`);
    }
    options ??= {};
    if (options.size != null) throw new Error('options.size not allowed');
    const entry = new Entry(metadataPath, false, options);
    const setCompressedBuffer = (compressedBuffer) => {
      entry.compressedSize = compressedBuffer.length;
      entry.setFileDataPumpFunction(() => {
        writeToOutputStream(this, compressedBuffer);
        writeToOutputStream(this, entry.getDataDescriptor());
        entry.state = Entry.FILE_DATA_DONE;

        // don't call pumpEntries() recursively.
        // (also, don't call process.nextTick recursively.)
        setImmediate(() => {
          pumpEntries(this);
        });
      });
      pumpEntries(this);
    };
    entry.uncompressedSize = bufferLength;
    entry.crc32 = crc32(buffer);
    entry.crcAndFileSizeKnown = true;
    this.entries.push(entry);
    if (!entry.compress) {
      setCompressedBuffer(buffer);
    } else {
      deflateRaw(buffer, (err, compressedBuffer) => {
        setCompressedBuffer(compressedBuffer);
      });
    }
  }

  /**
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addEmptyDirectory(metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, true);
    options ??= {};
    if (options.size != null) throw new Error('options.size not allowed');
    if (options.compress != null) throw new Error('options.compress not allowed');
    const entry = new Entry(metadataPath, true, options);
    this.entries.push(entry);
    entry.setFileDataPumpFunction(() => {
      writeToOutputStream(this, entry.getDataDescriptor());
      entry.state = Entry.FILE_DATA_DONE;
      pumpEntries(this);
    });
    pumpEntries(this);
  }

  /**
   * @param {?Function|Options} [options]
   * @param {?Function} [finalSizeCallback]
   */
  end(options, finalSizeCallback) {
    if (this.ended) return;
    if (typeof options === 'function') {
      finalSizeCallback = options;
      options = {};
    } else {
      options ??= {};
    }
    this.ended = true;
    this.finalSizeCallback = finalSizeCallback;
    this.forceZip64Eocd = !!options.forceZip64Format;

    const comment = options.comment;
    if (comment) {
      // It should be a Buffer
      this.comment = comment;
      if (comment.length > 0xffff) {
        throw new Error('comment is too large');
      }
      // gotta check for this, because the zipfile format is actually ambiguous.
      if (comment.includes(eocdrSignatureBuffer)) {
        throw new Error('comment contains end of central directory record signature');
      }
    } else {
      // no comment.
      this.comment = EMPTY_BUFFER;
    }
  
    pumpEntries(this);
  }
}

/**
 * @param {ZipFile} zipfile
 * @param {Buffer} buffer
 */
function writeToOutputStream(zipfile, buffer) {
  zipfile.outputStream.write(buffer);
  zipfile.outputStreamCursor += buffer.length;
}

/**
 * @param {ZipFile} zipfile
 * @param {Entry} entry
 * @param {ReadStream} readStream
 */
function pumpFileDataReadStream(zipfile, entry, readStream) {
  const crc32Watcher = new Crc32Watcher();
  const uncompressedSizeCounter = new ByteCounter();
  const compressor = entry.compress ? new DeflateRaw() : new PassThrough();
  const compressedSizeCounter = new ByteCounter();
  readStream.pipe(crc32Watcher)
            .pipe(uncompressedSizeCounter)
            .pipe(compressor)
            .pipe(compressedSizeCounter)
            .pipe(zipfile.outputStream, { end: false });
  compressedSizeCounter.on('end', () => {
    entry.crc32 = crc32Watcher.crc32;
    if (entry.uncompressedSize == null) {
      entry.uncompressedSize = uncompressedSizeCounter.byteCount;
    } else if (entry.uncompressedSize !== uncompressedSizeCounter.byteCount) {
      return zipfile.emit('error', new Error('file data stream has unexpected number of bytes'));
    }
    entry.compressedSize = compressedSizeCounter.byteCount;
    zipfile.outputStreamCursor += entry.compressedSize;
    writeToOutputStream(zipfile, entry.getDataDescriptor());
    entry.state = Entry.FILE_DATA_DONE;
    pumpEntries(zipfile);
  });
}

/**
 * @param {ZipFile} zipfile
 */
function getFirstNotDoneEntry(zipfile) {
  const entries = zipfile.entries;
  const entriesLength = entries.length;
  for (let i = 0; i < entriesLength; ++i) {
    const entry = entries[i];
    if (entry.state < Entry.FILE_DATA_DONE) return entry;
  }
  return null;
}

/**
 * @param {ZipFile} zipfile
 */
function pumpEntries(zipfile) {
  if (zipfile.allDone) return;
  // first check if finalSize is finally known
  if (zipfile.ended && zipfile.finalSizeCallback != null) {
    const finalSize = calculateFinalSize(zipfile);
    if (finalSize != null) {
      // we have an answer
      zipfile.finalSizeCallback(finalSize);
      zipfile.finalSizeCallback = null;
    }
  }

  // pump entries
  const entry = getFirstNotDoneEntry(zipfile);
  if (entry != null) {
    // this entry is not done yet
    const entryState = entry.state;
    if (entryState < Entry.READY_TO_PUMP_FILE_DATA) return; // input file not open yet
    if (entryState === Entry.FILE_DATA_IN_PROGRESS) return; // we'll get there
    // start with local file header
    entry.relativeOffsetOfLocalHeader = zipfile.outputStreamCursor;
    writeToOutputStream(zipfile, entry.getLocalFileHeader());
    entry.doFileDataPump();
  } else if (zipfile.ended) {
    // all cought up on writing entries
    const entries = zipfile.entries;
    const entriesLength = entries.length;
    // head for the exit
    zipfile.offsetOfStartOfCentralDirectory = zipfile.outputStreamCursor;
    for (let i = 0; i < entriesLength; ++i) {
      const centralDirectoryRecord = entries[i].getCentralDirectoryRecord();
      writeToOutputStream(zipfile, centralDirectoryRecord);
    }
    writeToOutputStream(zipfile, getEndOfCentralDirectoryRecord(zipfile));
    zipfile.outputStream.end();
    zipfile.allDone = true;
  }
}

/**
 * @param {ZipFile} zipfile
 * @returns {number|null}
 */
function calculateFinalSize(zipfile) {
  const entries = zipfile.entries;
  const entriesLength = entries.length;
  let pretendOutputCursor = 0;
  let centralDirectorySize = 0;
  for (let i = 0; i < entriesLength; ++i) {
    const entry = entries[i];
    // compression is too hard to predict
    if (entry.compress) return -1;
    if (entry.state >= Entry.READY_TO_PUMP_FILE_DATA) {
      // if addReadStream was called without providing the size, we can't predict the final size
      if (entry.uncompressedSize == null) return -1;
    } else if (entry.uncompressedSize == null) {
      // if we're still waiting for fs.stat, we might learn the size someday
      return null;
    }
    // we know this for sure, and this is important to know if we need ZIP64 format.
    entry.relativeOffsetOfLocalHeader = pretendOutputCursor;
    const useZip64Format = entry.useZip64Format();

    pretendOutputCursor += LOCAL_FILE_HEADER_FIXED_SIZE + entry.utf8FileName.length;
    pretendOutputCursor += entry.uncompressedSize;

    if (!entry.crcAndFileSizeKnown) {
      // use a data descriptor
      pretendOutputCursor += useZip64Format ? ZIP64_DATA_DESCRIPTOR_SIZE : DATA_DESCRIPTOR_SIZE;
    }

    centralDirectorySize += CDR_FIXED_SIZE + entry.utf8FileName.length + entry.fileComment.length;
    if (useZip64Format) {
      centralDirectorySize += ZIP64_EIEF_SIZE;
    }
  }

  let endOfCentralDirectorySize = 0;
  if (zipfile.forceZip64Eocd ||
      entriesLength >= 0xffff ||
      centralDirectorySize >= 0xffff ||
      pretendOutputCursor >= 0xffffffff) {
    // use zip64 end of central directory stuff
    endOfCentralDirectorySize += ZIP64_EOCDR_SIZE + ZIP64_EOCDL_SIZE;
  }
  endOfCentralDirectorySize += EOCDR_SIZE + zipfile.comment.length;
  return pretendOutputCursor + centralDirectorySize + endOfCentralDirectorySize;
}

/**
 * @param {ZipFile} zipfile
 * @returns {Buffer}
 */
function getEndOfCentralDirectoryRecord(zipfile) {
  const entriesLength = zipfile.entries.length;
  let needZip64Format = false;
  let normalEntriesLength = entriesLength;
  if (zipfile.forceZip64Eocd || entriesLength >= 0xffff) {
    normalEntriesLength = 0xffff;
    needZip64Format = true;
  }

  const sizeOfCentralDirectory = zipfile.outputStreamCursor - zipfile.offsetOfStartOfCentralDirectory;
  let normalSizeOfCentralDirectory = sizeOfCentralDirectory;
  if (zipfile.forceZip64Eocd || sizeOfCentralDirectory >= 0xffffffff) {
    normalSizeOfCentralDirectory = 0xffffffff;
    needZip64Format = true;
  }

  let normalOffsetOfStartOfCentralDirectory = zipfile.offsetOfStartOfCentralDirectory;
  if (zipfile.forceZip64Eocd || zipfile.offsetOfStartOfCentralDirectory >= 0xffffffff) {
    normalOffsetOfStartOfCentralDirectory = 0xffffffff;
    needZip64Format = true;
  }

  const comment = zipfile.comment;
  const commentLength = comment.length;
  const eocdrBuffer = Buffer.allocUnsafe(EOCDR_SIZE + commentLength);
  // end of central dir signature                       4 bytes  (0x06054b50)
  eocdrBuffer.writeUInt32LE(0x06054b50, 0);
  // number of this disk                                2 bytes
  eocdrBuffer.writeUInt16LE(0, 4);
  // number of the disk with the start of the central directory  2 bytes
  eocdrBuffer.writeUInt16LE(0, 6);
  // total number of entries in the central directory on this disk  2 bytes
  eocdrBuffer.writeUInt16LE(normalEntriesLength, 8);
  // total number of entries in the central directory   2 bytes
  eocdrBuffer.writeUInt16LE(normalEntriesLength, 10);
  // size of the central directory                      4 bytes
  eocdrBuffer.writeUInt32LE(normalSizeOfCentralDirectory, 12);
  // offset of start of central directory with respect to the starting disk number  4 bytes
  eocdrBuffer.writeUInt32LE(normalOffsetOfStartOfCentralDirectory, 16);
  // .ZIP file comment length                           2 bytes
  eocdrBuffer.writeUInt16LE(commentLength, 20);
  // .ZIP file comment                                  (variable size)
  comment.copy(eocdrBuffer, 22);

  if (!needZip64Format) return eocdrBuffer;

  // ZIP64 format
  // ZIP64 End of Central Directory Record
  const zip64EocdrBuffer = Buffer.allocUnsafe(ZIP64_EOCDR_SIZE);
  // zip64 end of central dir signature                                             4 bytes  (0x06064b50)
  zip64EocdrBuffer.writeUInt32LE(0x06064b50, 0);
  // size of zip64 end of central directory record                                  8 bytes
  zip64EocdrBuffer.writeBigUInt64LE(BigInt(ZIP64_EOCDR_SIZE - 12), 4);
  // version made by                                                                2 bytes
  zip64EocdrBuffer.writeUInt16LE(VERSION_MADE_BY, 12);
  // version needed to extract                                                      2 bytes
  zip64EocdrBuffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_ZIP64, 14);
  // number of this disk                                                            4 bytes
  zip64EocdrBuffer.writeUInt32LE(0, 16);
  // number of the disk with the start of the central directory                     4 bytes
  zip64EocdrBuffer.writeUInt32LE(0, 20);
  // total number of entries in the central directory on this disk                  8 bytes
  zip64EocdrBuffer.writeBigUInt64LE(BigInt(entriesLength), 24);
  // total number of entries in the central directory                               8 bytes
  zip64EocdrBuffer.writeBigUInt64LE(BigInt(entriesLength), 32);
  // size of the central directory                                                  8 bytes
  zip64EocdrBuffer.writeBigUInt64LE(BigInt(sizeOfCentralDirectory), 40);
  // offset of start of central directory with respect to the starting disk number  8 bytes
  zip64EocdrBuffer.writeBigUInt64LE(BigInt(zipfile.offsetOfStartOfCentralDirectory), 48);
  // zip64 extensible data sector                                                   (variable size)
  // nothing in the zip64 extensible data sector

  // ZIP64 End of Central Directory Locator
  const zip64EocdlBuffer = Buffer.allocUnsafe(ZIP64_EOCDL_SIZE);
  // zip64 end of central dir locator signature                               4 bytes  (0x07064b50)
  zip64EocdlBuffer.writeUInt32LE(0x07064b50, 0);
  // number of the disk with the start of the zip64 end of central directory  4 bytes
  zip64EocdlBuffer.writeUInt32LE(0, 4);
  // relative offset of the zip64 end of central directory record             8 bytes
  zip64EocdlBuffer.writeBigUInt64LE(BigInt(zipfile.outputStreamCursor), 8);
  // total number of disks                                                    4 bytes
  zip64EocdlBuffer.writeUInt32LE(1, 16);

  return Buffer.concat([
    zip64EocdrBuffer,
    zip64EocdlBuffer,
    eocdrBuffer,
  ]);
}

/**
 * @param {string} metadataPath
 * @param {boolean} isDirectory
 * @returns {string}
 */
function validateMetadataPath(metadataPath, isDirectory) {
  if (metadataPath === '') throw new Error('empty metadataPath');
  metadataPath = metadataPath.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(metadataPath) || metadataPath.startsWith('/')) {
    throw new Error(`absolute path: ${metadataPath}`);
  }
  if (metadataPath.split('/').includes('..')) {
    throw new Error(`invalid relative path: ${metadataPath}`);
  }
  const looksLikeDirectory = metadataPath.endsWith('/');
  if (isDirectory) {
    // append a trailing '/' if necessary.
    if (!looksLikeDirectory) metadataPath += '/';
  } else if (looksLikeDirectory) {
    throw new Error(`file path cannot end with '/': ${metadataPath}`);
  }
  return metadataPath;
}

export { ZipFile };
