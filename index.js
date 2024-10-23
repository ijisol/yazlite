import { Buffer } from 'node:buffer';
import { EventEmitter } from 'node:events';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { finished } from 'node:stream/promises';
import { promisify } from 'node:util';
import { DeflateRaw, crc32, deflateRaw } from 'node:zlib';

// Entry `compressionMethod` field enum values
const NO_COMPRESSION      = 0;
const DEFLATE_COMPRESSION = 8;

/** End of central directory record size        */ const EOCDR_SIZE       = 22;
/** ZIP64 end of central directory record size  */ const ZIP64_EOCDR_SIZE = 56;
/** ZIP64 end of central directory locator size */ const ZIP64_EOCDL_SIZE = 20;
/** Central directory record fixed size         */ const CDR_FIXED_SIZE   = 46;
/** ZIP64 extended information extra field size */ const ZIP64_EIEF_SIZE  = 28;
/** End of central directory record signature   */
const EOCDR_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x05, 0x06);

const LOCAL_FILE_HEADER_FIXED_SIZE = 30;
const VERSION_NEEDED_TO_EXTRACT_UTF8 = 20;
const VERSION_NEEDED_TO_EXTRACT_ZIP64 = 45;
const VERSION_MADE_BY = (3 << 8) | 63; // 3 = unix. 63 = spec version 6.3
const FILE_NAME_IS_UTF8 = 1 << 11;
const UNKNOWN_CRC32_AND_FILE_SIZES = 1 << 3;

const DATA_DESCRIPTOR_SIZE       = 16;
const ZIP64_DATA_DESCRIPTOR_SIZE = 24;

const EMPTY_BUFFER  = Buffer.allocUnsafe(0);
const EMPTY_PROMISE = Promise.resolve();

const deflateRawPromise = promisify(deflateRaw);

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
    const hasComment = (fileComment != null);

    if (fileName.length > 0xffff) {
      throw new RangeError(`metadataPath too long. ${fileName.length} > 65535`);
    } else if (!hasComment) {
    } else if (!(fileComment instanceof Uint8Array)) {
      throw new TypeError('fileComment must be a Buffer/Uint8Array if it exists');
    } else if (fileComment.length > 0xffff) {
      throw new RangeError('fileComment is too large');
    }

    this.fileName = fileName;
    this.isDirectory = isDirectory;
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
    this.fileComment = hasComment ? fileComment : EMPTY_BUFFER;
  }

  /**
   * @param {number} mode
   */
  setFileAttributesMode(mode, isDirectory) {
    if ((mode & 0xffff) !== mode) {
      throw new RangeError(`invalid mode. expected: 0 <= ${mode} <= 65535`);
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
   * @todo Is supported ZIP64 really?
   * @returns {Buffer}
   */
  getLocalFileHeader() {
    const { fileName } = this;
    const fileNameLength = fileName.length;
    const buffer = Buffer.allocUnsafe(
      LOCAL_FILE_HEADER_FIXED_SIZE +
      fileNameLength // file name   (variable size)
                     // extra field (variable size)
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
    } else if (this.useZip64Format()) {
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
    const { fileName, fileComment } = this;
    const fileNameLength = fileName.length;
    const fileCommentLength = fileComment.length;
    const fileNameOffset = CDR_FIXED_SIZE;
    let generalPurposeBitFlag = FILE_NAME_IS_UTF8;
    if (!this.crcAndFileSizeKnown) generalPurposeBitFlag |= UNKNOWN_CRC32_AND_FILE_SIZES;
    if (this.useZip64Format()) {
      const zeiefOffset = fileNameOffset + fileNameLength;
      const fileCommentOffset = zeiefOffset + ZIP64_EIEF_SIZE;
      const buffer = Buffer.allocUnsafe(fileCommentOffset + fileCommentLength);

      // central file header signature   4 bytes  (0x02014b50)
      buffer.writeUInt32LE(0x02014b50, 0);
      // version made by                 2 bytes
      buffer.writeUInt16LE(VERSION_MADE_BY, 4);
      // version needed to extract       2 bytes
      buffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_ZIP64, 6);
      // general purpose bit flag        2 bytes
      buffer.writeUInt16LE(generalPurposeBitFlag, 8);
      // compression method              2 bytes
      buffer.writeUInt16LE(this.compressionMethod, 10);
      // last mod file date/time         4 bytes
      buffer.writeUInt32LE(this.lastMod, 12);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 16);
      // compressed size                 4 bytes
      buffer.writeUInt32LE(0xffffffff, 20);
      // uncompressed size               4 bytes
      buffer.writeUInt32LE(0xffffffff, 24);
      // file name length                2 bytes
      buffer.writeUInt16LE(fileNameLength, 28);
      // extra field length              2 bytes
      buffer.writeUInt16LE(ZIP64_EIEF_SIZE, 30);
      // file comment length             2 bytes
      buffer.writeUInt16LE(fileCommentLength, 32);
      // disk number start               2 bytes
      buffer.writeUInt16LE(0, 34);
      // internal file attributes        2 bytes
      buffer.writeUInt16LE(0, 36);
      // external file attributes        4 bytes
      buffer.writeUInt32LE(this.externalFileAttributes, 38);
      // relative offset of local header 4 bytes
      buffer.writeUInt32LE(0xffffffff, 42);

      // file name                       (variable size)
      buffer.set(fileName, fileNameOffset);

      // ZIP64 extended information extra field
      // 0x0001                  2 bytes    Tag for this "extra" block type
      buffer.writeUInt16LE(0x0001, zeiefOffset);
      // Size                    2 bytes    Size of this "extra" block
      buffer.writeUInt16LE(ZIP64_EIEF_SIZE - 4, zeiefOffset + 2);
      // Original Size           8 bytes    Original uncompressed file size
      buffer.writeBigUInt64LE(BigInt(this.uncompressedSize), zeiefOffset + 4);
      // Compressed Size         8 bytes    Size of compressed data
      buffer.writeBigUInt64LE(BigInt(this.compressedSize), zeiefOffset + 12);
      // Relative Header Offset  8 bytes    Offset of local header record
      buffer.writeBigUInt64LE(BigInt(this.relativeOffsetOfLocalHeader), zeiefOffset + 20);
      // Disk Start Number       4 bytes    Number of the disk on which this file starts
      // (omit)

      // file comment                    (variable size)
      buffer.set(fileComment, fileCommentOffset);

      return buffer;
    } else {
      const fileCommentOffset = CDR_FIXED_SIZE + fileNameLength;
      const buffer = Buffer.allocUnsafe(fileCommentOffset + fileCommentLength);

      // central file header signature   4 bytes  (0x02014b50)
      buffer.writeUInt32LE(0x02014b50, 0);
      // version made by                 2 bytes
      buffer.writeUInt16LE(VERSION_MADE_BY, 4);
      // version needed to extract       2 bytes
      buffer.writeUInt16LE(VERSION_NEEDED_TO_EXTRACT_UTF8, 6);
      // general purpose bit flag        2 bytes
      buffer.writeUInt16LE(generalPurposeBitFlag, 8);
      // compression method              2 bytes
      buffer.writeUInt16LE(this.compressionMethod, 10);
      // last mod file date/time         4 bytes
      buffer.writeUInt32LE(this.lastMod, 12);
      // crc-32                          4 bytes
      buffer.writeUInt32LE(this.crc32, 16);
      // compressed size                 4 bytes
      buffer.writeUInt32LE(this.compressedSize, 20);
      // uncompressed size               4 bytes
      buffer.writeUInt32LE(this.uncompressedSize, 24);
      // file name length                2 bytes
      buffer.writeUInt16LE(fileNameLength, 28);
      // extra field length              2 bytes
      buffer.writeUInt16LE(0, 30);
      // file comment length             2 bytes
      buffer.writeUInt16LE(fileCommentLength, 32);
      // disk number start               2 bytes
      buffer.writeUInt16LE(0, 34);
      // internal file attributes        2 bytes
      buffer.writeUInt16LE(0, 36);
      // external file attributes        4 bytes
      buffer.writeUInt32LE(this.externalFileAttributes, 38);
      // relative offset of local header 4 bytes
      buffer.writeUInt32LE(this.relativeOffsetOfLocalHeader, 42);

      // file name                       (variable size)
      buffer.set(fileName, fileNameOffset);

      // file comment                    (variable size)
      buffer.set(fileComment, fileCommentOffset);
  
      return buffer;
    }
  }
}

class ByteCounter extends Transform {
  bytesWritten = 0;

  _transform(chunk, encoding, callback) {
    this.bytesWritten += chunk.length;
    callback(null, chunk);
  }
}

class Crc32Watcher extends Transform {
  bytesWritten = 0;
  crc32 = 0;

  _transform(chunk, encoding, callback) {
    this.bytesWritten += chunk.length;
    this.crc32 = crc32(chunk, this.crc32);
    callback(null, chunk);
  }
}

class ZipFile extends EventEmitter {
  /** @type {Entry[]}   */ entries  = [];
  /** @type {Promise[]} */ loadings = [];
  outputStream = new ByteCounter();
  offsetOfStartOfCentralDirectory = 0;
  ended = false; // .end() sets this
  allDone = false; // set when we've written the last bytes
  forceZip64Eocd = false; // configurable in .end()
  comment = EMPTY_BUFFER;
  streaming = EMPTY_PROMISE;

  /**
   * @param {string} realPath
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addFile(realPath, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    options ??= {};
    const entry = new Entry(metadataPath, false, options);
    const loading = stat(realPath).then((stats) => {
      if (!stats.isFile()) throw new Error(`not a file: ${realPath}`);
      entry.uncompressedSize = stats.size;
      if (options.mtime == null) entry.lastMod = dateToDosDateTime(stats.mtime);
      if (options.mode  == null) entry.setFileAttributesMode(stats.mode, false);
      appendStream(this, entry, writeReadStream, entry, createReadStream(realPath));
    }).catch((err) => this.emit('error', err));
    this.entries.push(entry);
    this.loadings.push(loading);
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
    appendStream(this, entry, writeReadStream, entry, readStream);
  }

  /**
   * @param {Buffer} buffer
   * @param {string} metadataPath
   * @param {?Options} [options]
   */
  addBuffer(buffer, metadataPath, options) {
    metadataPath = validateMetadataPath(metadataPath, false);
    options ??= {};
    if (options.size != null) throw new Error('options.size not allowed');
    const entry = new Entry(metadataPath, false, options);
    const flush = (buffer) => {
      entry.compressedSize = buffer.length;
      appendStream(this, entry, writeBuffer, buffer);
    };
    entry.uncompressedSize = buffer.length;
    entry.crc32 = crc32(buffer);
    entry.crcAndFileSizeKnown = true;
    this.entries.push(entry);
    if (entry.compress) {
      this.loadings.push(deflateRawPromise(buffer).then(flush).catch((err) => this.emit('error', err)));
    } else {
      flush(buffer);
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
    appendStream(this, entry);
  }

  /**
   * Instead of taking a callback function, returns a Promise of total size.
   * @param {?Function|Object} [options]
   * @param {?boolean} [returnsTotalSize]
   * @returns {Promise<void>|Promise<number>}
   */
  end(options, returnsTotalSize) {
    if (this.ended || this.allDone) return EMPTY_PROMISE;

    if (typeof options === 'boolean') {
      returnsTotalSize = options;
      options = {};
    } else {
      options ??= {};
      returnsTotalSize = Boolean(returnsTotalSize ?? false);
    }

    const comment = options.comment;
    if (comment == null) {
    } else if (!(comment instanceof Uint8Array)) {
      throw new TypeError('comment must be a Buffer/Uint8Array if it exists');
    } else if (comment.length > 0xffff) {
      throw new RangeError('comment is too large');
    } else if (comment.includes(EOCDR_SIGNATURE)) {
      throw new Error('comment contains end of central directory record signature');
    } else {
      this.comment = comment;
    }

    this.ended = true;
    this.forceZip64Eocd = Boolean(options.forceZip64Format ?? false);

    const loading = Promise.all(this.loadings);

    // Calculate the total size before asynchronously emitting the final stream
    // according to the original yazl code's flow.
    // But I think it might be okay or rather better to compute it later...
    // Is there any reason why it must be calculated beforehand?
    const result = returnsTotalSize ?
                   loading.then(() => calculateTotalSize(this)) :
                   loading.then(() => {});

    // all cought up on writing entries
    const { outputStream } = this;
    loading.then(() => this.streaming).then(() => {
      // head for the exit
      this.offsetOfStartOfCentralDirectory = outputStream.bytesWritten;
      const entries = this.entries;
      const totalEntries = entries.length;
      for (let i = 0; i < totalEntries; ++i) {
        const centralDirectoryRecord = entries[i].getCentralDirectoryRecord();
        outputStream.write(centralDirectoryRecord);
      }
      outputStream.write(getEndOfCentralDirectoryRecord(this));
      outputStream.end();
      this.allDone = true;
    }).catch((err) => this.emit('error', err));

    return result;
  }
}

/**
 * @param {ZipFile} zipfile
 * @param {Buffer} buffer
 */
function writeBuffer(zipfile, buffer) {
  zipfile.outputStream.write(buffer);
}

/**
 * @param {ZipFile} zipfile
 * @param {Entry} entry
 * @param {ReadStream} readStream
 * @returns {Promise<void>}
 */
async function writeReadStream(zipfile, entry, readStream) {
  const crc32Watcher = new Crc32Watcher();
  readStream = readStream.pipe(crc32Watcher);
  if (entry.compress) readStream = readStream.pipe(new DeflateRaw());
  readStream.pipe(zipfile.outputStream, { end: false });
  await finished(readStream);
  entry.compressedSize = readStream.bytesWritten;
  entry.crc32 = crc32Watcher.crc32;
  if (entry.uncompressedSize === -1) {
    entry.uncompressedSize = crc32Watcher.bytesWritten;
  } else if (entry.uncompressedSize !== crc32Watcher.bytesWritten) {
    throw new RangeError('file data stream has unexpected number of bytes');
  }
}

/**
 * @param {ZipFile} zipfile
 * @param {Entry} entry
 * @param {Function} [writer]
 * @param {*} [...args]
 */
function appendStream(zipfile, entry, writer, ...args) {
  zipfile.streaming = zipfile.streaming.then(async () => {
    entry.relativeOffsetOfLocalHeader = zipfile.outputStream.bytesWritten;
    zipfile.outputStream.write(entry.getLocalFileHeader());
    if (writer !== undefined) await writer(zipfile, ...args);
    zipfile.outputStream.write(entry.getDataDescriptor());
  }).catch((err) => zipfile.emit('error', err));
}

/**
 * @param {ZipFile} zipfile
 * @returns {number}
 */
function calculateTotalSize(zipfile) {
  const entries = zipfile.entries;
  const totalEntries = entries.length;
  let pretendOutputCursor = 0;
  let centralDirectorySize = 0;
  for (let i = 0; i < totalEntries; ++i) {
    const entry = entries[i];
    // compression is too hard to predict
    if (entry.compress) return -1;
    // if addReadStream was called without providing the size, can't predict the final size
    if (entry.uncompressedSize === -1) return -1;

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
    if (useZip64Format) centralDirectorySize += ZIP64_EIEF_SIZE;
  }

  let endOfCentralDirectorySize = EOCDR_SIZE + zipfile.comment.length;
  if (
    (zipfile.forceZip64Eocd) ||
    (totalEntries >= 0xffff) ||
    (centralDirectorySize >= 0xffff) ||
    (pretendOutputCursor >= 0xffffffff)
  ) {
    // use zip64 end of central directory stuff
    endOfCentralDirectorySize += ZIP64_EOCDR_SIZE + ZIP64_EOCDL_SIZE;
  }
  return pretendOutputCursor + centralDirectorySize + endOfCentralDirectorySize;
}

/**
 * @param {ZipFile} zipfile
 * @returns {Buffer}
 */
function getEndOfCentralDirectoryRecord(zipfile) {
  const { entries: { length: totalEntries },
          outputStream: { bytesWritten },
          comment,
          forceZip64Eocd,
          offsetOfStartOfCentralDirectory } = zipfile;

  let needZip64Format = (forceZip64Eocd || totalEntries >= 0xffff);
  const normalTotalEntries = needZip64Format ? 0xffff : totalEntries;

  const sizeOfCentralDirectory = bytesWritten - offsetOfStartOfCentralDirectory;
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
  eocdrBuffer.writeUInt16LE(normalTotalEntries, 8);
  // total number of entries in the central directory   2 bytes
  eocdrBuffer.writeUInt16LE(normalTotalEntries, 10);
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

  zip64Buffer.set(eocdrBuffer, ZIP64_EOCDR_SIZE + ZIP64_EOCDL_SIZE);

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
  zip64Buffer.writeBigUInt64LE(BigInt(totalEntries), 24);
  // total number of entries in the central directory                               8 bytes
  zip64Buffer.writeBigUInt64LE(BigInt(totalEntries), 32);
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
  zip64Buffer.writeBigUInt64LE(BigInt(bytesWritten), ZIP64_EOCDR_SIZE + 8);
  // total number of disks                                                    4 bytes
  zip64Buffer.writeUInt32LE(1, ZIP64_EOCDR_SIZE + 16);

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
