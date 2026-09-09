/**
 * @see {@link https://github.com/pillarjs/send}
 */

import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import nodeCrypto from 'node:crypto';
import { Stream } from 'node:stream';
import asyncHooks from 'node:async_hooks';
import MimeTypes from './mime-types.mjs';

/**
 * @see {@link https://github.com/jshttp/on-finished}
 */
class OnFinish {
  /**
   * @constructor
   */
  constructor() {
    this.defer = typeof setImmediate === 'function'
      ? setImmediate
      : function (fn, ...args) { process.nextTick(fn.bind.apply(fn, args)) };
  }

  /**
   * Invoke callback when the response has finished, useful for
   * cleaning up resources afterwards.
   *
   * @param {object} msg
   * @param {function} listener
   * @return {object}
   * @public
   */
  onFinished(msg, listener) {
    if (this.isFinished(msg) !== false) {
      this.defer(listener, null, msg);
      return msg;
    }

    // attach the listener to the message
    this.attachListener(msg, this.wrap(listener));

    return msg;
  }

  /**
   * Determine if message is already finished.
   *
   * @param {object} msg
   * @return {boolean}
   * @public
   */
  isFinished(msg) {
    const socket = msg.socket;
    const finished = this.writableEnded(msg);

    if (typeof finished === 'boolean') {
      // OutgoingMessage
      return Boolean(finished || (socket && !socket.writable));
    }

    if (typeof msg.complete === 'boolean') {
      // IncomingMessage
      return Boolean(msg.upgrade || !socket || !socket.readable || (msg.complete && !msg.readable));
    }

    // don't know
    return undefined;
  }

  /**
   * Attach a finished listener to the message.
   *
   * @param {object} msg
   * @param {function} callback
   * @private
   */
  attachFinishedListener(msg, callback) {
    let eeMsg;
    let eeSocket;
    let finished = false;

    const onFinish = (error) => {
      eeMsg.cancel();
      eeSocket.cancel();

      finished = true
      callback(error);
    };

    // finished on first message event
    eeMsg = eeSocket = this.eeFirst([[msg, 'end', 'finish']], onFinish);

    const onSocket = (socket) => {
      // remove listener
      msg.removeListener('socket', onSocket);

      if (finished) return
      if (eeMsg !== eeSocket) return;

      // finished on first socket event
      eeSocket = this.eeFirst([[socket, 'error', 'close']], onFinish);
    };

    if (msg.socket) {
      // socket already assigned
      onSocket(msg.socket);
      return;
    }

    // wait for socket to be assigned
    msg.on('socket', onSocket);

    if (msg.socket === undefined) {
      // istanbul ignore next: node.js 0.8 patch
      this.patchAssignSocket(msg, onSocket);
    }
  }

  /**
   * Attach the listener to the message.
   *
   * @param {object} msg
   * @return {function}
   * @private
   */
  attachListener(msg, listener) {
    let attached = msg.__onFinished;

    // create a private single listener with queue
    if (!attached || !attached.queue) {
      attached = msg.__onFinished = this.createListener(msg);
      this.attachFinishedListener(msg, attached);
    }

    attached.queue.push(listener);
  }

  /**
   * Create listener on message.
   *
   * @param {object} msg
   * @return {function}
   * @private
   */
  createListener(msg) {
    function listener(err) {
      if (msg.__onFinished === listener) msg.__onFinished = null;
      if (!listener.queue) return;

      const queue = listener.queue;
      listener.queue = null;

      for (let i = 0; i < queue.length; i++) {
        queue[i](err, msg);
      }
    }

    listener.queue = [];

    return listener;
  }

  /**
   * Patch ServerResponse.prototype.assignSocket for node.js 0.8.
   *
   * @param {ServerResponse} res
   * @param {function} callback
   * @private
   */
  patchAssignSocket(res, callback) {
    const assignSocket = res.assignSocket;

    if (typeof assignSocket !== 'function') return;

    // res.on('socket', callback) is broken in 0.8
    res.assignSocket = function _assignSocket(socket) {
      assignSocket.call(this, socket);
      callback(socket);
    };
  }

  /**
   * Wrap function with async resource, if possible.
   * AsyncResource.bind static method backported.
   * @private
   */
  wrap(fn) {
    let res;

    // create anonymous resource
    if (asyncHooks.AsyncResource) {
      res = new asyncHooks.AsyncResource(fn.name || 'bound-anonymous-fn');
    }

    // incompatible node.js
    if (!res || !res.runInAsyncScope) {
      return fn;
    }

    // return bound function
    return res.runInAsyncScope.bind(res, fn, null);
  }

  /**
   * Determines if a writable stream has finished.
   *
   * @param {Object} res
   * @returns {boolean}
   * @private
   */
  writableEnded(res) {
    return typeof res.writableEnded === 'boolean' ? res.writableEnded : res.finished;
  }

  /**
   * Get the first event in a set of event emitters and event pairs.
   *
   * @param {array} stuff
   * @param {function} done
   * @private
   */
  eeFirst(stuff, done) {
    if (!Array.isArray(stuff)) {
      throw new TypeError('arg must be an array of [ee, events...] arrays');
    }

    const cleanups = [];

    for (let i = 0; i < stuff.length; i++) {
      const arr = stuff[i];

      if (!Array.isArray(arr) || arr.length < 2) {
        throw new TypeError('each array member must be [ee, events...]')
      }

      const ee = arr[0];

      for (let j = 1; j < arr.length; j++) {
        const event = arr[j];
        const fn = this.eeFirstListener(event, callback);

        // listen to the event
        ee.on(event, fn);
        // push this listener to the list of cleanups
        cleanups.push({
          ee: ee,
          event: event,
          fn: fn
        });
      }
    }

    function callback() {
      cleanup();
      done.apply(null, arguments);
    }

    function cleanup() {
      let x;
      for (let i = 0; i < cleanups.length; i++) {
        x = cleanups[i];
        x.ee.removeListener(x.event, x.fn);
      }
    }

    function thunk(fn) {
      done = fn;
    }

    thunk.cancel = cleanup;

    return thunk;
  }

  /**
   * Create the event listener.
   * @private
   */
  eeFirstListener(event, done) {
    return function onevent(arg1) {
      const args = new Array(arguments.length);
      const ee = this;
      const err = event === 'error'
        ? arg1
        : null;

      // copy args to prevent arguments escaping scope
      for (let i = 0; i < args.length; i++) {
        args[i] = arguments[i];
      }

      done(err, ee, event, args);
    };
  }
}

/**
 * @see {@link https://github.com/jshttp/statuses}
 */
class Statuses {

  static CODES = {
    "100": "Continue",
    "101": "Switching Protocols",
    "102": "Processing",
    "103": "Early Hints",
    "200": "OK",
    "201": "Created",
    "202": "Accepted",
    "203": "Non-Authoritative Information",
    "204": "No Content",
    "205": "Reset Content",
    "206": "Partial Content",
    "207": "Multi-Status",
    "208": "Already Reported",
    "226": "IM Used",
    "300": "Multiple Choices",
    "301": "Moved Permanently",
    "302": "Found",
    "303": "See Other",
    "304": "Not Modified",
    "305": "Use Proxy",
    "307": "Temporary Redirect",
    "308": "Permanent Redirect",
    "400": "Bad Request",
    "401": "Unauthorized",
    "402": "Payment Required",
    "403": "Forbidden",
    "404": "Not Found",
    "405": "Method Not Allowed",
    "406": "Not Acceptable",
    "407": "Proxy Authentication Required",
    "408": "Request Timeout",
    "409": "Conflict",
    "410": "Gone",
    "411": "Length Required",
    "412": "Precondition Failed",
    "413": "Payload Too Large",
    "414": "URI Too Long",
    "415": "Unsupported Media Type",
    "416": "Range Not Satisfiable",
    "417": "Expectation Failed",
    "418": "I'm a Teapot",
    "421": "Misdirected Request",
    "422": "Unprocessable Entity",
    "423": "Locked",
    "424": "Failed Dependency",
    "425": "Too Early",
    "426": "Upgrade Required",
    "428": "Precondition Required",
    "429": "Too Many Requests",
    "431": "Request Header Fields Too Large",
    "451": "Unavailable For Legal Reasons",
    "500": "Internal Server Error",
    "501": "Not Implemented",
    "502": "Bad Gateway",
    "503": "Service Unavailable",
    "504": "Gateway Timeout",
    "505": "HTTP Version Not Supported",
    "506": "Variant Also Negotiates",
    "507": "Insufficient Storage",
    "508": "Loop Detected",
    "509": "Bandwidth Limit Exceeded",
    "510": "Not Extended",
    "511": "Network Authentication Required"
  };

  /**
   * @constructor
   */
  constructor() {
    // status code to message map
    this.message = Statuses.CODES;

    // status message (lower-case) to code map
    this.code = this.createMessageToStatusCodeMap(Statuses.CODES);

    // array of status codes
    this.codes = this.createStatusCodeList(codes);

    // status codes for redirects
    this.redirect = {
      300: true,
      301: true,
      302: true,
      303: true,
      305: true,
      307: true,
      308: true
    };

    // status codes for empty bodies
    this.empty = {
      204: true,
      205: true,
      304: true
    };

    // status codes for when you should retry the request
    this.retry = {
      502: true,
      503: true,
      504: true
    };
  }

  /**
   * Create a map of message to status code.
   * @private
   */
  createMessageToStatusCodeMap(codes) {
    const map = {};

    Object.keys(codes).forEach((code) => {
      var message = codes[code];
      var status = Number(code);

      // populate map
      map[message.toLowerCase()] = status;
    });

    return map;
  }

  /**
   * Create a list of all status codes.
   * @private
   */
  createStatusCodeList(codes) {
    return Object.keys(codes).map((code) => {
      return Number(code);
    });
  }

  /**
   * Get the status code for given message.
   * @private
   */
  getStatusCode(message) {
    const msg = message.toLowerCase();

    if (!Object.prototype.hasOwnProperty.call(this.code, msg)) {
      throw new Error('invalid status message: "' + message + '"');
    }

    return this.code[msg];
  }

  /**
   * Get the status message for given code.
   * @private
   */
  getStatusMessage(code) {
    if (!Object.prototype.hasOwnProperty.call(this.message, code)) {
      throw new Error('invalid status code: ' + code);
    }

    return this.message[code];
  }

  /**
  * Get the status code.
  *
  * Given a number, this will throw if it is not a known status
  * code, otherwise the code will be returned. Given a string,
  * the string will be parsed for a number and return the code
  * if valid, otherwise will lookup the code assuming this is
  * the status message.
  *
  * @param {string|number} code
  * @returns {number}
  * @public
  */
  status(code) {
    if (typeof code === 'number') {
      return this.getStatusMessage(code);
    }

    if (typeof code !== 'string') {
      throw new TypeError('code must be a number or string');
    }

    // '403'
    const n = parseInt(code, 10);
    if (!Number.isNaN(n)) {
      return this.getStatusMessage(n);
    }

    return this.getStatusCode(code);
  }
}

/**
 * @typedef {object} SendStreamOptions
 * @property {boolean} [acceptRanges]
 * @property {boolean} [cacheControl]
 * @property {boolean} [etag]
 * @property {boolean} [dotfiles]
 * @property {string[]} [extensions]
 * @property {boolean} [immutable]
 * @property {string[]} [index]
 * @property {boolean} [lastModified]
 * @property {number|string} [maxage]
 * @property {string} [root]
 */

/**
 * @example
 * const server = http.createServer((req, res) => {
 *    consr send = new SendStream(req, '/path/to/index.html');
 *    send.pipe(res);
 * });
 */
export default class SendStream extends Stream {
  /**
   * Regular expression for identifying a bytes Range header.
   * @private
   */
  static BYTES_RANGE_REGEXP = /^ *bytes=/;

  /**
   * Maximum value allowed for the max age.
   * @private
   */
  static MAX_MAXAGE = 60 * 60 * 24 * 365 * 1000; // 1 year

  /**
   * Regular expression to match a path with a directory up component.
   * @private
   */
  static UP_PATH_REGEXP = /(?:^|[\\/])\.\.(?:[\\/]|$)/;

  /**
   * @private
   */
  static ENCODE_CHARS_REGEXP = /(?:[^\x21\x23-\x3B\x3D\x3F-\x5F\x61-\x7A\x7C\x7E]|%(?:[^0-9A-Fa-f]|[0-9A-Fa-f][^0-9A-Fa-f]|$))+/g;
  /**
   * @private
   */
  static UNMATCHED_SURROGATE_PAIR_REGEXP = /(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]|[\uD800-\uDBFF]([^\uDC00-\uDFFF]|$)/g;
  /**
   * @private
   */
  static UNMATCHED_SURROGATE_PAIR_REPLACE = '$1\uFFFD$2';
  /**
   * @private
   */
  static CACHE_CONTROL_NO_CACHE_REGEXP = /(?:^|,)\s*?no-cache\s*?(?:,|$)/;

  /**
   * Initialize a `SendStream` with the given `path`.
   * 
   * @constructor
   * @param {nodeHttp.IncomingMessage} req 
   * @param {string} path 
   * @param {SendStreamOptions} [options] 
   */
  constructor(req, path, options) {
    super();

    const opts = options || {};

    this.options = opts;
    this.path = path;
    this.req = req;
    this.res = null;

    this._acceptRanges = opts.acceptRanges !== undefined
      ? Boolean(opts.acceptRanges)
      : true;

    this._cacheControl = opts.cacheControl !== undefined
      ? Boolean(opts.cacheControl)
      : true;

    this._etag = opts.etag !== undefined
      ? Boolean(opts.etag)
      : true;

    this._dotfiles = opts.dotfiles !== undefined
      ? opts.dotfiles
      : 'ignore';

    if (this._dotfiles !== 'ignore' && this._dotfiles !== 'allow' && this._dotfiles !== 'deny') {
      throw new TypeError('dotfiles option must be "allow", "deny", or "ignore"');
    }

    this._extensions = opts.extensions !== undefined
      ? this.normalizeList(opts.extensions, 'extensions option')
      : [];

    this._immutable = opts.immutable !== undefined
      ? Boolean(opts.immutable)
      : false;

    this._index = opts.index !== undefined
      ? this.normalizeList(opts.index, 'index option')
      : ['index.html'];

    this._lastModified = opts.lastModified !== undefined
      ? Boolean(opts.lastModified)
      : true;

    this._maxage = opts.maxage;
    this._maxage = typeof this._maxage === 'string'
      ? this.ms(this._maxage)
      : Number(this._maxage);
    this._maxage = !Number.isNaN(this._maxage)
      ? Math.min(Math.max(0, this._maxage), SendStream.MAX_MAXAGE)
      : 0;

    this._root = opts.root
      ? nodePath.resolve(opts.root)
      : null;

    this._mime = new MimeTypes();
    this._statuses = new Statuses();
    this._onFinished = new OnFinish();
  }

  /**
   * @private
   * @param {string|number} value 
   * @returns {number} 
   */
  ms(value) {
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
    const n = parseFloat(match.groups.value);
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
   * Emit error with `status`.
   *
   * @param {number} status
   * @param {Error} [err]
   * @private
   */
  error(status, err) {
    // emit if listeners instead of responding
    if (this.hasListeners(this, 'error')) {
      return this.emit('error', this.createHttpError(status, err));
    }

    const res = this.res;
    const msg = this._statuses.message[status] || String(status);
    const doc = this.createHtmlDocument('Error', this.escapeHtml(msg));

    // clear existing headers
    this.clearHeaders(res);

    // add error headers
    if (err && err.headers) {
      this.setHeaders(res, err.headers);
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
   * Check if the pathname ends with "/".
   *
   * @return {boolean}
   * @private
   */
  hasTrailingSlash() {
    return this.path[this.path.length - 1] === '/';
  }

  /**
   * Check if this is a conditional GET request.
   *
   * @return {Boolean}
   * @private
   */
  isConditionalGET() {
    return this.req.headers['if-match'] ||
      this.req.headers['if-unmodified-since'] ||
      this.req.headers['if-none-match'] ||
      this.req.headers['if-modified-since'];
  }

  /**
   * Check if the request preconditions failed.
   *
   * @return {boolean}
   * @private
   */
  isPreconditionFailure() {
    const req = this.req;
    const res = this.res;

    // if-match
    const match = req.headers['if-match'];
    if (match) {
      const etag = res.getHeader('ETag');
      return !etag || (match !== '*' && this.parseTokenList(match).every((val) => {
        return val !== etag && val !== 'W/' + etag && 'W/' + val !== etag;
      }));
    }

    // if-unmodified-since
    const unmodifiedSince = this.parseHttpDate(req.headers['if-unmodified-since']);
    if (!Number.isNaN(unmodifiedSince)) {
      const lastModified = this.parseHttpDate(res.getHeader('Last-Modified'));
      return Number.isNaN(lastModified) || lastModified > unmodifiedSince;
    }

    return false;
  }

  /**
   * Strip various content header fields for a change in entity.
   *
   * @private
   */
  removeContentHeaderFields() {
    const res = this.res;

    res.removeHeader('Content-Encoding');
    res.removeHeader('Content-Language');
    res.removeHeader('Content-Length');
    res.removeHeader('Content-Range');
    res.removeHeader('Content-Type');
  }

  /**
   * Respond with 304 not modified.
   *
   * @private
   */
  notModified() {
    const res = this.res;
    this.removeContentHeaderFields();
    res.statusCode = 304;
    res.end();
  }

  /**
   * Raise error that headers already sent.
   *
   * @private
   */
  headersAlreadySent() {
    const err = new Error('Can\'t set headers after they are sent.');
    this.error(500, err);
  }

  /**
   * Check if the request is cacheable, aka
   * responded with 2xx or 304 (see RFC 2616 section 14.2{5,6}).
   *
   * @return {Boolean}
   * @private
   */
  isCachable() {
    const statusCode = this.res.statusCode;
    return (statusCode >= 200 && statusCode < 300) ||
      statusCode === 304;
  }

  /**
   * Handle stat() error.
   *
   * @param {Error} error
   * @private
   */
  onStatError(error) {
    switch (error.code) {
      case 'ENAMETOOLONG':
      case 'ENOENT':
      case 'ENOTDIR':
        this.error(404, error);
        break;
      default:
        this.error(500, error);
        break;
    }
  }

  /**
   * Check if the cache is fresh.
   *
   * @return {boolean}
   * @private
   */
  isFresh() {
    return this.fresh(this.req.headers, {
      etag: this.res.getHeader('ETag'),
      'last-modified': this.res.getHeader('Last-Modified')
    });
  }

  /**
   * Check if the range is fresh.
   *
   * @return {boolean}
   * @private
   */
  isRangeFresh() {
    const ifRange = this.req.headers['if-range'];

    if (!ifRange) {
      return true;
    }

    // if-range as etag
    if (ifRange.indexOf('"') !== -1) {
      const etag = this.res.getHeader('ETag');
      return Boolean(etag && ifRange.indexOf(etag) !== -1);
    }

    // if-range as modified date
    const lastModified = this.res.getHeader('Last-Modified');
    return this.parseHttpDate(lastModified) <= this.parseHttpDate(ifRange);
  }

  /**
   * Redirect to path.
   *
   * @param {string} path
   * @private
   */
  redirect(path) {
    const res = this.res;

    if (this.hasListeners(this, 'directory')) {
      this.emit('directory', res, path);
      return;
    }

    if (this.hasTrailingSlash()) {
      this.error(403);
      return;
    }

    const loc = this.encodeUrl(this.collapseLeadingSlashes(this.path + '/'));
    const doc = this.createHtmlDocument('Redirecting', 'Redirecting to ' + this.escapeHtml(loc));

    // redirect
    res.statusCode = 301;
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Content-Length', Buffer.byteLength(doc));
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Location', loc);
    res.end(doc);
  }

  /**
   * Pipe to `res.
   *
   * @param {Stream} res
   * @return {Stream} res
   * @public
   */
  pipe(res) {
    // root path
    const root = this._root;

    // references
    this.res = res;

    // decode the path
    let path = this.decode(this.path);
    if (path === -1) {
      this.error(400);
      return res;
    }

    // null byte(s)
    if (~path.indexOf('\0')) {
      this.error(400);
      return res;
    }

    let parts;
    if (root !== null) {
      // normalize
      if (path) {
        path = nodePath.normalize('.' + nodePath.sep + path);
      }

      // malicious path
      if (SendStream.UP_PATH_REGEXP.test(path)) {
        this.error(403);
        return res;
      }

      // explode path parts
      parts = path.split(nodePath.sep);

      // join / normalize from optional root dir
      path = nodePath.normalize(nodePath.join(root, path));
    } else {
      // ".." is malicious without "root"
      if (SendStream.UP_PATH_REGEXP.test(path)) {
        this.error(403);
        return res;
      }

      // explode path parts
      parts = nodePath.normalize(path).split(nodePath.sep);

      // resolve the path
      path = nodePath.resolve(path);
    }

    // dotfile handling
    if (this.containsDotFile(parts)) {
      switch (this._dotfiles) {
        case 'allow':
          break;
        case 'deny':
          this.error(403);
          return res;
        case 'ignore':
        default:
          this.error(404);
          return res;
      }
    }

    // index file support
    if (this._index.length && this.hasTrailingSlash()) {
      this.sendIndex(path);
      return res;
    }

    this.sendFile(path);
    return res;
  }

  /**
   * Transfer `path`.
   *
   * @param {string} path
   * @param {nodeFs.Stats} stat 
   * @public
   */
  send(path, stat) {
    let len = stat.size;
    const options = this.options;
    const opts = {};
    const res = this.res;
    const req = this.req;
    let ranges = req.headers.range;
    let offset = options.start || 0;

    if (res.headersSent) {
      // impossible to send now
      this.headersAlreadySent();
      return;
    }

    // set header fields
    this.setHeader(path, stat);

    // set content-type
    this.type(path);

    // conditional GET support
    if (this.isConditionalGET()) {
      if (this.isPreconditionFailure()) {
        this.error(412);
        return;
      }

      if (this.isCachable() && this.isFresh()) {
        this.notModified();
        return;
      }
    }

    // adjust len to start/end options
    len = Math.max(0, len - offset);
    if (options.end !== undefined) {
      const bytes = options.end - offset + 1;
      if (len > bytes) len = bytes;
    }

    // Range support
    if (this._acceptRanges && SendStream.BYTES_RANGE_REGEXP.test(ranges)) {
      // parse
      ranges = this.parseRange(len, ranges, {
        combine: true
      });

      // If-Range support
      if (!this.isRangeFresh()) {
        ranges = -2;
      }

      // unsatisfiable
      if (ranges === -1) {

        // Content-Range
        res.setHeader('Content-Range', this.contentRange('bytes', len));

        // 416 Requested Range Not Satisfiable
        return this.error(416, {
          headers: { 'Content-Range': res.getHeader('Content-Range') }
        });
      }

      // valid (syntactically invalid/multiple ranges are treated as a regular response)
      if (ranges !== -2 && ranges.length === 1) {
        // Content-Range
        res.statusCode = 206;
        res.setHeader('Content-Range', this.contentRange('bytes', len, ranges[0]));

        // adjust for requested range
        offset += ranges[0].start;
        len = ranges[0].end - ranges[0].start + 1;
      }
    }

    // clone options
    for (const prop in options) {
      opts[prop] = options[prop];
    }

    // set read options
    opts.start = offset;
    opts.end = Math.max(offset, offset + len - 1);

    // content-length
    res.setHeader('Content-Length', len);

    // HEAD support
    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    this.stream(path, opts);
  }

  /**
   * Transfer file for `path`.
   *
   * @param {string} path
   * @private
   */
  sendFile(path) {
    let i = 0;
    let next = () => { };

    nodeFs.stat(path, (err, stat) => {
      const pathEndsWithSep = path[path.length - 1] === nodePath.sep;
      if (err && err.code === 'ENOENT' && !nodePath.extname(path) && !pathEndsWithSep) {
        // not found, check extensions
        return next(err);
      }
      if (err) return this.onStatError(err);
      if (stat.isDirectory()) return this.redirect(path);
      if (pathEndsWithSep) return this.error(404);
      this.emit('file', path, stat);
      this.send(path, stat);
    });

    next = (err) => {
      if (this._extensions.length <= i) {
        return err
          ? this.onStatError(err)
          : this.error(404);
      };

      const p = path + '.' + this._extensions[i++];

      nodeFs.stat(p, (err, stat) => {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        this.emit('file', p, stat);
        this.send(p, stat);
      });
    }
  }

  /**
   * Transfer index for `path`.
   *
   * @param {String} path
   * @private
   */
  sendIndex(path) {
    let i = -1;

    const next = (err) => {
      if (++i >= this._index.length) {
        if (err) return this.onStatError(err);
        return this.error(404);
      }

      const p = nodePath.join(path, this._index[i]);

      fs.stat(p, (err, stat) => {
        if (err) return next(err);
        if (stat.isDirectory()) return next();
        this.emit('file', p, stat);
        this.send(p, stat);
      });
    }

    next();
  }

  /**
   * Stream `path` to the response.
   *
   * @param {string} path
   * @param {nodeFs.ReadStreamOptions} options
   * @private
   */
  stream(path, options) {
    const res = this.res;

    // pipe
    const stream = nodeFs.createReadStream(path, options);
    this.emit('stream', stream);
    stream.pipe(res);

    // cleanup
    const cleanup = () => {
      stream.destroy();
    };

    // response finished, cleanup
    // res.on('finish', () => {
    //   process.nextTick(cleanup);
    // });
    this._onFinished.onFinished(res, cleanup);

    // error handling
    stream.on('error', (err) => {
      // clean up stream early
      cleanup();

      // error
      this.onStatError(err);
    });

    // end
    stream.on('end', () => {
      this.emit('end');
    });
  }

  /**
   * Set content-type based on `path`
   * if it hasn't been explicitly set.
   *
   * @param {string} path
   * @private
   */
  type(path) {
    const res = this.res;

    if (res.getHeader('Content-Type')) return;

    const ext = nodePath.extname(path);
    const type = this._mime.contentType(ext) || 'application/octet-stream';

    res.setHeader('Content-Type', type);
  }

  /**
   * Set response header fields, most
   * fields may be pre-defined.
   *
   * @param {string} path
   * @param {nodeFs.Stats} stat
   * @private
   */
  setHeader(path, stat) {
    const res = this.res;

    this.emit('headers', res, path, stat);

    if (this._acceptRanges && !res.getHeader('Accept-Ranges')) {
      res.setHeader('Accept-Ranges', 'bytes');
    }

    if (this._cacheControl && !res.getHeader('Cache-Control')) {
      let cacheControl = 'public, max-age=' + Math.floor(this._maxage / 1000);

      if (this._immutable) {
        cacheControl += ', immutable';
      }

      res.setHeader('Cache-Control', cacheControl);
    }

    if (this._lastModified && !res.getHeader('Last-Modified')) {
      const modified = stat.mtime.toUTCString();
      res.setHeader('Last-Modified', modified);
    }

    if (this._etag && !res.getHeader('ETag')) {
      const val = this.etag(stat);
      res.setHeader('ETag', val);
    }
  }

  /**
   * Clear all headers from a response.
   *
   * @param {nodeHttp.ServerResponse} res
   * @private
   */
  clearHeaders(res) {
    for (const header of res.getHeaderNames()) {
      res.removeHeader(header);
    }
  }

  /**
   * Collapse all leading slashes into a single slash
   *
   * @param {string} str
   * @private
   */
  collapseLeadingSlashes(str) {
    for (let i = 0; i < str.length; i++) {
      if (str[i] !== '/') {
        break;
      }
    }

    return i > 1
      ? '/' + str.slice(i)
      : str;
  }

  /**
   * Determine if path parts contain a dotfile.
   *
   * @param {string[]} parts 
   * @private
   */
  containsDotFile(parts) {
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length > 1 && part[0] === '.') {
        return true;
      }
    }

    return false;
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
  contentRange(type, size, range) {
    return type + ' ' + (range ? range.start + '-' + range.end : '*') + '/' + size;
  }

  /**
   * Create a minimal HTML document.
   *
   * @param {string} title
   * @param {string} body
   * @private
   */
  createHtmlDocument(title, body) {
    return '<!DOCTYPE html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '<meta charset="utf-8">\n' +
      '<title>' + title + '</title>\n' +
      '</head>\n' +
      '<body>\n' +
      '<pre>' + body + '</pre>\n' +
      '</body>\n' +
      '</html>\n';
  }

  /**
   * @param {...*} args 
   * @returns {Error}
   * @private
   */
  createError(...args) {
    let err;
    let msg;
    let status = 500;
    let props = {};

    for (const arg of args) {
      const type = typeof arg;
      if (type === 'object' && arg instanceof Error) {
        err = arg;
        status = err.status || err.statusCode || status;
      } else if (type === 'number' && i === 0) {
        status = arg;
      } else if (type === 'string') {
        msg = arg;
      } else if (type === 'object') {
        props = arg;
      } else {
        throw new TypeError('argument #' + (i + 1) + ' unsupported type ' + type);
      }
    }

    if (typeof status !== 'number' ||
      (!this._statuses.message[status] && (status < 400 || status >= 600))) {
      status = 500;
    }

    if (!err) {
      err = new Error(msg || this._statuses.message[status]);
    }

    if (err.status !== status) {
      // add properties to generic error
      err.expose = status < 500;
      err.status = err.statusCode = status;
    }

    for (const key in props) {
      if (key !== 'status' && key !== 'statusCode') {
        err[key] = props[key];
      }
    }

    return err;
  }

  /**
   * Create a HttpError object from simple arguments.
   *
   * @param {number} status
   * @param {Error|object} err
   * @returns {Error}
   * @private
   */
  createHttpError(status, err) {
    if (!err) {
      return this.createError(status);
    }

    return err instanceof Error
      ? this.createError(status, err, { expose: false })
      : this.createError(status, err);
  }

  /**
   * decodeURIComponent.
   *
   * Allows V8 to only deoptimize this fn instead of all
   * of send().
   *
   * @param {string} path
   * @returns {-1|string}
   * @private
   */
  decode(path) {
    try {
      return decodeURIComponent(path);
    } catch (err) {
      return -1;
    }
  }

  /**
   * Determine if emitter has listeners of a given type.
   *
   * The way to do this check is done three different ways in Node.js >= 0.10
   * so this consolidates them into a minimal set using instance methods.
   *
   * @param {EventEmitter} emitter
   * @param {string} type
   * @returns {boolean}
   * @private
   */
  hasListeners(emitter, type) {
    const count = typeof emitter.listenerCount !== 'function'
      ? emitter.listeners(type).length
      : emitter.listenerCount(type);

    return count > 0;
  }

  /**
   * Normalize the index option into an array.
   *
   * @param {boolean|string|string[]} val
   * @param {string} name
   * @returns {string[]}
   * @private
   */
  normalizeList(val, name) {
    const list = [].concat(val || []);

    for (let i = 0; i < list.length; i++) {
      if (typeof list[i] !== 'string') {
        throw new TypeError(name + ' must be array of strings or false');
      }
    }

    return list;
  }

  /**
   * Parse an HTTP Date into a number.
   *
   * @param {string} date
   * @returns {number}
   * @private
   */
  parseHttpDate(date) {
    const timestamp = date && Date.parse(date);

    return typeof timestamp === 'number'
      ? timestamp
      : NaN;
  }

  /**
   * Parse a HTTP token list.
   *
   * @param {string} str
   * @returns {string[]}
   * @private
   */
  parseTokenList(str) {
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
          if (start !== end) {
            list.push(str.substring(start, end));
          }
          start = end = i + 1;
          break;
        default:
          end = i + 1;
          break;
      }
    }

    // final token
    if (start !== end) {
      list.push(str.substring(start, end));
    }

    return list;
  }

  /**
   * Set an object of headers on a response.
   *
   * @param {nodeHttp.ServerResponse} res
   * @param {Record<string, string>} headers
   * @private
   */
  setHeaders(res, headers) {
    const keys = Object.keys(headers);

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      res.setHeader(key, headers[key]);
    }
  }

  /**
   * Escape special characters in the given string of text.
   *
   * @param  {string} text The string to escape for inserting into HTML
   * @return {string}
   * @private
   */
  escapeHtml(text) {
    const str = '' + text;
    const match = /["'&<>]/.exec(str);

    if (!match) {
      return str;
    }

    let escape;
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

    return lastIndex !== index
      ? html + str.substring(lastIndex, index)
      : html;
  }

  /**
   * Parse "Range" header `str` relative to the given file `size`.
   *
   * @param {number} size
   * @param {string} str
   * @param {{ combine: boolean }} [options]
   * @return {Array<{ start: number, end: number }>|-1|-2}
   * @private
   */
  parseRange(size, str, options) {
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
    for (let i = 0; i < arr.length; i++) {
      const indexOf = arr[i].indexOf('-');
      if (indexOf === -1) {
        continue;
      }

      const startStr = arr[i].slice(0, indexOf).trim();
      const endStr = arr[i].slice(indexOf + 1).trim();

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

    return options && options.combine
      ? this.combineRanges(ranges)
      : ranges;
  }

  /**
   * Combine overlapping & adjacent ranges.
   * 
   * @param {Array<{ start: number, end: number }>} ranges 
   * @returns {{ start: number, end: number, index: number }}
   * @private
   */
  combineRanges(ranges) {
    const mapWithIndex = (range, index) => {
      return {
        start: range.start,
        end: range.end,
        index: index
      };
    };

    const mapWithoutIndex = (range) => {
      return {
        start: range.start,
        end: range.end
      };
    };

    const sortByRangeIndex = (a, b) => {
      return a.index - b.index;
    };

    const sortByRangeStart = (a, b) => {
      return a.start - b.start;
    };

    const ordered = ranges.map(mapWithIndex).sort(sortByRangeStart);

    for (let j = 0, i = 1; i < ordered.length; i++) {
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
    const combined = ordered.sort(sortByRangeIndex).map(mapWithoutIndex);

    // copy ranges type
    combined.type = ranges.type;

    return combined;
  }

  /**
   * @private
   * @param {string} url 
   * @returns {string}
   */
  encodeUrl(url) {
    return String(url)
      .replace(SendStream.UNMATCHED_SURROGATE_PAIR_REGEXP, SendStream.UNMATCHED_SURROGATE_PAIR_REPLACE)
      .replace(SendStream.ENCODE_CHARS_REGEXP, encodeURI);
  }

  /**
   * Create a simple ETag.
   * 
   * @param {string|Buffer|nodeFs.Stats|null} entity
   * @param {{ weak: boolean }} [options]
   * @return {string}
   * @private
   */
  etag(entity, options) {
    if (entity == null) {
      throw new TypeError('argument entity is required');
    }

    // support fs.Stats object
    const isStats = this.isStats(entity);
    const weak = options && typeof options.weak === 'boolean'
      ? options.weak
      : isStats;

    // validate argument
    if (!isStats && typeof entity !== 'string' && !Buffer.isBuffer(entity)) {
      throw new TypeError('argument entity must be string, Buffer, or fs.Stats');
    }

    // generate entity tag
    const tag = isStats
      ? this.statETag(entity)
      : this.entityETag(entity);

    return weak
      ? 'W/' + tag
      : tag;
  }

  /**
   * Determine if object is a Stats object.
   *
   * @param {object} obj
   * @return {boolean}
   * @private
   */
  isStats() {
    // genuine fs.Stats
    if (typeof nodeFs.Stats === 'function' && obj instanceof nodeFs.Stats) {
      return true;
    }

    const toString = Object.prototype.toString;

    // quack quack
    return obj && typeof obj === 'object' &&
      'ctime' in obj && toString.call(obj.ctime) === '[object Date]' &&
      'mtime' in obj && toString.call(obj.mtime) === '[object Date]' &&
      'ino' in obj && typeof obj.ino === 'number' &&
      'size' in obj && typeof obj.size === 'number';
  }

  /**
   * Generate an entity tag.
   *
   * @param {Buffer|string} entity
   * @return {string}
   * @private
   */
  entityETag(entity) {
    if (entity.length === 0) {
      // fast-path empty
      return '"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk"';
    }

    // compute hash of entity
    const hash = nodeCrypto
      .createHash('sha1')
      .update(entity, 'utf8')
      .digest('base64')
      .substring(0, 27);

    // compute length of entity
    const len = typeof entity === 'string'
      ? Buffer.byteLength(entity, 'utf8')
      : entity.length;

    return '"' + len.toString(16) + '-' + hash + '"';
  }

  /**
   * Generate a tag for a stat.
   *
   * @param {nodeFs.Stats} stat
   * @return {string}
   * @private
   */
  statETag(stat) {
    const mtime = stat.mtime.getTime().toString(16);
    const size = stat.size.toString(16);

    return '"' + size + '-' + mtime + '"';
  }

  /**
   * Check freshness of the response using request and response headers.
   * 
   * @param {Record<string, string>} reqHeaders
   * @param {Record<string, string>} resHeaders
   * @return {boolean}
   * @private
   */
  fresh(reqHeaders, resHeaders) {
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
    if (cacheControl && SendStream.CACHE_CONTROL_NO_CACHE_REGEXP.test(cacheControl)) {
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

      const matches = this.parseTokenList(noneMatch);
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
      const modifiedStale = !lastModified || !(this.parseHttpDate(lastModified) <= this.parseHttpDate(modifiedSince));

      if (modifiedStale) {
        return false;
      }
    }

    return true;
  }
}