import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { createReadStream, stat } from 'node:fs';
import { PassThrough, Transform } from 'node:stream';
import { DeflateRaw, crc32, deflateRaw } from 'node:zlib';

// Entry `state` field enum values
const ENTRY_WAITING_FOR_METADATA    = 0;
const ENTRY_READY_TO_PUMP_FILE_DATA = 1;
const ENTRY_FILE_DATA_IN_PROGRESS   = 2;
const ENTRY_FILE_DATA_DONE          = 3;

// Entry `compressionMethod` field enum values
const NO_COMPRESSION      = 0;
const DEFLATE_COMPRESSION = 8;

/** End of central directory record size        */ const EOCDR_SIZE       = 22;
/** ZIP64 end of central directory record size  */ const ZIP64_EOCDR_SIZE = 56;
/** ZIP64 end of central directory locator size */ const ZIP64_EOCDL_SIZE = 20;
/** Central directory record fixed size         */ const CDR_FIXED_SIZE   = 46;
/** ZIP64 extended information extra field size */ const ZIP64_EIEF_SIZE  = 28;

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const VERSION_NEEDED_TO_EXTRACT_UTF8 = 20;
const VERSION_NEEDED_TO_EXTRACT_ZIP64 = 45;
const VERSION_MADE_BY = (3 << 8) | 63; // 3 = unix. 63 = spec version 6.3
const FILE_NAME_IS_UTF8 = 1 << 11;
const UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;

const DATA_DESCRIPTOR_SIZE       = 16;
const ZIP64_DATA_DESCRIPTOR_SIZE = 24;

/** End of central directory record signature */
const EOCDR_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x05, 0x06);
const EMPTY_BUFFER = new Uint8Array(0);

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
 * @property {?Date|number} [mtime]
 * @property {?number} [mode]
 * @property {?boolean} [compress]
 * @property {?boolean} [forceZip64Format]
 * @property {?Buffer|Uint8Array} [fileComment]
 * @property {?number} [size]
 */

class Entry {
  /**
   * @param {string} metadataPath
   * @param {boolean} isDirectory
   * @param {Options} options
   */
  constructor(metadataPath, isDirectory, options) {
    const { mtime, fileComment } = options;
    const fileName = Buffer.from(metadataPath, 'utf8');
    const compress = isDirectory ? false : Boolean(options.compress ?? true);
    const isComment = (fileComment != null);

    if (fileName.length > 0xffff) {
      throw new Error(`utf8 file name too long. ${fileName.length} > 65535`);
    }

    if (!isComment) {
    } else if (!(fileComment instanceof Uint8Array)) {
      throw new Error('fileComment must be a Buffer/Uint8Array if it exists');
    } else if (fileComment.length > 0xffff) {
      throw new Error('fileComment is too large');
    }

    this.fileName = fileName;
    this.isDirectory = isDirectory;
    this.state = ENTRY_WAITING_FOR_METADATA;
    this.lastMod = (typeof mtime === 'number') ? mtime : dateToDosDateTime(mtime ?? new Date());
    this.setFileAttributesMode(options.mode ?? 0o000664, isDirectory);
    this.crcAndFileSizeKnown = isDirectory;
    this.crc32 = 0;
    this.uncompressedSize = isDirectory ? 0 : (options.size ?? -1);
    this.compressedSize = 0;
    this.compress = compress;
    this.compressionMethod = compress ? DEFLATE_COMPRESSION : NO_COMPRESSION;
    this.forceZip64Format = Boolean(options.forceZip64Format ?? false);
    this.relativeOffsetOfLocalHeader = 0;
    this.fileComment = isComment ? fileComment : EMPTY_BUFFER;
  }

  /**
   * @param {number} mode
   */
  setFileAttributesMode(mode, isDirectory) {
    if ((mode & 0xffff) !== mode) {
      throw new Error(`invalid mode. expected: 0 <= ${mode} <= 65535`);
    }
    if (isDirectory) {
      // https://github.com/thejoshwolfe/yazl/pull/59
      // Set executable bit on directories if any other bits are set for that user/group/all
      // Fixes creating unusable zip files on platforms that do not use an executable bit
      mode |= ((mode >> 1) | (mode >> 2)) & 0o000111;
      mode |= 0o040000; // S_IFDIR
    } else {
      mode |= 0o100000; // S_IFREG
    }
    // http://unix.stackexchange.com/questions/14705/the-zip-formats-external-file-attribute/14727#14727
    this.externalFileAttributes = (mode << 16) >>> 0;
  }

  /**
   * @param {() => void} doFileDataPump
   */
  setFileDataPumpFunction(doFileDataPump) {
    // doFileDataPump() should not call pumpEntries() directly. see issue #9.
    this.doFileDataPump = doFileDataPump;
    this.state = ENTRY_READY_TO_PUMP_FILE_DATA;
  }

  /**
   * @returns {boolean}
   */
  useZip64Format() {
    return (
      (this.forceZip64Format) ||
      (this.uncompressedSize > 0xfffffffe) ||
      (this.compressedSize > 0xfffffffe) ||
      (this.relativeOffsetOfLocalHeader > 0xfffffffe)
    );
  }

  /**
   * @returns {Buffer}
   */
  getLocalFileHeader() {
    const { fileName } = this;
    const fileNameLength = fileName.length;
    const buffer = Buffer.allocUnsafe(
      LOCAL_FILE_HEADER_FIXED_SIZE +
      fileNameLength     // file name   (variable size)
      // no extra fields // extra field (variable size)
    );

    let uncompressedSize = 0;
    let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
    if (this.crcAndFileSizeKnown) {
      uncompressedSize = this.uncompressedSize;
    } else {
      generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;
    }

    // local file header signature     4 bytes  (0x04034b50)
    buffer.writeUInt32LE(0x04034b50, 0);
    // version needed to extract       2 bytes
    buffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_UTF8, 4);
    // general purpose bit flag        2 bytes
    buffer.writeUInt16LE(generalPurposeBitFlag, 6);
    // compression method              2 bytes
    buffer.writeUInt16LE(this.compressionMethod, 8);
    // last mod file date/time         4 bytes
    buffer.writeUInt32LE(this.lastMod, 10);
    // crc-32                          4 bytes
    buffer.writeUInt32LE(this.crc32, 14);
    // compressed size                 4 bytes
    buffer.writeUInt32LE(this.compressedSize, 18);
    // uncompressed size               4 bytes
    buffer.writeUInt32LE(uncompressedSize, 22);
    // file name length                2 bytes
    buffer.writeUInt16LE(fileNameLength, 26);
    // extra field length              2 bytes
    buffer.writeUInt16LE(0, 28);
    // file name                       (variable size)
    buffer.set(fileName, LOCAL_FILE_HEADER_FIXED_SIZE);

    return buffer;
  }

  /**
   * @returns {Buffer}
   */
  getDataDescriptor() {
    if (this.crcAndFileSizeKnown) {
      // the Mac Archive Utility requires this not be present unless we set general purpose bit 3
      return EMPTY_BUFFER;
    }
    if (this.useZip64Format()) {
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
    } else {
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
    fixedSizeStuff.writeUInt16LE(this.compressionMethod, 10);
    // last mod file date/time         4 bytes
    fixedSizeStuff.writeUInt32LE(this.lastMod, 12);
    // crc-32                          4 bytes
    fixedSizeStuff.writeUInt32LE(this.crc32, 16);
    // compressed size                 4 bytes
    fixedSizeStuff.writeUInt32LE(normalCompressedSize, 20);
    // uncompressed size               4 bytes
    fixedSizeStuff.writeUInt32LE(normalUncompressedSize, 24);
    // file name length                2 bytes
    fixedSizeStuff.writeUInt16LE(this.fileName.length, 28);
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
      this.fileName,
      // extra field (variable size)
      zeiefBuffer,
      // file comment (variable size)
      this.fileComment,
    ]);
  }
}

class ZipFile extends EventEmitter {
  outputStream = new PassThrough();
  /** @type {Entry[]} */ entries = [];
  outputStreamCursor = 0;
  ended = false; // .end() sets this
  allDone = false; // set when we've written the last bytes
  forceZip64Eocd = false; // configurable in .end()
  /** @type {?Function} */ finalSizeCallback = null;
  comment = EMPTY_BUFFER;
  offsetOfStartOfCentralDirectory = 0;

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
      if (options.mtime == null) entry.lastMod = dateToDosDateTime(stats.mtime);
      if (options.mode == null)  entry.setFileAttributesMode(stats.mode, false);
      entry.setFileDataPumpFunction(() => {
        const readStream = createReadStream(realPath);
        entry.state = ENTRY_FILE_DATA_IN_PROGRESS;
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
      entry.state = ENTRY_FILE_DATA_IN_PROGRESS;
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
        entry.state = ENTRY_FILE_DATA_DONE;

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
    if (options.size     != null) throw new Error('options.size not allowed');
    if (options.compress != null) throw new Error('options.compress not allowed');
    const entry = new Entry(metadataPath, true, options);
    this.entries.push(entry);
    entry.setFileDataPumpFunction(() => {
      writeToOutputStream(this, entry.getDataDescriptor());
      entry.state = ENTRY_FILE_DATA_DONE;
      pumpEntries(this);
    });
    pumpEntries(this);
  }

  /**
   * @param {?Function|Object} [options]
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
    this.forceZip64Eocd = Boolean(options.forceZip64Format ?? false);

    const comment = options.comment;
    if (comment == null) {
    } else if (!(comment instanceof Uint8Array)) {
      throw new Error('comment must be a Buffer/Uint8Array if it exists');
    } else if (comment.length > 0xffff) {
      throw new Error('comment is too large');
    } else if (comment.includes(EOCDR_SIGNATURE)) {
      throw new Error('comment contains end of central directory record signature');
    } else {
      this.comment = comment;
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
    if (entry.uncompressedSize === -1) {
      entry.uncompressedSize = uncompressedSizeCounter.byteCount;
    } else if (entry.uncompressedSize !== uncompressedSizeCounter.byteCount) {
      return zipfile.emit('error', new Error('file data stream has unexpected number of bytes'));
    }
    entry.compressedSize = compressedSizeCounter.byteCount;
    zipfile.outputStreamCursor += entry.compressedSize;
    writeToOutputStream(zipfile, entry.getDataDescriptor());
    entry.state = ENTRY_FILE_DATA_DONE;
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
    if (entry.state < ENTRY_FILE_DATA_DONE) return entry;
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
    if (entryState < ENTRY_READY_TO_PUMP_FILE_DATA) return; // input file not open yet
    if (entryState === ENTRY_FILE_DATA_IN_PROGRESS) return; // we'll get there
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
    if (entry.state >= ENTRY_READY_TO_PUMP_FILE_DATA) {
      // if addReadStream was called without providing the size, we can't predict the final size
      if (entry.uncompressedSize === -1) return -1;
    } else if (entry.uncompressedSize === -1) {
      // if we're still waiting for fs.stat, we might learn the size someday
      return null;
    }
    // we know this for sure, and this is important to know if we need ZIP64 format.
    entry.relativeOffsetOfLocalHeader = pretendOutputCursor;

    const useZip64Format = entry.useZip64Format();
    const fileNameLength = entry.fileName.length;

    pretendOutputCursor += LOCAL_FILE_HEADER_FIXED_SIZE + fileNameLength;
    pretendOutputCursor += entry.uncompressedSize;

    if (!entry.crcAndFileSizeKnown) {
      // use a data descriptor
      pretendOutputCursor += useZip64Format ? ZIP64_DATA_DESCRIPTOR_SIZE : DATA_DESCRIPTOR_SIZE;
    }

    centralDirectorySize += CDR_FIXED_SIZE + fileNameLength + entry.fileComment.length;
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
  const { entries: { length: entriesLength },
          comment,
          forceZip64Eocd,
          offsetOfStartOfCentralDirectory,
          outputStreamCursor } = zipfile;

  let needZip64Format = (forceZip64Eocd || entriesLength >= 0xffff);
  const normalEntriesLength = needZip64Format ? 0xffff : entriesLength;

  const sizeOfCentralDirectory = outputStreamCursor - offsetOfStartOfCentralDirectory;
  let normalSizeOfCentralDirectory = sizeOfCentralDirectory;
  if (forceZip64Eocd || sizeOfCentralDirectory >= 0xffffffff) {
    normalSizeOfCentralDirectory = 0xffffffff;
    needZip64Format = true;
  }

  let normalOffsetOfStartOfCentralDirectory = offsetOfStartOfCentralDirectory;
  if (forceZip64Eocd || offsetOfStartOfCentralDirectory >= 0xffffffff) {
    normalOffsetOfStartOfCentralDirectory = 0xffffffff;
    needZip64Format = true;
  }

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
  eocdrBuffer.set(comment, 22);

  if (!needZip64Format) return eocdrBuffer;

  // ZIP64 format
  const zip64Buffer = Buffer.allocUnsafe(ZIP64_EOCDR_SIZE + ZIP64_EOCDL_SIZE + EOCDR_SIZE + commentLength);

  // ZIP64 End of Central Directory Record
  // zip64 end of central dir signature                                             4 bytes  (0x06064b50)
  zip64Buffer.writeUInt32LE(0x06064b50, 0);
  // size of zip64 end of central directory record                                  8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(ZIP64_EOCDR_SIZE - 12), 4);
  // version made by                                                                2 bytes
  zip64Buffer.writeUInt16LE(VERSION_MADE_BY, 12);
  // version needed to extract                                                      2 bytes
  zip64Buffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_ZIP64, 14);
  // number of this disk                                                            4 bytes
  zip64Buffer.writeUInt32LE(0, 16);
  // number of the disk with the start of the central directory                     4 bytes
  zip64Buffer.writeUInt32LE(0, 20);
  // total number of entries in the central directory on this disk                  8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(entriesLength), 24);
  // total number of entries in the central directory                               8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(entriesLength), 32);
  // size of the central directory                                                  8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(sizeOfCentralDirectory), 40);
  // offset of start of central directory with respect to the starting disk number  8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(offsetOfStartOfCentralDirectory), 48);
  // zip64 extensible data sector                                                   (variable size)
  // nothing in the zip64 extensible data sector

  // ZIP64 End of Central Directory Locator
  // zip64 end of central dir locator signature                               4 bytes  (0x07064b50)
  zip64Buffer.writeUInt32LE(0x07064b50, ZIP64_EOCDR_SIZE + 0);
  // number of the disk with the start of the zip64 end of central directory  4 bytes
  zip64Buffer.writeUInt32LE(0, ZIP64_EOCDR_SIZE + 4);
  // relative offset of the zip64 end of central directory record             8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(outputStreamCursor), ZIP64_EOCDR_SIZE + 8);
  // total number of disks                                                    4 bytes
  zip64Buffer.writeUInt32LE(1, ZIP64_EOCDR_SIZE + 16);

  zip64Buffer.set(eocdrBuffer, ZIP64_EOCDR_SIZE + ZIP64_EOCDL_SIZE);

  return zip64Buffer;
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

/**
 * @param {Date} date
 * @returns {number}
 */
function dateToDosDateTime(date) {
  let dosDate = date.getDate() & 0x1f; // 1-31
  dosDate |= ((date.getMonth() + 1) & 0xf) << 5; // 0-11, 1-12
  dosDate |= ((date.getFullYear() - 1980) & 0x7f) << 9; // 0-128, 1980-2108

  let dosTime = Math.floor(date.getSeconds() / 2); // 0-59, 0-29 (lose odd numbers)
  dosTime |= (date.getMinutes() & 0x3f) << 5; // 0-59
  dosTime |= (date.getHours() & 0x1f) << 11; // 0-23

  return (dosDate << 16) | dosTime;
}

export { ZipFile, dateToDosDateTime };
