
import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import MimeTypes from './mime-types.mjs';

/**
 * @typedef {object} CorsOptions
 * @property {string|RegExp} [origin]
 * @property {string|string[]} [methods]
 * @property {boolean} [credentials]
 * @property {string|string[]} [allowedHeaders]
 * @property {number} [maxAge]
 * @property {string|string[]} [exposedHeaders]
 */

/**
 * @typedef {object} SendFileOptions
 * @property {boolean} [acceptRanges]
 * @property {boolean} [cacheControl]
 * @property {boolean} [etag]
 * @property {boolean} [immutable]
 * @property {boolean} [lastModified]
 * @property {boolean|CorsOptions} [cors]
 * @property {number|string} [maxage]
 * @property {string} [mimeDbJsonPath]
 */

export default class SendFile {
  /**
   * Maximum value allowed for the max age (1 year).
   * @private
   */
  static MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000;
  /**
   * Regular expression for identifying a bytes Range header.
   * @private
   */
  static BYTES_RANGE_REGEXP = /^ *bytes=/;
  /**
   * @private
   */
  static CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;
  /**
   * RegExp to match field-name in RFC 7230 sec 3.2
   * @private
   */
  static FIELD_NAME_REGEXP = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

  /**
   * @constructor
   * @param {SendFileOptions} [options] 
   */
  constructor(options) {
    const opts = Object.assign({}, {
      acceptRanges: true,
      cacheControl: true,
      etag: true,
      lastModified: true,
      cors: true,
      maxage: 0,
    }, options || {});

    this._options = opts;

    const maxage = this._ms(opts.maxage);
    this._maxage = !Number.isNaN(maxage) ? Math.min(Math.max(0, maxage), SendFile.MAX_MAXAGE) : 0;

    this._mime = new MimeTypes(opts.mimeDbJsonPath);
  }

  /**
   * @private
   * @param {string|number} value 
   * @returns {number} 
   */
  _ms(value) {
    if (typeof value === 'number') {
      return value;
    }
    if (!value) {
      return Number.NaN;
    }
    if (value.length > 100) {
      return Number.NaN;
    }
    const re = /^(?<value>-?(?:\d+)?\.?\d+) *(?<type>milliseconds?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|years?|yrs?|y)?$/i;
    const match = re.exec(value);
    if (!match || !match.groups) {
      return Number.NaN;
    }
    const n = Number.parseFloat(match.groups.value);
    const type = (match.groups.type || 'ms').toLowerCase();

    const s = 1000;
    const m = s * 60;
    const h = m * 60;
    const d = h * 24;

    if (type.match(/^(years?|yrs?|y)$/i)) {
      return n * d * 365.25;
    } else if (type.match(/^(weeks?|w)$/i)) {
      return n * d * 7;
    } else if (type.match(/^(days?|d)$/i)) {
      return n * d;
    } else if (type.match(/^(hours?|hrs?|h)$/i)) {
      return n * h;
    } else if (type.match(/^(minutes?|mins?|m)$/i)) {
      return n * m;
    } else if (type.match(/^(seconds?|secs?|s)$/i)) {
      return n * s;
    } else if (type.match(/^(milliseconds?|msecs?|ms)$/i)) {
      return n;
    }
    return Number.NaN;
  }

  /**
   * Parse an HTTP Date into a number.
   *
   * @param {string} date
   * @returns {number}
   * @private
   */
  _parseHttpDate(date) {
    const timestamp = date && Date.parse(date);
    return typeof timestamp === 'number' ? timestamp : Number.NaN;
  }

  /**
   * Parse a HTTP token list.
   *
   * @param {string} str
   * @returns {string[]}
   * @private
   */
  _parseTokenList(str) {
    if (!str) return [];
    return (str || '').split(',').map(x => x.trim()).filter(Boolean);
  }

  /**
   * Check if this is a conditional GET request.
   *
   * @param {nodeHttp.IncomingMessage} req 
   * @return {boolean}
   * @private
   */
  _isConditionalGET(req) {
    return req.headers['if-match'] || req.headers['if-unmodified-since'] ||
      req.headers['if-none-match'] || req.headers['if-modified-since'];
  }

  /**
   * Check if the request preconditions failed.
   *
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @return {boolean}
   * @private
   */
  _isPreconditionFailure(req, res) {
    // if-match
    const match = req.headers['if-match'];
    if (match) {
      const etag = res.getHeader('ETag');
      return !etag || (match !== '*' && this._parseTokenList(match).every((val) => {
        return val !== etag && val !== `W/${etag}` && `W/${val}` !== etag;
      }));
    }

    // if-unmodified-since
    const unmodifiedSince = this._parseHttpDate(req.headers['if-unmodified-since']);
    if (!Number.isNaN(unmodifiedSince)) {
      const lastModified = this._parseHttpDate(res.getHeader('Last-Modified'));
      return Number.isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
  }

  /**
   * Check if the request is cacheable, aka
   * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
   *
   * @param {nodeHttp.ServerResponse} res 
   * @return {Boolean}
   * @private
   */
  _isCachable(res) {
    const statusCode = res.statusCode;
    return (statusCode >= 200 && statusCode < 300) || statusCode === 304;
  }

  /**
   * Check if the cache is fresh.
   *
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @return {boolean}
   * @private
   */
  _isFresh(req, res) {
    const reqHeaders = req.headers;
    const resHeaders = {
      etag: res.getHeader('ETag'),
      'last-modified': res.getHeader('Last-Modified')
    };

    // fields
    const modifiedSince = reqHeaders['if-modified-since'];
    const noneMatch = reqHeaders['if-none-match'];

    // unconditional request
    if (!modifiedSince && !noneMatch) {
      return false;
    }

    // Always return stale when Cache-Control: no-cache
    // to support end-to-end reload requests
    // https://tools.ietf.org/html/rfc2616#section-14.9.4
    const cacheControl = reqHeaders['cache-control'];
    if (cacheControl && SendFile.CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
      return false;
    }

    // if-none-match takes precedent over if-modified-since
    if (noneMatch) {
      if (noneMatch === '*') {
        return true;
      }

      const etag = resHeaders.etag;
      if (!etag) {
        return false;
      }

      const matches = this._parseTokenList(noneMatch);
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if (match === etag || match === 'W/' + etag || 'W/' + match === etag) {
          return true;
        }
      }

      return false;
    }

    // if-modified-since
    if (modifiedSince) {
      const lastModified = resHeaders['last-modified'];
      const modifiedStale = !lastModified || !(this._parseHttpDate(lastModified) <= this._parseHttpDate(modifiedSince));

      if (modifiedStale) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if the range is fresh.
   *
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @return {boolean}
   * @private
   */
  _isRangeFresh(req, res) {
    const ifRange = req.headers['if-range'];
    if (!ifRange) {
      return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
      const etag = res.getHeader('ETag');
      return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    const lastModified = res.getHeader('Last-Modified');
    return this._parseHttpDate(lastModified) <= this._parseHttpDate(ifRange);
  }

  /**
   * Escape special characters in the given string of text.
   *
   * @param  {string} text The string to escape for inserting into HTML
   * @return {string}
   * @private
   */
  _escapeHtml(text) {
    const str = '' + text;
    const match = /["'&<>]/.exec(str);

    if (!match) {
      return str;
    }

    let escape = '';
    let html = '';
    let index = 0;
    let lastIndex = 0;

    for (index = match.index; index < str.length; index++) {
      switch (str.charCodeAt(index)) {
        case 34: // "
          escape = '&quot;';
          break
        case 38: // &
          escape = '&amp;';
          break
        case 39: // '
          escape = '&#39;';
          break
        case 60: // <
          escape = '&lt;';
          break
        case 62: // >
          escape = '&gt;';
          break;
        default:
          continue;
      }

      if (lastIndex !== index) {
        html += str.substring(lastIndex, index);
      }

      lastIndex = index + 1;
      html += escape;
    }

    return lastIndex !== index ? html + str.substring(lastIndex, index) : html;
  }

  /**
   * Parse "Range" header `str` relative to the given file `size`.
   *
   * @param {number} size
   * @param {string} str
   * @param {boolean} [combine]
   * @return {Array<{ start: number, end: number }>|-1|-2}
   * @private
   */
  _parseRange(size, str, combine = true) {
    if (typeof str !== 'string') {
      throw new TypeError('argument str must be a string');
    }

    const index = str.indexOf('=');
    if (index === -1) {
      return -2;
    }

    // split the range string
    const arr = str.slice(index + 1).split(',');
    const ranges = [];
    let valid = false;

    // add ranges type
    ranges.type = str.slice(0, index);

    const parsePos = (str) => {
      if (/^\d+$/.test(str)) return Number(str);
      return Number.NaN;
    };

    // parse all ranges
    for (const part of arr) {
      const indexOf = part.indexOf('-');
      if (indexOf === -1) {
        continue;
      }

      const startStr = part.slice(0, indexOf).trim();
      const endStr = part.slice(indexOf + 1).trim();

      let start = parsePos(startStr);
      let end = parsePos(endStr);

      if (startStr.length === 0) {
        start = Math.max(size - end, 0)
        end = size - 1;
      } else if (endStr.length === 0) {
        end = size - 1;
      }

      // limit last-byte-pos to current length
      if (end > size - 1) {
        end = size - 1;
      }

      // invalid format range
      if (Number.isNaN(start) || Number.isNaN(end)) {
        continue;
      }

      // skip unsatisfiable ranges
      if (start > end) {
        valid = true;
        continue;
      }

      // add range
      ranges.push({
        start: start,
        end: end
      });
    }

    if (ranges.length < 1) {
      return valid ? -1 : -2;
    }

    if (!combine) {
      return ranges;
    }

    const ordered = ranges.map((range, index) => {
      return {
        start: range.start,
        end: range.end,
        index: index
      };
    }).sort((a, b) => a.start - b.start);

    let j = 0;
    for (let i = 1; i < ordered.length; i++) {
      const range = ordered[i];
      const current = ordered[j];

      if (range.start > current.end + 1) {
        // next range
        ordered[++j] = range;
      } else if (range.end > current.end) {
        // extend range
        current.end = range.end;
        current.index = Math.min(current.index, range.index);
      }
    }

    // trim ordered array
    ordered.length = j + 1;

    // generate combined range
    const combined = ordered.sort((a, b) => a.index - b.index).map((range) => {
      return {
        start: range.start,
        end: range.end
      };
    });

    // copy ranges type
    combined.type = ranges.type;

    return combined;
  }

  /**
   * Create a Content-Range header.
   *
   * @private
   * @param {string} type
   * @param {number} size
   * @param {{ start: number, end: number }} [range]
   * @returns {string}
   */
  _contentRange(type, size, range) {
    const val = range ? `${range.start}-${range.end}` : '*';
    return `${type} ${val}/${size}`;
  }

  /**
   * @private
   * @param {string} origin 
   * @param {string|RegExp|Array<string|RegExp>} allowedOrigin 
   * @returns 
   */
  _isOriginAllowed(origin, allowedOrigin) {
    if (Array.isArray(allowedOrigin)) {
      for (const allowed of allowedOrigin) {
        if (this._isOriginAllowed(origin, allowed)) {
          return true;
        }
      }
      return false;

    } else if (typeof allowedOrigin === 'string') {
      return origin === allowedOrigin;

    } else if (allowedOrigin instanceof RegExp) {
      return allowedOrigin.test(origin);

    }

    return !!allowedOrigin;
  }

  /**
   * @private
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @param {CorsOptions} [options] 
   */
  _cors(req, res, options) {
    const opts = Object.assign({}, {
      origin: '*',
      methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    }, options || {});

    const method = (req.method || 'GET').toLocaleUpperCase();
    const varies = (res.getHeader('Vary') || '').split(',');

    // configure Origin
    if (!opts.origin || opts.origin === '*') {
      res.setHeader('Access-Control-Allow-Origin', '*');

    } else {
      varies.push('Origin');

      if (typeof opts.origin === 'string') {
        res.setHeader('Access-Control-Allow-Origin', opts.origin);

      } else {
        const requestOrigin = req.headers.origin;
        const isAllowed = this._isOriginAllowed(requestOrigin, opts.origin);
        res.setHeader('Access-Control-Allow-Origin', isAllowed ? requestOrigin : false);
      }
    }

    // configure Credentials
    if (opts.credentials === true) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }

    if (method === 'OPTIONS') {
      // configure Methods
      if (opts.methods) {
        const methods = [].concat(opts.methods).join(',');
        if (methods) res.setHeader('Access-Control-Allow-Methods', methods);
      }

      // configure AllowedHeaders
      let allowedHeaders = req.headers['access-control-request-headers'];
      if (opts.allowedHeaders) {
        allowedHeaders = [].concat(opts.allowedHeaders).join(',');

      } else {
        varies.push('Access-Control-Request-Headers');
      }
      res.setHeader('Access-Control-Allow-Headers', allowedHeaders);

      // configure MaxAge
      const maxAge = typeof opts.maxAge === 'number' ? opts.maxAge : 0;
      if (maxAge > 0) res.setHeader('Access-Control-Max-Age', `${maxAge}`);
    }

    // configure ExposedHeaders
    if (opts.exposedHeaders) {
      const exposedHeaders = [].concat(opts.exposedHeaders).join(',');
      if (exposedHeaders) res.setHeader('Access-Control-Expose-Headers', exposedHeaders);
    }

    const vary = varies.reduce((arr, x) => {
      if (arr.indexOf('*')) return arr;

      const val = x.trim().toLocaleLowerCase();
      if (arr.includes(val)) return arr;

      if (SendFile.FIELD_NAME_REGEXP.test(val)) {
        arr.push(val);
      }

      return arr;
    }, []).join(',');

    if (vary.length) res.setHeader('Vary', vary);
  }

  /**
   * Stream `path` to the response.
   *
   * @param {string} path
   * @param {nodeHttp.ServerResponse} res 
   * @param {nodeFs.ReadStreamOptions} options
   * @returns {Promise<nodeHttp.ServerResponse>}
   * @private
   */
  _stream(path, res, options) {
    return new Promise((resolve, reject) => {
      // pipe
      const stream = nodeFs.createReadStream(path, options);
      stream.pipe(res);

      // cleanup
      const cleanup = () => {
        stream.destroy();
      };

      // response finished, cleanup
      res.on('finish', () => {
        process.nextTick(() => {
          cleanup();
          resolve(res);
        });
      });

      // error handling
      stream.on('error', (err) => {
        // clean up stream early
        cleanup();

        // error
        reject(err);
      });
    });
  }

  /**
   * Emit error with `status`
   * 
   * @private
   * @param {*} status 
   * @param {*} err 
   * @param {nodeHttp.ServerResponse} res 
   */
  _sendError(status, err, res) {
    const msg = nodeHttp.STATUS_CODES[status] || `${status}`;
    const doc = `<!DOCTYPE html>
    <html lang="en">
      <head><meta charset="utf-8"><title>Error</title></head>
      <body><pre>${this._escapeHtml(msg)}</pre></body>
    </html>`;

    // clear existing headers
    const headerNames = res.getHeaderNames();
    for (const header of headerNames) {
      res.removeHeader(header);
    }

    // add error headers
    if (err && err.headers) {
      const keys = Object.keys(err.headers);
      for (const key of keys) {
        res.setHeader(key, err.headers[key]);
      }
    }

    // send basic response
    res.statusCode = status;
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Content-Length', Buffer.byteLength(doc));
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(doc);
  }

  /**
   * Response a file
   * 
   * @param {string} filePath 
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @param {nodeFs.ReadStreamOptions} [options] 
   * @returns {Promise<boolean|number>}
   */
  async send(filePath, req, res, options = {}) {
    const opts = this._options;

    try {
      if (!filePath || typeof filePath !== 'string') {
        throw new TypeError("filePath must be a string value");
      }
      
      const path = nodePath.resolve(filePath);

      await nodeFs.promises.access(path, nodeFs.constants.R_OK);

      const stat = await nodeFs.promises.stat(path);
      if (!stat.isFile()) {
        return 404;
      }

      if (res.headersSent) {
        // impossible to send now
        return false;
      }

      // set header fields
      if (opts.acceptRanges && !res.getHeader('Accept-Ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      if (opts.cacheControl && !res.getHeader('Cache-Control')) {
        let cacheControl = `public, max-age=${Math.floor(this._maxage / 1000)}`;
        if (opts.immutable) {
          cacheControl += ', immutable';
        }

        res.setHeader('Cache-Control', cacheControl);
      }

      if (opts.lastModified && !res.getHeader('Last-Modified')) {
        const modified = stat.mtime.toUTCString();
        res.setHeader('Last-Modified', modified);
      }

      if (opts.etag && !res.getHeader('ETag')) {
        const mtime = stat.mtime.getTime().toString(16);
        const size = stat.size.toString(16);
        res.setHeader('ETag', `W/"${size}-${mtime}"`);
      }

      // set content-type
      if (!res.getHeader('Content-Type')) {
        const ext = nodePath.extname(path);
        const type = this._mime.contentType(ext) || 'application/octet-stream';

        res.setHeader('Content-Type', type);
      }

      // conditional GET support
      if (this._isConditionalGET(req)) {
        if (this._isPreconditionFailure(req, res)) {
          return 412;
        }

        if (this._isCachable(res) && this._isFresh(req, res)) {
          // not modified
          const headerNames = ['Content-Encoding', 'Content-Language', 'Content-Length', 'Content-Range', 'Content-Type'];
          for (const header of headerNames) {
            res.removeHeader(header);
          }

          res.statusCode = 304;
          res.end();
          return true;
        }
      }

      // adjust len to start/end options
      let len = stat.size;
      let offset = options && options.start || 0;

      len = Math.max(0, len - offset);
      if (options && options.end !== undefined) {
        const bytes = options.end - offset + 1;
        if (len > bytes) len = bytes;
      }

      // Range support
      const range = req.headers.range;
      if (opts.acceptRanges && SendFile.BYTES_RANGE_REGEXP.test(range)) {
        // parse
        let ranges = this._parseRange(len, range, true);

        // If-Range support
        if (!this._isRangeFresh(req, res)) {
          ranges = -2;
        }

        // unsatisfiable
        if (ranges === -1) {
          // Content-Range
          res.setHeader('Content-Range', this._contentRange('bytes', len));

          // 416 Requested Range Not Satisfiable
          this._sendError(416, {
            headers: { 'Content-Range': res.getHeader('Content-Range') }
          }, res);

          return true;
        }

        // valid (syntactically invalid/multiple ranges are treated as a regular response)
        if (ranges !== -2 && ranges.length === 1) {
          // Content-Range
          res.statusCode = 206;
          res.setHeader('Content-Range', this._contentRange('bytes', len, ranges[0]));

          // adjust for requested range
          offset += ranges[0].start;
          len = ranges[0].end - ranges[0].start + 1;
        }
      }

      // CORS support
      if (opts.cors) {
        const corsOpts = Object.assign({}, {
          maxAge: this._maxage
        }, opts.cors === true ? {} : opts.cors);

        this._cors(req, res, corsOpts);
      }

      // OPTIONS support
      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        res.end();
        return true;
      }

      // content-length
      res.setHeader('Content-Length', len);

      // HEAD support
      if (req.method === 'HEAD') {
        res.end();
        return true;
      }

      // clone options into read options
      const streamOpts = Object.assign({}, options, {
        start: offset,
        end: Math.max(offset, offset + len - 1),
      });

      await this._stream(path, res, streamOpts);

    } catch (err) {
      if (err && ['ENOENT', 'ENAMETOOLONG'].includes(err.code)) {
        return 404;
      }

      return err.status ?? 500;
    }
  }
}