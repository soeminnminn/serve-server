

import * as nodeFs from 'node:fs';
import nodeHttp from 'node:http';
import MimeTypes from './mime-types.mjs';
import HttpError from './http-error.mjs';


export default class ResponseFile {
  /**
   * @constructor
   * @param {{acceptRanges: boolean, cacheControl: boolean, lastModified: boolean, etag: boolean }} [options] 
   */
  constructor(options = {}) {
    this._options = Object.assign({}, {
      acceptRanges: true,
      cacheControl: true,
      lastModified: true,
      etag: true,
    }, options);

    this._mimeTypes = new MimeTypes('mime-db.json');
    this._defaultMimeType = this._mimeTypes.lookup('bin');
  }

  /**
   * @private
   * @param {string} pathExt 
   * @returns {string}
   */
  _mimeLookup(pathExt) {
    const ext = pathExt.replace(/.*[\.\/\\]/, "").toLowerCase();
    return this._mimeTypes.lookup(ext) || this._defaultMimeType;
  }

  /**
   * @private
   * @param {string} date 
   * @returns {number}
   */
  _parseHttpDate(date) {
    const timestamp = date && Date.parse(date);
    // istanbul ignore next: guard against date.js Date.parse patching
    return typeof timestamp === 'number' ? timestamp : NaN;
  }

  /**
   * @private
   * @param {string} str 
   * @returns {string[]}
   */
  _parseTokenList(str) {
    let end = 0;
    const list = [];
    let start = 0;

    // gather tokens
    for (let i = 0, len = str.length; i < len; i++) {
      switch (str.charCodeAt(i)) {
        case 0x20: /*   */
          if (start === end) {
            start = end = i + 1;
          }
          break;
        case 0x2c: /* , */
          list.push(str.substring(start, end));
          start = end = i + 1;
          break;
        default:
          end = i + 1;
          break;
      }
    }

    // final token
    list.push(str.substring(start, end));
    return list;
  }

  /**
   * @private
   * @param {nodeFs.Stats} stat 
   * @returns {string}
   */
  _statusETag(stat) {
    const mtime = stat.mtime.getTime().toString(16);
    const size = stat.size.toString(16);
    return `W/"${size}-${mtime}"`;
  }

  /**
   * Check freshness of the response using request and response headers.
   * 
   * @private
   * @param {Record<string, string>} reqHeaders 
   * @param {Record<string, string>} resHeaders 
   * @returns {boolean} 
   */
  _fresh(reqHeaders, resHeaders) {
    const CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

    // fields
    const modifiedSince = reqHeaders['if-modified-since'];
    const noneMatch = reqHeaders['if-none-match'];
    const cacheControl = reqHeaders['cache-control'];

    const etag = resHeaders['etag'];
    const lastModified = resHeaders['last-modified'];

    // unconditional request
    if (!modifiedSince && !noneMatch) {
      return false;
    }

    // Always return stale when Cache-Control: no-cache
    // to support end-to-end reload requests
    // https://tools.ietf.org/html/rfc2616#section-14.9.4
    if (cacheControl && CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
      return false;
    }

    // if-none-match
    if (noneMatch && noneMatch !== '*') {
      if (!etag) {
        return false;
      }

      let etagStale = true;
      const matches = this._parseTokenList(noneMatch);
      for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if (match === etag || match === 'W/' + etag || 'W/' + match === etag) {
          etagStale = false;
          break;
        }
      }

      if (etagStale) {
        return false;
      }
    }

    // if-modified-since
    if (modifiedSince) {
      const modifiedStale = !lastModified || !(this._parseHttpDate(lastModified) <= this._parseHttpDate(modifiedSince));

      if (modifiedStale) {
        return false;
      }
    }

    return true;
  }

  /**
   * Parse "Range" header `str` relative to the given file `size`.
   * 
   * @private
   * @param {number} size
   * @param {string} str
   * @param {boolean} combine
   * @return {number|Array<{ start: number, end: number }>}
   */
  _parseRange(size, str, combine) {
    if (typeof str !== 'string') {
      throw new TypeError('argument str must be a string');
    }

    if (!/^ *bytes=/.test(str)) {
      return -1;
    }

    let index = str.indexOf('=');
    if (index === -1) {
      return -2;
    }

    // split the range string
    const arr = str.slice(index + 1).split(',');
    const ranges = [];
    ranges.type = str.slice(0, index);

    // parse all ranges
    for (let i = 0; i < arr.length; i++) {
      const range = arr[i].split('-');
      let start = parseInt(range[0], 10);
      let end = parseInt(range[1], 10);

      // -nnn
      if (isNaN(start)) {
        start = size - end;
        end = size - 1;
        // nnn-
      } else if (isNaN(end)) {
        end = size - 1;
      }

      // limit last-byte-pos to current length
      if (end > size - 1) {
        end = size - 1;
      }

      // invalid or unsatisifiable
      if (isNaN(start) || isNaN(end) || start > end || start < 0) {
        continue;
      }

      // add range
      ranges.push({
        start: start,
        end: end
      });
    }

    if (ranges.length < 1) {
      // unsatisifiable
      return -1;
    }

    if (combine !== true) {
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
      let current = ordered[j];

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
   * @private
   * @param {Record<string, string>} reqHeaders 
   * @param {Record<string, string>} resHeaders 
   * @returns {boolean} 
   */
  _isRangeFresh(reqHeaders, resHeaders) {
    const ifRange = reqHeaders['if-range'];
    const etag = resHeaders['etag'];
    const lastModified = resHeaders['last-modified'];

    if (!ifRange) {
      return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
      return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    return this._parseHttpDate(lastModified) <= this._parseHttpDate(ifRange);
  }

  /**
   * @private
   * @param {Record<string, string>} reqHeaders 
   * @returns {boolean} 
   */
  _isConditionalGET(reqHeaders) {
    return reqHeaders['if-match'] || reqHeaders['if-unmodified-since'] ||
      reqHeaders['if-none-match'] || reqHeaders['if-modified-since'];
  }

  /**
   * @private
   * @param {Record<string, string>} reqHeaders 
   * @param {Record<string, string>} resHeaders 
   * @returns {boolean} 
   */
  _isPreconditionFailure(reqHeaders, resHeaders) {
    const etag = resHeaders['etag'];
    const lastModified = resHeaders['last-modified'];

    // if-match
    const match = reqHeaders['if-match'];
    if (match) {
      return !etag || (match !== '*' && this._parseTokenList(match).every((match) => {
        return match !== etag && match !== 'W/' + etag && 'W/' + match !== etag;
      }));
    }

    // if-unmodified-since
    const unmodifiedSince = this._parseHttpDate(reqHeaders['if-unmodified-since']);
    if (!Number.isNaN(unmodifiedSince)) {
      const lastModifiedDate = this._parseHttpDate(lastModified);
      return Number.isNaN(lastModifiedDate) || lastModifiedDate > unmodifiedSince;
    }

    return false;
  }

  /**
   * Send file
   * @param {string} filePath 
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @returns {Promise<false|undefined>}
   */
  async send(filePath, req, res) {
    const opts = this._options;

    if (res.destroyed || res.writableEnded) {
      return;
    }

    try {
      if (!filePath || typeof filePath !== 'string') {
        throw new TypeError("filePath must be a string value");
      }

      await nodeFs.promises.access(filePath, nodeFs.constants.R_OK);

      const stat = await nodeFs.promises.stat(filePath);
      if (!stat.isFile()) {
        throw new Error('Invalid file path');
      }

      const mimeType = this._mimeLookup(filePath);
      const charset = this._mimeTypes.charset(mimeType);
      const modified = stat.mtime.toUTCString();
      const etag = this._statusETag(stat);

      let statusCode = res ? res.statusCode : 200;
      const reqHeaders = req.headers;
      const resHeaders = {
        'etag': res ? res.getHeader('ETag') : etag,
        'last-modified': res ? res.getHeader('Last-Modified') : modified
      };

      let headers = {
        ...(opts.headers || {}),
      };

      if (this._isConditionalGET(reqHeaders)) {
        if (this._isPreconditionFailure(reqHeaders, resHeaders)) {
          statusCode = 412;

        } else {
          const isCachable = (statusCode >= 200 && statusCode < 300) || statusCode === 304;
          if (isCachable && this._fresh(reqHeaders, resHeaders)) {
            statusCode = 304;
          }
        }
      }

      let start = 0;
      let len = Math.max(0, stat.size);

      if (statusCode != 304 && statusCode != 412) {
        if (opts.acceptRanges && !headers['Accept-Ranges']) {
          headers['Accept-Ranges'] = 'bytes';
        }

        if (opts.cacheControl && !headers['Cache-Control']) {
          const MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; // 1 year
          const maxage = opts.maxage || MAX_MAXAGE;

          let cacheControl = `public, max-age=${Math.floor(maxage / 1000)}`;
          if (opts.immutable) {
            cacheControl += ', immutable';
          }
          headers['Cache-Control'] = cacheControl;
        }

        if (opts.lastModified && !headers['Last-Modified']) {
          headers['Last-Modified'] = modified;
        }

        if (opts.etag && !headers['ETag']) {
          headers['ETag'] = etag;
        }

        headers['Content-Type'] = mimeType + (charset ? `; charset=${charset}` : '');

        const range = req.headers.range;
        if (opts.acceptRanges && /^ *bytes=/.test(range)) {
          let ranges = this._parseRange(len, range, true);
          if (!this._isRangeFresh(reqHeaders, resHeaders)) {
            ranges = -2;
          }

          if (ranges === -1) {
            statusCode = 416;
            headers = {
              'Content-Range': `bytes */${len}`
            };

          } else if (ranges !== -2 && ranges.length === 1) {
            statusCode = 206;
            const range = ranges[0];
            headers['Content-Range'] = `bytes ${range.start}-${range.end}/${len}`;

            start += range.start;
            len = range.end - range.start + 1;
          }
        }
      }

      if (![304, 412, 416].includes(statusCode)) {
        const head = Object.assign({
          'Content-Length': len,
          'Access-Control-Allow-Origin': req.headers.origin || '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }, headers || {});

        if (req.method === 'HEAD' || req.method === 'head') {
          res.writeHead(statusCode, head);
          res.end();

        } else {
          const end = Math.max(start, start + len - 1);
          const stream = nodeFs.createReadStream(filePath, { start, end });

          res.writeHead(statusCode, head);

          const cleanUp = () => {
            process.nextTick(() => {
              stream.destroy();
            });
          };

          stream.on('error', (e) => {
            console.error(e);
            res.end();
            cleanUp();
          });

          stream.pipe(res);

          stream.on('close', () => {
            res.end();
          });

          res.on('finish', cleanUp);
        }

      } else {
        const msg = nodeHttp.STATUS_CODES[statusCode] || String(statusCode);
        const head = Object.assign({
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Security-Policy': "default-src 'none'",
          'X-Content-Type-Options': 'nosniff'
        }, headers || {});

        res.writeHead(statusCode, head);
        res.write(msg);
        res.end();
      }

    } catch (err) {
      if (err instanceof HttpError) {
        throw err;
      } else {
        throw new HttpError(500, err);
      }
    }
  }
}