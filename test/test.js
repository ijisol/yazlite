import { createReadStream, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromBuffer } from 'yauzl';
import { encodeCP437 } from '../cp437.js';
import { ZipFile } from '../index.js';
import { BufferListStream } from './lib/bl.js';

const filename = fileURLToPath(import.meta.url);

(function () {
  const fileMetadata = {
    mtime: new Date(),
    mode: 0o100664,
  };
  const zipfile = new ZipFile();
  zipfile.addFile(filename, 'unicōde.txt');
  zipfile.addFile(filename, 'without-compression.txt', { compress: false });
  zipfile.addReadStream(createReadStream(filename), 'readStream.txt', fileMetadata);
  const expectedContents = readFileSync(filename);
  zipfile.addBuffer(expectedContents, 'with/directories.txt', fileMetadata);
  zipfile.addBuffer(expectedContents, 'with\\windows-paths.txt', fileMetadata);
  zipfile.end(function (finalSize) {
    if (finalSize !== -1) throw new Error('finalSize is impossible to know before compression');
    zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
      if (err) throw err;
      fromBuffer(data, function (err, zipfile) {
        if (err) throw err;
        zipfile.on('entry', function (entry) {
          zipfile.openReadStream(entry, function (err, readStream) {
            if (err) throw err;
            readStream.pipe(new BufferListStream(function (err, data) {
              if (err) throw err;
              if (expectedContents.toString('binary') !== data.toString('binary')) {
                throw new Error('unexpected contents');
              }
              console.log(`${entry.fileName}: pass`);
            }));
          });
        });
      });
    }));
  });
})();

(function () {
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
    zipfile.addReadStream(new BufferListStream().append('stream'), 'stream.txt', options);
    options.size = null;
    zipfile.end({ forceZip64Format:!!zip64Config[4] }, function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
        if (data.length !== finalSize) {
          throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
        }
        console.log(`finalSize(${zip64Config.join('')}): pass`);
      }));
    });
  });
})();

(function () {
  const zipfile = new ZipFile();
  // all options parameters are optional
  zipfile.addFile(filename, 'a.txt');
  zipfile.addBuffer(Buffer.from('buffer'), 'b.txt');
  zipfile.addReadStream(new BufferListStream().append('stream'), 'c.txt');
  zipfile.addEmptyDirectory('d/');
  zipfile.addEmptyDirectory('e', { mode: 0o000644 });
  zipfile.end(function (finalSize) {
    if (finalSize !== -1) throw new Error('finalSize should be unknown');
    zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
      if (err) throw err;
      fromBuffer(data, function (err, zipfile) {
        if (err) throw err;
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
            }
            if ((mode & 0o000111) === 0) {
              throw new Error(`directory expected to have executable flags, found ${mode.toString(8)}`);
            }
          } else if ((mode & 0o100000) === 0) {
            throw new Error(`file expected to have S_IFREG, found ${mode.toString(8)}`);
          }
        });
        zipfile.on('end', function () {
          if (entryNames.length === 0) console.log('optional parameters and directories: pass');
        });
      });
    }));
  });
})();

(function () {
  const zipfile = new ZipFile();
  // all options parameters are optional
  zipfile.addBuffer(Buffer.from('hello'), 'hello.txt', { compress: false });
  zipfile.end(function (finalSize) {
    if (finalSize === -1) throw new Error('finalSize should be known');
    zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
      if (err) throw err;
      if (data.length !== finalSize) throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
      fromBuffer(data, function (err, zipfile) {
        if (err) throw err;
        const entryNames = ['hello.txt'];
        zipfile.on('entry', function (entry) {
          const expectedName = entryNames.shift();
          if (entry.fileName !== expectedName) {
            throw new Error(`unexpected entry fileName: ${entry.fileName}, expected: ${expectedName}`);
          }
        });
        zipfile.on('end', function () {
          if (entryNames.length === 0) console.log('justAddBuffer: pass');
        });
      });
    }));
  });
})();

const weirdChars = '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼⌂ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

(function () {
  const testCases = [
    [encodeCP437('Hello World'), 'Hello World'],
    [Buffer.from('Hello'), 'Hello'],
    [encodeCP437(weirdChars), weirdChars],
  ];
  testCases.forEach(function (testCase, i) {
    const zipfile = new ZipFile();
    zipfile.end({ comment: testCase[0] }, function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
        if (err) throw err;
        if (data.length !== finalSize) {
          throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
        }
        fromBuffer(data, function (err, zipfile) {
          if (err) throw err;
          if (zipfile.comment !== testCase[1]) {
            throw new Error(`comment is wrong. ${JSON.stringify(zipfile.comment)} !== ${JSON.stringify(testCase[1])}`);
          }
          console.log(`comment(${i}): pass`);
        });
      }));
    });
  });
})();

(function () {
  const zipfile = new ZipFile();
  try {
    zipfile.end({
      comment: Buffer.from('01234567890123456789' + '\x50\x4b\x05\x06' + '01234567890123456789')
    });
  } catch (err) {
    if (err.toString().includes('comment contains end of central directory record signature')) {
      console.log('block eocdr signature in comment: pass');
      return;
    }
  }
  throw new Error('expected error for including eocdr signature in comment');
})();

(function () {
  const testCases = [
    [Buffer.from('Hello World!'), 'Hello World!'],
    [Buffer.from('Hello!'), 'Hello!'],
    [Buffer.from(weirdChars), weirdChars],
  ];
  testCases.forEach(function (testCase, i) {
    const zipfile = new ZipFile();
    // all options parameters are optional
    zipfile.addBuffer(Buffer.from('hello'), 'hello.txt', { compress: false, fileComment: testCase[0] });
    zipfile.end(function (finalSize) {
      if (finalSize === -1) throw new Error('finalSize should be known');
      zipfile.outputStream.pipe(new BufferListStream(function (err, data) {
        if (err) throw err;
        if (data.length !== finalSize) {
          throw new Error(`finalSize prediction is wrong. ${finalSize} !== ${data.length}`);
        }
        fromBuffer(data, function (err, zipfile) {
          if (err) throw err;
          const entryNames = ['hello.txt'];
          zipfile.on('entry', function (entry) {
            const expectedName = entryNames.shift();
            const fileComment = entry.fileComment.toString();
            if (fileComment !== testCase[1]) {
              throw new Error(`fileComment is wrong. ${JSON.stringify(fileComment)} !== ${JSON.stringify(testCase[1])}`);
            }
          });
          zipfile.on('end', function () {
            if (entryNames.length === 0) console.log(`fileComment(${i}): pass`);
          });
        });
      }));
    });
  });
})();
