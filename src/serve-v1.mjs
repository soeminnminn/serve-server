import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import nodeUrl from 'node:url';
import * as nodeUtil from 'node:util';
import { createRequire } from 'node:module';

import Template from './template.mjs';
import mimeTypes from './mimetypes.json' with { type: 'json' };

/**
 * @typedef {(err: Error|undefined, req: nodeHttp.IncomingMessage|undefined, res: nodeHttp.ServerResponse|undefined) => void} NextFn
 */

/**
 * @typedef {(req: nodeHttp.IncomingMessage, res: nodeHttp.ServerResponse, next: NextFn) => void} HandlerFn
 */

/**
 * @typedef {(err: Error, req: nodeHttp.IncomingMessage, res: nodeHttp.ServerResponse, next: NextFn) => void} ErrorHandlerFn
 */

/**
 * @typedef {object} ServeOptions
 * @property {string} [root]
 * @property {boolean} [noCache]
 * @property {string[]} [defaults]
 * @property {string[]} [plugins]
 */

const TEMPLATE = `<!DOCTYPE html>
<html>
<head>
<meta charset=utf-8>
<meta content=\"IE=edge\" http-equiv=X-UA-Compatible>
<meta content=\"width=device-width,initial-scale=1\" name=\"viewport\">
<link rel=\"icon\" type=\"image/png\" href=\"./icon/favicon.png\">
<title>{{: title }}</title>
<style type=\"text/css\">
body { padding-top: 50px; font: 14px \"Lucida Grande\", Helvetica, Arial, sans-serif; margin: 0; }
.container { padding-right: 15px; padding-left: 15px; margin-right: auto; margin-left: auto; }
@media (min-width: 768px) { .container { width: 750px; } }
@media (min-width: 992px) { .container { width: 970px; } }
@media (min-width: 1200px) { .container { width: 1170px; } }
pre { overflow: auto; font-family: monospace, monospace; page-break-inside: avoid; display: block; padding: 9.5px; margin: 0 0 10px; font-size: 13px; line-height: 1.42857143; color: #333; word-break: break-all; word-wrap: break-word; background-color: #f5f5f5; border: 1px solid #ccc; border-radius: 4px; }
.row:before, .row:after { display: table; content: \" \"; }
.row:after { clear: both; }
.row { margin-right: -15px; margin-left: -15px; }
.page-title { padding-bottom: 16px; border-bottom: 1px solid #e0e0e0; }
.image { text-align:center; padding: 9.5px; margin: 0 0 10px; border: 1px solid #ccc; border-radius: 4px; background-color: #f5f5f5; }
{{: styles }}
</style>
</head>
<body>
  <div class=\"container\">
    <div class=\"row\">
      {{: content }}
    </div>
  </div>
</body>
</html>`;

const listStyles = `
ul.list { list-style: none; padding-left: 0; }
ul.list>li { display: inline-flex; width: 100%; line-height: 3em; border-bottom: solid 1px #ccc; }
ul.list>li.header { font-weight: 700; }
ul.list>li.header span:not(:first-child) { text-align: center; }
ul.list>li:not(.header):hover { background: #f6f8fa; }
ul.list>li span { min-width: 200px; }
ul.list>li span.size, ul.list>li span.date { text-align: center; }
ul.list>li.header span:first-child, ul.list>li a { flex-grow: 8 }
ul.list>li:not(.header)::before { content: ""; width: 17px; padding: 2px 8px; background-repeat: no-repeat; background-position: center; }
@media (max-width: 767px) {
  .page-title { padding: 8px 16px; }
  ul.list>li.header { display: none; }
  ul.list>li { flex-wrap: wrap; line-height: 2.2em; }
  ul.list>li:not(.header)::before {  position: absolute; left: 0; width: 62px; height: 32px; padding: 8px 8px; background-size: 32px 32px; }
  ul.list>li a { padding-left: 76px; }
  ul.list>li span { text-align: right; min-width: 0; }
  ul.list>li span.size { padding-right: 16px; color: #808080; }
  ul.list>li span.date { text-align: left; flex-basis:100%; padding-left: 76px; padding-bottom: 8px; line-height: 18px; color: #808080; }
}
li.directory::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 14 16' version='1.1' width='14' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M13 4H7V3c0-.66-.31-1-1-1H1c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1V5c0-.55-.45-1-1-1zM6 4H1V3h5v1z'%3E%3C/path%3E%3C/svg%3E"); }
li.file::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M6 5H2V4h4v1zM2 8h7V7H2v1zm0 2h7V9H2v1zm0 2h7v-1H2v1zm10-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5z'%3E%3C/path%3E%3C/svg%3E"); }
li.file-media::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M6 5h2v2H6V5zm6-.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v11l3-5 2 4 2-2 3 3V5z'%3E%3C/path%3E%3C/svg%3E"); }
li.file-binary::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M4 12h1v1H2v-1h1v-2H2V9h2v3zm8-7.5V14c0 .55-.45 1-1 1H1c-.55 0-1-.45-1-1V2c0-.55.45-1 1-1h7.5L12 4.5zM11 5L8 2H1v12h10V5zM8 4H6v1h1v2H6v1h3V7H8V4zM2 4h3v4H2V4zm1 3h1V5H3v2zm3 2h3v4H6V9zm1 3h1v-2H7v2z'%3E%3C/path%3E%3C/svg%3E"); }
li.file-code::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M8.5 1H1c-.55 0-1 .45-1 1v12c0 .55.45 1 1 1h10c.55 0 1-.45 1-1V4.5L8.5 1zM11 14H1V2h7l3 3v9zM5 6.98L3.5 8.5 5 10l-.5 1L2 8.5 4.5 6l.5.98zM7.5 6L10 8.5 7.5 11l-.5-.98L8.5 8.5 7 7l.5-1z'%3E%3C/path%3E%3C/svg%3E"); }
li.file-pdf::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M8.5 1H1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4.5L8.5 1zM1 2h4a.68.68 0 0 0-.31.2 1.08 1.08 0 0 0-.23.47 4.22 4.22 0 0 0-.09 1.47c.06.609.173 1.211.34 1.8A21.78 21.78 0 0 1 3.6 8.6c-.5 1-.8 1.66-.91 1.84a7.156 7.156 0 0 0-.69.3c-.362.165-.699.38-1 .64V2zm4.42 4.8a5.65 5.65 0 0 0 1.17 2.09c.275.237.595.417.94.53-.64.09-1.23.2-1.81.33-.618.15-1.223.347-1.81.59s.22-.44.61-1.25c.365-.74.67-1.51.91-2.3l-.01.01zM11 14H1.5a.743.743 0 0 1-.17 0 2.12 2.12 0 0 0 .73-.44 10.14 10.14 0 0 0 1.78-2.38c.31-.13.58-.23.81-.31l.42-.14c.45-.13.94-.23 1.44-.33s1-.16 1.48-.2c.447.216.912.394 1.39.53.403.11.814.188 1.23.23h.38V14H11zm0-4.86a3.743 3.743 0 0 0-.64-.28 4.221 4.221 0 0 0-.75-.11c-.411.003-.822.03-1.23.08a3 3 0 0 1-1-.64 6.07 6.07 0 0 1-1.29-2.33c.111-.661.178-1.33.2-2 .02-.25.02-.5 0-.75a1.05 1.05 0 0 0-.2-.88.82.82 0 0 0-.61-.23H8l3 3v4.14z'%3E%3C/path%3E%3C/svg%3E"); }
li.file-zip::before { background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' class='octicon' viewBox='0 0 12 16' version='1.1' width='12' height='16'%3E%3Cpath fill-rule='evenodd' fill='rgba(3, 47, 98, 0.5)' d='M8.5 1H1a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V4.5L8.5 1zM11 14H1V2h3v1h1V2h3l3 3v9zM5 4V3h1v1H5zM4 4h1v1H4V4zm1 2V5h1v1H5zM4 6h1v1H4V6zm1 2V7h1v1H5zM4 9.28A2 2 0 0 0 3 11v1h4v-1a2 2 0 0 0-2-2V8H4v1.28zM6 10v1H4v-1h2z'%3E%3C/path%3E%3C/svg%3E"); }
`;

function mixin(dest, src, redefine) {
  if (!dest) {
    throw new TypeError('argument dest is required');
  }
  if (!src) {
    throw new TypeError('argument src is required');
  }

  const hasOwnProperty = Object.prototype.hasOwnProperty;
  if (redefine === false) {
    redefine = true;
  }

  Object.getOwnPropertyNames(src).forEach((name) => {
    if (!redefine && hasOwnProperty.call(dest, name)) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(src, name);
    Object.defineProperty(dest, name, descriptor);
  })
  return dest;
}

/**
 * @type {ServeOptions}
 */
const options_defaults = {
  root: 'public',
  noCache: false,
  defaults: ['index.html', 'index.htm'],
  plugins: []
};

class Serve {
  /**
   * @constructor
   * @param {ServeOptions} options 
   */
  constructor(options) {
    const opts = mixin(options, options_defaults);

    const rootPath = nodePath.normalize(nodePath.join(process.cwd(), opts.root) + nodePath.sep);
    const stats = nodeFs.lstatSync(rootPath);
    if (!stats.isDirectory()) {
      throw new Error("'root' must be directory.");
    }

    this.rootPath = rootPath;
    this.defaults = opts.defaults;
    this.noCache = opts.noCache;

    const template = new Template(TEMPLATE);
    this.tmpl = template.compile();

    this.shared = {};
    this.mimeTypes = {};

    const map = mimeTypes;
    for (const type in map) {
      const exts = map[type];
      for (let i = 0; i < exts.length; i++) {
        this.mimeTypes[exts[i]] = type;
      }
    }

    this.defaultMimeType = this.mimeLookup('bin');

    this.stack = [];
    this.loadPlugins(opts.plugins);

    const handler = this.makeHandler();
    this.stack.push({
      isMatch: () => true,
      handler
    });
  }

  /**
   * @private
   * @param {string[]} plugins 
   * @returns {void}
   */
  loadPlugins(plugins) {
    if (typeof (plugins) == 'string') {
      plugins = [plugins];
    }
    if (typeof (plugins) != 'object' || !Array.isArray(plugins)) return;

    for (const i in plugins) {
      if (plugins[i] && typeof (plugins[i]) == 'string') {
        const pluginName = `./plugin-${plugins[i]}`;

        try {
          const require = createRequire(import.meta.url);
          const pObj = require(pluginName);

          if (pObj && typeof (pObj) == 'object' && (typeof (pObj.handle) == 'function' || typeof (pObj.handler) == 'function')) {
            this.stack.push(pObj);

          } else if (typeof (pObj) == 'function') {
            this.stack.push({
              handler: pObj
            });

          }
        } catch { }
      }
    }
  }

  /**
   * @private
   * @param {any} str 
   * @returns {boolean}
   */
  isString(str) {
    if (!str) return false;
    return (typeof str == 'string' || str instanceof String);
  }

  /**
   * @private
   * @param {string} pathExt 
   * @returns {string}
   */
  mimeLookup(pathExt) {
    const ext = pathExt.replace(/.*[\.\/\\]/, "").toLowerCase();
    return this.mimeTypes.lookup(ext) || this.defaultMimeType;
  }

  /**
   * @private
   * @param {string} filePath 
   * @returns {nodeFs.Stats|null}
   */
  fileInfo(filePath) {
    if (filePath) {
      if (!this.noCache && this.shared[filePath]) {
        return this.shared[filePath];
      } else {
        if (!nodeFs.existsSync(filePath)) {
          return null;
        }

        const stat = nodeFs.statSync(filePath);
        stat.permissions = '0' + (stat.mode & parseInt('777', 8)).toString(8);
        stat.mime = this.mimeLookup(filePath);
        stat.etag = `"${stat.mtime.getTime().toString(16)}-${stat.size.toString(16)}"`;

        if (!this.noCache) {
          this.shared[path] = stat;
        }
        return stat;
      }
    }
    return null;
  }

  /**
   * @private
   * @param {nodeHttp.IncomingMessage} req 
   * @param {number} total 
   * @returns {string}
   */
  getRange(req, total) {
    const range = [0, total, 0];
    const rinfo = req.headers ? req.headers.range : null;

    if (rinfo) {
      const rloc = rinfo.indexOf('bytes=');
      if (rloc >= 0) {
        const ranges = rinfo.slice(rloc + 6).split('-');
        try {
          range[0] = parseInt(ranges[0]);
          if (ranges[1] && ranges[1].length) {
            range[1] = parseInt(ranges[1]);
            range[1] = range[1] < 16 ? 16 : range[1];
          }
        } catch (e) { }
      }

      if (range[1] == total) {
        range[1]--;
      }
      range[2] = total;
    }

    return range;
  }

  /**
   * @private
   * @param {File} a 
   * @param {File} b 
   * @returns {-1|0|1}
   */
  fileSort(a, b) {
    // sort ".." to the top
    if (a.name === '..' || b.name === '..') {
      return a.name === b.name ? 0 : a.name === '..' ? -1 : 1;
    }
    return Number(b.stat && b.stat.isDirectory()) - Number(a.stat && a.stat.isDirectory()) ||
      String(a.name).toLocaleLowerCase().localeCompare(String(b.name).toLocaleLowerCase());
  }

  /**
   * @private
   * @param {number} bytes 
   * @returns {string}
   */
  formatFileSize(bytes) {
    const s = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let pos = 0;
    for (pos = 0; bytes >= 1000; pos++, bytes /= 1024);
    const d = Math.round(bytes * 10);
    return pos ? [parseInt(d / 10), ".", d % 10, " ", s[pos]].join('') : bytes + ' bytes';
  }

  /**
   * @private
   * @param {Date} d 
   * @returns {string}
   */
  formatDate(d) {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return [m[d.getMonth()], ' ', d.getDate(), ', ', d.getFullYear(), " ",
    (d.getHours() % 12 || 12), ":", (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(),
      " ", d.getHours() >= 12 ? 'PM' : 'AM'].join('');
  }

  /**
   * @private
   * @param {nodeHttp.ServerResponse} res 
   * @param {string[]} files 
   * @param {string} dir 
   * @param {string} pathname 
   * @param {boolean} showUp 
   */
  serveDirectory(res, files, dir, pathname, showUp) {
    const fileList = [];
    for (const i in files) {
      try {
        const stat = this.fileInfo(nodePath.join(dir, files[i]));
        fileList.push({ name: files[i], stat });
      } catch (err) {
        console.log(err);
      }
    }

    if (showUp) {
      fileList.push({ name: '..' });
    }

    fileList.sort(this.fileSort);

    let content = `<div class=\"page-title\">Index of <strong>${pathname}</strong></div>`;
    content += '<ul class="list">';
    content += '<li class="header"><span>Name</span><span>Size</span><span>Modified</span></li>';

    for (const i in fileList) {
      const file = fileList[i];

      const date = file.stat && file.name !== '..' ? `${this.formatDate(file.stat.mtime)}` : '&nbsp;';
      const size = this.formatFileSize(file.stat && !file.stat.isDirectory() ? file.stat.size : 0);
      const pathUrl = nodePath.join(pathname, file.name);

      if (file.name == '..' || file.stat.isDirectory()) {
        content += `<li class='directory'>`;
        content += `<a href='${pathUrl}'>${file.name}</a>`;
        content += `<span>&nbsp;</span>`;
        content += `<span class="date">${date}</span>`;
        content += '</li>';
      } else {
        content += `<li class='file'>`;
        content += `<a href='${pathUrl}'>${file.name}</a>`;
        content += `<span class="size">${size}</span>`;
        content += `<span class="date">${date}</span>`;
        content += '</li>';
      }
    }
    content += '</ul>';

    const html = this.tmpl({ title: pathname, styles: listStyles, content });
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.write(html);
    res.end();
  }

  /**
   * @private
   * @param {string} filePath 
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @returns {false|undefined}
   */
  handleFile(filePath, req, res) {
    if (!this.isString(filePath)) {
      throw new TypeError("filePath must be a string value");
    }

    const info = this.fileInfo(filePath);
    if (!info) {
      res.end(`${filePath} not found`);
      return false;
    }

    const range = this.getRange(req, info.size);
    const type = info.mime;

    if (!type || !type.length) {
      res.write(`Media format not found for ${nodePath.basename(filePath)}`);
    } else {
      const file = nodeFs.createReadStream(filePath, { start: range[0], end: range[1] });

      const header = {
        "Content-Length": range[1],
        "Content-Type": type,
        "ETag": info.etag,
        "Access-Control-Allow-Origin": req.headers.origin || "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "POST, GET, OPTIONS"
      };

      if (range[2]) {
        header["Accept-Ranges"] = "bytes";
        header["Content-Range"] = `bytes ${range[0]}-${range[1]}/${info.size}`;
        header["Content-Length"] = range[2];

        res.writeHead(206, header);
      } else {
        res.writeHead(200, header);
      }

      file.pipe(res);
      file.on("close", () => {
        res.end(0);
      });
    }
  }

  /**
   * @private
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @returns {NextFn}
   */
  finalhandler(req, res) {
    return (err) => {
      let content = '';
      let code = 500;
      if (typeof err === "object") {
        code = (err.status || 500);
        const str = nodeHttp.STATUS_CODES[code];
        const title = (typeof str === "undefined") ? `${code} Unknown Error` : `${code} ${str}`;
        content = `<h1 class=\"page-title\">${title}</h1>`;
        content += `<h2>${err.message}</h2>`;
        content += `<pre>${err.stack}</pre>`;

      } else if (typeof err === "string") {
        const str = nodeHttp.STATUS_CODES[code];
        content = `<h1 class=\"page-title\">${code} ${str}</h1>`;
        content += `<h2>${err}</h2>`;

      } else if (typeof err === "number") {
        code = err;
        const str = nodeHttp.STATUS_CODES[code];
        content = `<h1 class=\"page-title\">${code} ${str}</h1>`;
        content += `<h2>${str}</h2>`;

      } else {
        const str = nodeHttp.STATUS_CODES[code];
        content = `<h1 class=\"page-title\">${code} ${str}</h1>`;
        content += "<h2>Unknown error.</h2>";
      }

      const html = this.tmpl({
        title: 'Error',
        styles: '',
        content
      });
      res.writeHead(code, {
        "Content-Type": "text/html; charset=utf-8"
      });
      res.write(html);
      res.end();
    };
  }

  /**
   * @private
   * @param {RouteMap} [route] 
   * @returns {HandlerFn}
   */
  makeHandler() {
    const rootPath = this.rootPath;
    const self = this;

    const error = (code) => {
      const msg = nodeHttp.STATUS_CODES[code];
      const err = new Error(msg);
      err.status = code;
      return err;
    };

    return (req, res, next) => {
      let dir = null;
      try {
        dir = decodeURIComponent(nodeUrl.parse(req.url).pathname);
      } catch (e) { }

      if (dir == null) return next(error(400));

      const dirPath = nodePath.normalize(nodePath.join(rootPath, dir));
      if (!!~dirPath.indexOf('\0')) return next(error(400));

      if ((dirPath + nodePath.sep).substring(0, rootPath.length) !== rootPath) {
        return next(error(403));
      }

      const pathname = nodeUrl.parse(req.url).pathname;
      const showUp = nodePath.normalize(nodePath.resolve(dirPath) + nodePath.sep) !== rootPath;

      nodeFs.stat(dirPath, (err, stat) => {
        if (err && err.code === 'ENOENT') {
          return next(error(404));
        }

        if (err) {
          err.status = err.code === 'ENAMETOOLONG' ? 414 : 500;
          return next(err);
        }

        if (!stat.isDirectory()) {
          return self.handleFile(dirPath, req, res);
        }

        nodeFs.readdir(dirPath, (err, files) => {
          if (err) return next(err);

          const defs = files.filter((f) => {
            return !!~self.defaults.indexOf(f.toLocaleLowerCase())
          });
          if (defs && defs.length) {
            const filePath = nodePath.join(dirPath, defs[0]);
            return self.handleFile(filePath, req, res);
          }

          self.serveDirectory(res, files, dirPath, pathname, showUp);
        });
      });
    };
  }

  /**
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @param {NextFn} callback 
   */
  handle(req, res, callback) {
    const receiver = callback || this.finalhandler(req, res);
    let index = 0;

    console.log('SERVE ' + req.method + " " + req.url);

    var next = (err) => {
      const layer = this.stack[index++];
      if (!layer) {
        if (!err) {
          err = new Error('Not found');
          err.status = 404;
        }

        setImmediate(receiver, err, req, res);
        return;
      }

      try {
        const isMatch = layer.isMatch || (() => true);
        if (!isMatch(req)) {
          return next(err);
        }

        if (typeof (layer.handler) == 'function' || typeof (layer.handle) == 'function') {
          const handler = layer.handler || layer.handle;
          const count = handler.length;

          if (err && count === 4) {
            handler(err, req, res, next);
            return;
          }

          if (!err && count < 4) {
            handler(req, res, next);
            return;
          }
        }

      } catch (thrown) {
        err = thrown;
      }

      next(err);
    };
    next();
  }
}

function parseArgs(schema) {
  const args = {};
  const keys = {};
  for (const i in schema) {
    if (typeof schema[i] == 'object') {
      args[i] = schema[i].default;
      for (const j in schema[i].keys) {
        keys[schema[i].keys[j]] = i;
      }
    }
  }

  const argv = process.argv.slice(2);
  if (argv.length == 1) {
    for (const i in schema) {
      if (schema[i].match && nodeUtil.types.isRegExp(schema[i].match) && schema[i].match.test(argv[0])) {
        args[i] = argv[0];
        break;
      }
    }
  }

  return argv.reduce((acc, key, ind, self) => {
    if (keys[key] && argv[ind + 1]) {
      acc[keys[key]] = argv[ind + 1];
    }
    return acc;
  }, args);
}

function parseEnv(root) {
  if (!root) {
    root = process.cwd();
  }
  const dotenvPath = path.resolve(root, '.env');

  const encoding = 'utf8';
  const LINE = /(?:^|^)\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?(?:$|$)/mg;

  try {
    const obj = {};

    if (nodeFs.existsSync(dotenvPath)) {
      const src = nodeFs.readFileSync(dotenvPath, { encoding });

      // Convert buffer to string
      let lines = src.toString();

      // Convert line breaks to same format
      lines = lines.replace(/\r\n?/mg, '\n');

      let match;
      while ((match = LINE.exec(lines)) != null) {
        const key = match[1];

        // Default undefined or null to empty string
        let value = (match[2] || '');

        // Remove whitespace
        value = value.trim();

        // Check if double quoted
        const maybeQuote = value[0];

        // Remove surrounding quotes
        value = value.replace(/^(['"`])([\s\S]*)\1$/mg, '$2');

        // Expand newlines if double quoted
        if (maybeQuote === '"') {
          value = value.replace(/\\n/g, '\n');
          value = value.replace(/\\r/g, '\r');
        }

        // Add to object
        obj[key] = value;
      }
    }

    if (process.env && typeof (process.env) == 'object') {
      Object.keys(process.env).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) {
          obj[key] = process.env[key];
        }
      });
    }

    return obj;

  } catch (e) {
    return { error: e };
  }
}

(function main() {
  const env = parseEnv();

  const argsSchema = {
    port: { 'default': env.PORT || 3000, 'keys': ['-p', '--port'], 'match': /^[\d]+$/ },
    dir: { 'default': env.PUBLIC_DIR || env.SERVE_DIR || 'public', 'keys': ['-d', '--dir'], 'match': /^[^\s]+$/ }
  };

  const parsedArgs = parseArgs(argsSchema);
  const plugins = [];

  try {
    const serve = new Serve({
      root: parsedArgs.dir,
      plugins
    });
    const server = http.createServer(serve.handle.bind(serve));

    server.listen(parsedArgs.port);
    server.on('listening', () => {
      const addr = server.address();
      const bind = typeof addr === 'string' ? `pipe ${addr}` : `port ${addr.port}`;
      console.log(`Listening on ${bind}`);
    });
  } catch (e) {
    throw e;
  }
})();