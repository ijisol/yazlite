# yazlite

Generate ZIP files in Node.js; zero-dependency yazl fork.

## About

Josh Wolfe's [yazl](https://github.com/thejoshwolfe/yazl) is a great ZIP library. It's stable, so it's not a big problem that it hasn't been updated for a long time.

But now Node.js 20 became LTS, and it has [a built-in CRC32 checksum method](https://nodejs.org/docs/latest-v20.x/api/zlib.html#zlibcrc32data-value). There's no reason to keep the [buffer-crc32](https://www.npmjs.com/package/buffer-crc32) dependency. However, the state of issues and pull requests in the yazl's repository looks like it will not be updated in the future.

The yazlite is a fork of the yazl for removing the dependency and converting legacy code to modern syntax.

## Usage

``` javascript
import { Buffer } from 'node:buffer';
import { createWriteStream } from 'node:fs';
import { ZipFile } from 'yazlite';
import { encodeCp437 } from 'yazlite/cp437';

const zipfile = new ZipFile();

// Can add only files, not directories.
zipfile.addFile('file1.txt', 'file1.txt');
zipfile.addFile('path/to/file.txt', 'path/in/zipfile.txt');

// `pipe()` can be called any time after the constructor.
const stream = createWriteStream('output.zip');
zipfile.outputStream.pipe(stream).on('close', () => console.log('done'));

// Alternate APIs for adding files:
zipfile.addReadStream(process.stdin, 'stdin.txt');
zipfile.addBuffer(Buffer.from('hello', 'utf8'), 'hello.txt');

// Call `end()` after all the files have been added.
// If a comment exists, it must be a Buffer.
// The `encodeCp437` in `yazlite/cp437` is a utility for its encoding.
// See `ZipFile.end()` section for details.
zipfile.end({ comment: encodeCp437('This is a comment ☺') });
```

## API

### Class: ZipFile

#### new ZipFile()

No parameters.
Nothing can go wrong.

#### addFile(realPath, metadataPath, [options])

Adds a file from the file system at `realPath` into the zipfile as `metadataPath`.
Typically `metadataPath` would be calculated as `path.relative(root, realPath)`.
Unzip programs would extract the file from the zipfile as `metadataPath`.
`realPath` is not stored in the zipfile.

A valid `metadataPath` must not be blank.
If a `metadataPath` contains `"\\"` characters, they will be replaced by `"/"` characters.
After this substitution, a valid `metadataPath` must not start with `"/"` or `/[A-Za-z]:\//`,
and must not contain `".."` path segments.
File paths must not end with `"/"`, but see `addEmptyDirectory()`.
After UTF-8 encoding, `metadataPath` must be at most `0xffff` bytes in length.

`options` may be omitted or null and has the following structure and default values:

``` javascript
{
  mtime: stats.mtime,
  mode: stats.mode,
  compress: true,
  forceZip64Format: false,
  fileComment: null,
}
```

Use `mtime` and/or `mode` to override the values
that would normally be obtained by the `fs.Stats` for the `realPath`.
The mode is the unix permission bits and file type.
The mtime and mode are stored in the zip file in the fields "last mod file time",
"last mod file date", and "external file attributes".
yazl does not store group and user ids in the zip file.

If `compress` is `true`, the file data will be deflated (compression method 8).
If `compress` is `false`, the file data will be stored (compression method 0).

If `forceZip64Format` is `true`, yazl will use ZIP64 format in this entry's Data Descriptor
and Central Directory Record regardless of if it's required or not (this may be useful for testing.).
Otherwise, yazl will use ZIP64 format where necessary.

If `fileComment` is a `string`, it will be encoded with UTF-8.
If `fileComment` is a `Buffer`, it should be a UTF-8 encoded string.
In UTF-8, `fileComment` must be at most `0xffff` bytes in length.
This becomes the "file comment" field in this entry's central directory file header.

Internally, `fs.stat()` is called immediately in the `addFile` function,
and `fs.createReadStream()` is used later when the file data is actually required.
Throughout adding and encoding `n` files with `addFile()`,
the number of simultaneous open files is `O(1)`, probably just 1 at a time.

#### addReadStream(readStream, metadataPath, [options])

Adds a file to the zip file whose content is read from `readStream`.
See `addFile()` for info about the `metadataPath` parameter.
`options` may be omitted or null and has the following structure and default values:

``` javascript
{
  mtime: new Date(),
  mode: 0o100664,
  compress: true,
  forceZip64Format: false,
  fileComment: null,
  size: 12345, // example value
}
```

See `addFile()` for the meaning of `mtime`, `mode`, `compress`, `forceZip64Format`, and `fileComment`.
If `size` is given, it will be checked against the actual number of bytes in the `readStream`,
and an error will be emitted if there is a mismatch.

Note that yazl will `.pipe()` data from `readStream`, so be careful using `.on('data')`.
In certain versions of node, `.on('data')` makes `.pipe()` behave incorrectly.

#### addBuffer(buffer, metadataPath, [options])

Adds a file to the zip file whose content is `buffer`.
See below for info on the limitations on the size of `buffer`.
See `addFile()` for info about the `metadataPath` parameter.
`options` may be omitted or null and has the following structure and default values:

``` javascript
{
  mtime: new Date(),
  mode: 0o100664,
  compress: true,
  forceZip64Format: false,
  fileComment: null,
}
```

See `addFile()` for the meaning of `mtime`, `mode`, `compress`, `forceZip64Format`, and `fileComment`.

This method has the unique property that General Purpose Bit `3` will not be used in the Local File Header.
This doesn't matter for unzip implementations that conform to the Zip File Spec.
However, 7-Zip 9.20 has a known bug where General Purpose Bit `3` is declared an unsupported compression method
(note that it really has nothing to do with the compression method.).
See [issue #11](https://github.com/thejoshwolfe/yazl/issues/11).
If you would like to create zip files that 7-Zip 9.20 can understand,
you must use `addBuffer()` instead of `addFile()` or `addReadStream()` for all entries in the zip file
(and `addEmptyDirectory()` is fine too).

Note that even when yazl provides the file sizes in the Local File Header,
yazl never uses ZIP64 format for Local File Headers due to the size limit on `buffer` (see below).

##### Size limitation on buffer

In order to require the ZIP64 format for a local file header,
the provided `buffer` parameter would need to exceed `0xfffffffe` in length.
Alternatively, the `buffer` parameter might not exceed `0xfffffffe` in length,
but zlib compression fails to compress the buffer and actually inflates the data to more than `0xfffffffe` in length.
Both of these scenarios are not allowed by yazl, and those are enforced by a size limit on the `buffer` parameter.

According to [this zlib documentation](http://www.zlib.net/zlib_tech.html),
the worst case compression results in "an expansion of at most 13.5%, plus eleven bytes".
Furthermore, some configurations of Node.js impose a size limit of `0x3fffffff` on every `Buffer` object.
Running this size through the worst case compression of zlib still produces a size less than `0xfffffffe` bytes,

Therefore, yazl enforces that the provided `buffer` parameter must be at most `0x3fffffff` bytes long.

#### addEmptyDirectory(metadataPath, [options])

Adds an entry to the zip file that indicates a directory should be created,
even if no other items in the zip file are contained in the directory.
This method is only required if the zip file is intended to contain an empty directory.

See `addFile()` for info about the `metadataPath` parameter.
If `metadataPath` does not end with a `"/"`, a `"/"` will be appended.

`options` may be omitted or null and has the following structure and default values:

``` javascript
{
  mtime: new Date(),
  mode: 040775,
}
```

See `addFile()` for the meaning of `mtime` and `mode`.

#### end([options], [finalSizeCallback])

Indicates that no more files will be added via `addFile()`, `addReadStream()`, or `addBuffer()`,
and causes the eventual close of `outputStream`.

`options` may be omitted or null and has the following structure and default values:

``` javascript
{
  forceZip64Format: false,
  comment: null,
}
```

If `forceZip64Format` is `true`, yazl will include the ZIP64 End of Central Directory Locator
and ZIP64 End of Central Directory Record regardless of whether or not they are required
(this may be useful for testing.).
Otherwise, yazl will include these structures if necessary.

If `comment` is a `Buffer`, it should be a CP437 encoded string.
The utility function `encodeCp437()` is provided optionally in `yazlite/cp437`.

`comment` must be at most `0xffff` bytes in length and must not include the byte sequence `[0x50,0x4b,0x05,0x06]`.
This becomes the ".ZIP file comment" field in the end of central directory record.
Note that in practice, most zipfile readers interpret this field in UTF-8 instead of CP437.
If your string uses only codepoints in the range `0x20...0x7e`
(printable ASCII, no whitespace except for sinlge space `' '`),
then UTF-8 and CP437 (and ASCII) encodings are all identical.
This restriction is recommended for maxium compatibility.
To use UTF-8 encoding at your own risk, pass a `Buffer` into this function; it will not be validated.

If specified and non-null, `finalSizeCallback` is given the parameters `(finalSize)`
sometime during or after the call to `end()`.
`finalSize` is of type `Number` and can either be `-1`
or the guaranteed eventual size in bytes of the output data that can be read from `outputStream`.

Note that `finalSizeCallback` is usually called well before `outputStream` has piped all its data;
this callback does not mean that the stream is done.

If `finalSize` is `-1`, it means means the final size is too hard to guess before processing the input file data.
This will happen if and only if the `compress` option is `true` on any call to `addFile()`, `addReadStream()`, or `addBuffer()`,
or if `addReadStream()` is called and the optional `size` option is not given.
In other words, clients should know whether they're going to get a `-1` or a real value
by looking at how they are using this library.

The call to `finalSizeCallback` might be delayed if yazl is still waiting for `fs.Stats` for an `addFile()` entry.
If `addFile()` was never called, `finalSizeCallback` will be called during the call to `end()`.
It is not required to start piping data from `outputStream` before `finalSizeCallback` is called.
`finalSizeCallback` will be called only once, and only if this is the first call to `end()`.

#### outputStream

A readable stream that will produce the contents of the zip file.
It is typical to pipe this stream to a writable stream created from `fs.createWriteStream()`.

Internally, large amounts of file data are piped to `outputStream` using `pipe()`,
which means throttling happens appropriately when this stream is piped to a slow destination.

Data becomes available in this stream soon after calling one of `addFile()`, `addReadStream()`, or `addBuffer()`.
Clients can call `pipe()` on this stream at any time,
such as immediately after getting a new `ZipFile` instance, or long after calling `end()`.

This stream will remain open while you add entries until you `end()` the zip file.

As a reminder, be careful using both `.on('data')` and `.pipe()` with this stream.
In certain versions of node, you cannot use both `.on('data')` and `.pipe()` successfully.

## Regarding ZIP64 Support

yazl automatically uses ZIP64 format to support files and archives over `2^32 - 2` bytes (~4GB) in size
and to support archives with more than `2^16 - 2` (65534) files.
(See the `forceZip64Format` option in the API above for more control over this behavior.)
ZIP64 format is necessary to exceed the limits inherent in the original zip file format.

ZIP64 format is supported by most popular zipfile readers, but not by all of them.
Notably, the Mac Archive Utility does not understand ZIP64 format (as of writing this),
and will behave very strangely when presented with such an archive.

## Output Structure

The Zip File Spec leaves a lot of flexibility up to the zip file creator.
This section explains and justifies yazl's interpretation and decisions regarding this flexibility.

This section is probably not useful to yazl clients,
but may be interesting to unzip implementors and zip file enthusiasts.

### Disk Numbers

All values related to disk numbers are `0`,
because yazl has no multi-disk archive support.
(The exception being the Total Number of Disks field in
the ZIP64 End of Central Directory Locator, which is always `1`.)

### Version Made By

Always `0x033f == (3 << 8) | 63`, which means UNIX (3)
and made from the spec version 6.3 (63).

Note that the "UNIX" has implications in the External File Attributes.

### Version Needed to Extract

Usually `20`, meaning 2.0. This allows filenames and file comments to be UTF-8 encoded.

When ZIP64 format is used, some of the Version Needed to Extract values will be `45`, meaning 4.5.
When this happens, there may be a mix of `20` and `45` values throughout the zipfile.

### General Purpose Bit Flag

Bit `11` is always set.
Filenames (and file comments) are always encoded in UTF-8, even if the result is indistinguishable from ascii.

Bit `3` is usually set in the Local File Header.
To support both a streaming input and streaming output api,
it is impossible to know the crc32 before processing the file data.
When bit `3` is set, data Descriptors are given after each file data with this information, as per the spec.
But remember a complete metadata listing is still always available in the central directory record,
so if unzip implementations are relying on that, like they should,
none of this paragraph will matter anyway.
Even so, some popular unzip implementations do not follow the spec.
The Mac Archive Utility requires Data Descriptors to include the optional signature,
so yazl includes the optional data descriptor signature.
When bit `3` is not used, the Mac Archive Utility requires there to be no data descriptor, so yazl skips it in that case.
Additionally, 7-Zip 9.20 does not seem to support bit `3` at all
(see [issue #11](https://github.com/thejoshwolfe/yazl/issues/11)).

All other bits are unset.

### Internal File Attributes

Always `0`.
The "apparently an ASCII or text file" bit is always unset meaning "apparently binary".
This kind of determination is outside the scope of yazl,
and is probably not significant in any modern unzip implementation.

### External File Attributes

Always `stats.mode << 16`.
This is apparently the convention for "version made by" = `0x03xx` (UNIX).

Note that for directory entries (see `addEmptyDirectory()`),
it is conventional to use the lower 8 bits for the MS-DOS directory attribute byte.
However, the spec says this is only required if the Version Made By is DOS,
so this library does not do that.

### Directory Entries

When adding a `metadataPath` such as `"parent/file.txt"`, yazl does not add a directory entry for `"parent/"`,
because file entries imply the need for their parent directories.
Unzip clients seem to respect this style of pathing,
and the zip file spec does not specify what is standard in this regard.

In order to create empty directories, use `addEmptyDirectory()`.

### Size of Local File and Central Directory Entry Metadata

The spec recommends that "The combined length of any directory record and [the file name,
extra field, and comment fields] should not generally exceed 65,535 bytes".
yazl makes no attempt to respect this recommendation.
Instead, each of the fields is limited to 65,535 bytes due to the length of each being encoded as an unsigned 16 bit integer.

## Change History

