import * as nodeFs from 'node:fs';
import nodePath from 'node:path';

/**
 * @see {@link https://github.com/jshttp/mime-types}
 */
export default class MimeTypes {
  /**
   * Score RFC facets (see https://tools.ietf.org/html/rfc6838#section-3)
   * @private
   */
  static FACET_SCORES = {
    'prs.': 100,
    'x-': 200,
    'x.': 300,
    'vnd.': 400,
    default: 900
  };

  /**
   * Score mime source (Logic originally from `jshttp/mime-types` module)
   * @private
   */
  static SOURCE_SCORES = {
    nginx: 10,
    apache: 20,
    iana: 40,
    default: 30 // definitions added by `jshttp/mime-db` project?
  };

  /**
   * @private
   */
  static TYPE_SCORES = {
    // prefer application/xml over text/xml
    // prefer application/rtf over text/rtf
    application: 1,

    // prefer font/woff over application/font-woff
    font: 2,

    // prefer video/mp4 over audio/mp4 over application/mp4
    // See https://www.rfc-editor.org/rfc/rfc4337.html#section-2
    audio: 2,
    video: 3,

    default: 0
  };

  /**
   * @private
   */
  static COMMON_TYPES = {
    'aac': 'audio/aac',
    'abw': 'application/x-abiword',
    'apng': 'image/apng',
    'arc': 'application/x-freearc',
    'avif': 'image/avif',
    'avi': 'video/x-msvideo',
    'azw': 'application/vnd.amazon.ebook',
    'bin': 'application/octet-stream',
    'bmp': 'image/bmp',
    'bz': 'application/x-bzip',
    'bz2': 'application/x-bzip2',
    'cda': 'application/x-cdf',
    'csh': 'application/x-csh',
    'css': 'text/css',
    'csv': 'text/csv',
    'doc': 'application/msword',
    'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'eot': 'application/vnd.ms-fontobject',
    'epub': 'application/epub+zip',
    'gz': 'application/gzip',
    'gif': 'image/gif',
    'htm': 'text/html',
    'html': 'text/html',
    'ico': 'image/vnd.microsoft.icon',
    'ics': 'text/calendar',
    'jar': 'application/java-archive',
    'jpeg': 'image/jpeg',
    'jpg': 'image/jpeg',
    'js': 'text/javascript',
    'json': 'application/json',
    'jsonld': 'application/ld+json',
    'md': 'text/markdown',
    'mid': 'audio/midi',
    'midi': 'audio/midi',
    'mjs': 'text/javascript',
    'm4a': 'audio/mp4',
    'mp3': 'audio/mpeg',
    'mp4': 'video/mp4',
    'mpeg': 'video/mpeg',
    'mpkg': 'application/vnd.apple.installer+xml',
    'odp': 'application/vnd.oasis.opendocument.presentation',
    'ods': 'application/vnd.oasis.opendocument.spreadsheet',
    'odt': 'application/vnd.oasis.opendocument.text',
    'oga': 'audio/ogg',
    'ogv': 'video/ogg',
    'ogx': 'application/ogg',
    'opus': 'audio/ogg',
    'otf': 'font/otf',
    'png': 'image/png',
    'pdf': 'application/pdf',
    'php': 'application/x-httpd-php',
    'ppt': 'application/vnd.ms-powerpoint',
    'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'rar': 'application/vnd.rar',
    'rtf': 'application/rtf',
    'sh': 'application/x-sh',
    'svg': 'image/svg+xml',
    'tar': 'application/x-tar',
    'tif': 'image/tiff',
    'tiff': 'image/tiff',
    'ts': 'video/mp2t',
    'ttf': 'font/ttf',
    'txt': 'text/plain',
    'vsd': 'application/vnd.visio',
    'wav': 'audio/wav',
    'weba': 'audio/webm',
    'webm': 'video/webm',
    'webmanifest': 'application/manifest+json',
    'webp': 'image/webp',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'xhtml': 'application/xhtml+xml',
    'xls': 'application/vnd.ms-excel',
    'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'xml': 'application/xml',
    'xul': 'application/vnd.mozilla.xul+xml',
    'zip': 'application/zip',
    '3g': 'video/3gpp',
    '3g2': 'video/3gpp2',
    '7z': 'application/x-7z-compressed',
  };

  /**
   * @private
   */
  static EXTRACT_TYPE_REGEXP = /^\s*([^;\s]*)(?:;|\s|$)/;

  /**
   * @private
   */
  static TEXT_TYPE_REGEXP = /^text\//i;

  /**
   * @constructor
   * @param {string} [mimeDbJson] 
   */
  constructor(mimeDbJson) {
    this.types = Object.assign({}, MimeTypes.COMMON_TYPES);
    this.charsets = {};
    this._populateMaps(mimeDbJson);
  }

  /**
   * @private
   * @param {string} mimeDbJson 
   */
  _populateMaps(mimeDbJson) {
    if (!mimeDbJson || typeof mimeDbJson !== 'string') {
      return;
    }

    const filePath = nodePath.resolve(mimeDbJson);

    if (nodeFs.existsSync(filePath)) {
      try {
        const content = nodeFs.readFileSync(filePath, 'utf-8');
        const db = JSON.parse(content);

        const keys = Object.keys(db);
        for (const type of keys) {
          const mime = db[type];
          const exts = mime.extensions;

          if (mime.charset) {
            this.charsets[type] = mime.charset;
          }

          if (!exts || !exts.length) {
            continue;
          }

          // extension -> mime
          for (let i = 0; i < exts.length; i++) {
            const extension = exts[i];
            this.types[extension] = this._preferredType(db, this.types[extension], type);
          }
        }

      } catch (err) {
        console.error('mimetypes file read error.', err);
      }
    }
  }

  /**
   * Resolve type conflict using mime-score
   * @private
   * 
   * @param {Record<string, {source?: string, charset?: string, compressible?: boolean, extensions?: string[] }>} db 
   * @param {string} type0 
   * @param {string} type1 
   * @returns {string}
   */
  _preferredType(db, type0, type1) {
    const score0 = type0 ? this._mimeScore(type0, db[type0].source) : 0;
    const score1 = type1 ? this._mimeScore(type1, db[type1].source) : 0;

    return score0 > score1 ? type0 : type1;
  }

  /**
   * Get each component of the score for a mime type.  The sum of these is the
   * total score.  The higher the score, the more "official" the type.
   * 
   * @private
   * @param {string} mimeType 
   * @param {string} [source='default'] 
   * @returns {number}
   */
  _mimeScore(mimeType, source = 'default') {
    if (mimeType === 'application/octet-stream') {
      return 0;
    }

    const [type, subtype] = mimeType.split('/');

    const facet = subtype.replace(/(\.|x-).*/, '$1');

    const facetScore = MimeTypes.FACET_SCORES[facet] || MimeTypes.FACET_SCORES.default;
    const sourceScore = MimeTypes.SOURCE_SCORES[source] || MimeTypes.SOURCE_SCORES.default;
    const typeScore = MimeTypes.TYPE_SCORES[type] || MimeTypes.TYPE_SCORES.default;

    // All else being equal prefer shorter types
    const lengthScore = 1 - mimeType.length / 100;

    return facetScore + sourceScore + typeScore + lengthScore;
  }

  /**
   * Lookup the MIME type for a file path/extension.
   *
   * @param {string} path
   * @return {false|string}
   */
  lookup(path) {
    if (!path || typeof path !== 'string') {
      return false;
    }

    // get the extension ("ext" or ".ext" or full path)
    const extension = nodePath.extname('x.' + path).toLowerCase().slice(1);
    if (!extension) {
      return false;
    }

    return this.types[extension] || false;
  }

  /**
   * @param {string} type 
   * @returns {string}
   */
  charset(type) {
    if (!type || typeof type !== 'string') {
      return false;
    }

    // TODO: use media-typer
    const match = MimeTypes.EXTRACT_TYPE_REGEXP.exec(type);
    const charset = match && this.charsets[match[1].toLowerCase()];

    if (charset) {
      return charset;
    }

    // default text/* to utf-8
    if (match && MimeTypes.TEXT_TYPE_REGEXP.test(match[1])) {
      return 'UTF-8';
    }

    return false;
  }

  /**
   * Create a full Content-Type header given a MIME type or extension.
   *
   * @param {string} str
   * @return {false|string}
   */
  contentType(str) {
    if (!str || typeof str !== 'string') {
      return false;
    }

    let mime = str.indexOf('/') === -1 ? this.lookup(str) : str;

    if (!mime) {
      return false
    }

    if (mime.indexOf('charset') === -1) {
      const charset = this.charset(mime);
      if (charset) mime += '; charset=' + charset.toLowerCase();
    }

    return mime;
  }
}