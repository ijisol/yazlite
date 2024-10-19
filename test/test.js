import { Buffer } from 'node:buffer';
import { createReadStream, readFileSync } from 'node:fs';
import { Readable, Transform, getDefaultHighWaterMark } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buffer as consumeBuffer } from 'node:stream/consumers';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fromBuffer } from 'yauzl';
import { encodeCP437 } from '../cp437.js';
import { ZipFile, dateToDosDateTime } from '../index.js';

const fromBufferPromise = promisify(fromBuffer);
const filename = fileURLToPath(import.meta.url);
const weirdChars = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

(function () {
  const buffer = readFileSync(filename);
  const expectedContents = buffer.toString();
  const zipfile = new ZipFile();
  const outputStream = zipfile.outputStream;
  const options = {
    mtime: dateToDosDateTime(new Date()),
    mode: 0o100664,
  };
  zipfile.addFile(filename, 'unicōde.txt');
  zipfile.addFile(filename, 'without-compression.txt', { compress: false });
  zipfile.addReadStream(createReadStream(filename), 'readStream.txt', options);
  zipfile.addBuffer(buffer, 'with/directories.txt', options);
  zipfile.addBuffer(buffer, 'with\\windows-paths.txt', options);
  zipfile.end(async function (finalSize) {
    if (finalSize !== -1) throw new Error('finalSize is impossible to know before compression');
    const zipfile = await consumeBuffer(outputStream).then(fromBufferPromise);
    zipfile.on('entry', function (entry) {
      zipfile.openReadStream(entry, async function (err, readStream) {
        if (err != null) throw err;
        const data = await consumeBuffer(readStream);
        if (expectedContents !== data.toString()) {
          throw new Error('unexpected contents');
        }
        console.log(`${entry.fileName}: pass`);
      });
    });
  });
})();

(function () {
  const buffers = [Buffer.from('stream')];
  const zip64Combinations = [
    [0, 0, 0, 0, 0],
    [1, 1, 0, 0, 0],
    [0, 0, 1, 0, 0],
    [0, 0, 0, 1, 0],
    [0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1],
  ];
  zip64Combinations.forEach(function (zip64Config) {
    const options = {
      compress: false,
      size: null,
      forceZip64Format: false,
    };
    const zipfile = new ZipFile();
    options.forceZip64Format = !!zip64Config[0];
    zipfile.addFile(filename, 'asdf.txt', options);
    options.forceZip64Format = !!zip64Config[1];
    zipfile.addFile(filename, 'fdsa.txt', options);
    options.forceZip64Format = !!zip64Config[2];
    zipfile.addBuffer(Buffer.from('buffer'), 'buffer.txt', options);
    options.forceZip64Format = !!zip64Config[3];
    options.size = 'stream'.length;
    zipfile.addReadStream(Readable.from(buffers), 'stream.txt', options);
    options.size = null;
    zipfile.end({ forceZip64Format:!!zip64Config[4] }, async function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      const data = await consumeBuffer(zipfile.outputStream);
      if (data.length !== finalSize) {
        throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
      }
      console.log(`finalSize(${zip64Config.join('')}): pass`);
    });
  });
})();

(function () {
  const zipfile = new ZipFile();
  const outputStream = zipfile.outputStream;
  // all options parameters are optional
  zipfile.addFile(filename, 'a.txt');
  zipfile.addBuffer(Buffer.from('buffer'), 'b.txt');
  zipfile.addReadStream(Readable.from([Buffer.from('stream')]), 'c.txt');
  zipfile.addEmptyDirectory('d/');
  zipfile.addEmptyDirectory('e', { mode: 0o000644 });
  zipfile.end(async function (finalSize) {
    if (finalSize !== -1) throw new Error('finalSize should be unknown');
    const zipfile = await consumeBuffer(outputStream).then(fromBufferPromise);
    const entryNames = ['a.txt', 'b.txt', 'c.txt', 'd/', 'e/'];
    zipfile.on('entry', function (entry) {
      const { fileName } = entry;
      const expectedName = entryNames.shift();
      if (fileName !== expectedName) {
        throw new Error(`unexpected entry fileName: ${fileName}, expected: ${expectedName}`);
      }
      const mode = entry.externalFileAttributes >>> 16;
      if (fileName.endsWith('/')) {
        if ((mode & 0o040000) === 0) {
          throw new Error(`directory expected to have S_IFDIR, found ${mode.toString(8)}`);
        } else if ((mode & 0o000111) === 0) {
          throw new Error(`directory expected to have executable flags, found ${mode.toString(8)}`);
        }
      } else if ((mode & 0o100000) === 0) {
        throw new Error(`file expected to have S_IFREG, found ${mode.toString(8)}`);
      }
    });
    zipfile.on('end', function () {
      if (entryNames.length === 0) {
        return console.log('optional parameters and directories: pass');
      }
      throw new Error(`something was wrong`);
    });
  });
})();

(function () {
  const zipfile = new ZipFile();
  const outputStream = zipfile.outputStream;
  // all options parameters are optional
  zipfile.addBuffer(Buffer.from('hello'), 'hello.txt', { compress: false });
  zipfile.end(async function (finalSize) {
    if (finalSize === -1) throw new Error('finalSize should be known');
    const data = await consumeBuffer(outputStream);
    if (data.length !== finalSize) {
      throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
    }
    const zipfile = await fromBufferPromise(data);
    const entryNames = ['hello.txt'];
    zipfile.on('entry', function (entry) {
      const expectedName = entryNames.shift();
      if (entry.fileName !== expectedName) {
        throw new Error(`unexpected entry fileName: ${entry.fileName}, expected: ${expectedName}`);
      }
    });
    zipfile.on('end', function () {
      if (entryNames.length === 0) {
        return console.log('justAddBuffer: pass');
      }
      throw new Error(`something was wrong`);
    });
  });
})();

(function () {
  const testCases = [
    [encodeCP437('Hello World'), 'Hello World'],
    [Buffer.from('Hello'), 'Hello'],
    [encodeCP437(weirdChars), weirdChars],
  ];
  testCases.forEach(function (testCase, i) {
    const zipfile = new ZipFile();
    const outputStream = zipfile.outputStream;
    zipfile.end({ comment: testCase[0] }, async function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      const data = await consumeBuffer(outputStream);
      if (data.length !== finalSize) {
        throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
      }
      const zipfile = await fromBufferPromise(data);
      if (zipfile.comment !== testCase[1]) {
        throw new Error(`comment is wrong. ${JSON.stringify(zipfile.comment)} !== ${JSON.stringify(testCase[1])}`);
      }
      console.log(`comment(${i}): pass`);
    });
  });
})();

(function () {
  try {
    const zipfile = new ZipFile();
    zipfile.end({ comment: encodeCP437('0123456789 PK♣♠ 0123456789') });
  } catch (err) {
    if (err.toString().includes('comment contains end of central directory record signature')) {
      return console.log('block eocdr signature in CP437 encoded comment: pass');
    }
  }
  throw new Error('expected error for including eocdr signature in CP437 encoded comment');
})();

(function () {
  try {
    const zipfile = new ZipFile();
    zipfile.end({ comment: Buffer.from('0123456789 \x50\x4b\x05\x06 0123456789', 'utf8') });
  } catch (err) {
    if (err.toString().includes('comment contains end of central directory record signature')) {
      return console.log('block eocdr signature in UTF-8 encoded comment: pass');
    }
  }
  throw new Error('expected error for including eocdr signature in UTF-8 encoded comment');
})();

(function () {
  const testCases = [
    [Buffer.from('Hello World!'), 'Hello World!'],
    [Buffer.from('Hello!'), 'Hello!'],
    [Buffer.from(weirdChars), weirdChars],
  ];
  testCases.forEach(function (testCase, i) {
    const zipfile = new ZipFile();
    const outputStream = zipfile.outputStream;
    // all options parameters are optional
    zipfile.addBuffer(Buffer.from('hello'), 'hello.txt', { compress: false, fileComment: testCase[0] });
    zipfile.end(async function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      const data = await consumeBuffer(outputStream);
      if (data.length !== finalSize) {
        throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
      }
      const zipfile = await fromBufferPromise(data);
      const entryNames = ['hello.txt'];
      zipfile.on('entry', function (entry) {
        entryNames.shift();
        const fileComment = entry.fileComment.toString();
        if (fileComment !== testCase[1]) {
          throw new Error(`fileComment is wrong. ${JSON.stringify(fileComment)} !== ${JSON.stringify(testCase[1])}`);
        }
      });
      zipfile.on('end', function () {
        if (entryNames.length === 0) {
          return console.log(`fileComment(${i}): pass`);
        }
        throw new Error(`something was wrong`);
      });
    });
  });
})();

(async function putLargeStream() {
  const zipfile = new ZipFile();
  const readStream = Readable.from((function* () {
    const size = getDefaultHighWaterMark();
    const buffer = Buffer.allocUnsafe(size);
    for (let i = 0; i < 0xffffffff; i += size) {
      yield buffer;
    }
  })());

  zipfile.addReadStream(readStream, 'hello.txt');
  zipfile.end();
  await pipeline(zipfile.outputStream, new Transform({
    transform(chunk, encoding, callback) {
      callback(null); // Just throw away
    }
  }));

  console.log(`put large stream (ZIP64): pass`);
})();
