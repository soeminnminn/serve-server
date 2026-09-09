import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';

import HttpError from './http-error.mjs';
import Wildcard from './wildcard.mjs';
import DirectoryListing from './directory-listing.mjs';
import SendFile from './send-file.mjs';
import { baseStyles } from './styles-loader.mjs';

/**
 * @typedef {object} RouteMap
 * @property {string} pattern
 * @property {RegExp} regexp
 * @property {string} path
 * @property {boolean} wildcard
 */

/**
 * @typedef {(req: nodeHttp.IncomingMessage, res: nodeHttp.ServerResponse) => Promise<boolean>} RouteHandler
 */

/**
 * @typedef {object} RouteEntry
 * @property {(req: nodeHttp.IncomingMessage) => boolean} isMatch
 * @property {RouteHandler} handler
 */

/**
 * @typedef {object} RoutesOptions
 * @property {Array<RouteMap>|string|string[]} [routes]
 * @property {string[]} [defaults]
 * @property {boolean} [dirListing]
 */

class RoutesIterator {
  /**
   * @constructor
   * @param {RouteEntry[]} routes 
   */
  constructor(routes) {
    /**
     * @private
     * @type {RouteEntry[]}
     */
    this._routes = routes;
    /**
     * @type {number}
     */
    this.index = 0;
  }

  /**
   * @returns {{ value: RouteEntry|undefined, done: boolean }}
   */
  next() {
    if (this.index < this._routes.length) {
      return {
        value: this._routes[this.index++],
        done: false,
      };
    } else {
      return {
        value: undefined,
        done: true,
      };
    }
  }
}

export default class Routes {
  /**
   * @constructor
   * @param {string} rootPath 
   * @param {RoutesOptions} [options] 
   */
  constructor(rootPath, options) {
    /**
     * @private
     * @type {RoutesOptions}
     */
    this._options = Object.assign({}, {
      dirListing: true,
      defaults: ['index.html', 'index.htm'],
    }, options || {});

    /**
     * @private
     * @type {string}
     */
    this._rootPath = rootPath;

    /**
     * @private
     * @type {RouteMap[]}
     */
    this._routes = this._parseRoutes(this._options.routes);

    /**
     * @private
     * @type {DirectoryListing}
     */
    this._directoryListing = new DirectoryListing(rootPath);

    /**
     * @private
     * @type {SendFile}
     */
    this._fileResponse = new SendFile();

    /**
     * @private
     * @type {RouteEntry[]}
     */
    this._stack = [];

    this._buildRouter();
  }

  [Symbol.iterator]() {
    return new RoutesIterator(this._stack);
  }

  /**
   * @returns {number}
   */
  get length() {
    return this._stack.length;
  }

  /**
   * @private
   * @param {string|string[]} [routesMap] 
   * @returns {Array<RouteMap>}
   */
  _parseRoutes(routesMap) {
    const routeMapRe = /^([\S]+)=(.*)$/;

    if (routesMap) {
      const arr = typeof routesMap === 'string' ? routesMap.split('|') : routesMap.slice();

      return arr.filter(Boolean).reduce((t, x) => {
        if (typeof x === 'string') {
          try {
            const match = routeMapRe.exec(x.trim());
            if (match) {
              const pattern = match[1];
              const path = match[2];

              if (pattern.startsWith('//^') && pattern.endsWith('//')) {
                const source = pattern.slice(1, -1);
                if (source) {
                  const regexp = new RegExp(source, 'i');
                  t.push({ pattern, regexp: regexp, path, wildcard: false });
                }

              } else {
                const wildcard = new Wildcard(pattern, { flags: 'i' });
                t.push({ pattern, regexp: wildcard.regexp, path, wildcard: true });
              }
            }
          } catch { }

        } else if (typeof x === 'object') {
          t.push(x);
        }

        return t;
      }, []);
    }

    return [];
  }

  /**
   * @private
   * @param {nodeHttp.IncomingMessage} req 
   * @returns {string|null}
   */
  _getPathName(req) {
    let pathname = '/';
    const url = req.url;

    if (url) {
      try {
        if (url.startsWith('/')) {
          pathname = url == '/' ? '/' : url.replace(/\/+$/, '');

        } else {
          const proto = req.headers['x-forwarded-proto'] || 'https';
          const host = req.headers['x-forwarded-host'] || req.headers.host || 'example.com';

          const urlObj = new URL(req.url || '/', `${proto}://${host}`);
          pathname = urlObj.pathname;
        }

        if (pathname) {
          pathname = decodeURIComponent(pathname);
        }
      } catch (e) { }
    }

    return pathname;
  }

  /**
   * @private
   */
  _buildRouter() {
    const options = this._options;

    for (const route of this._routes) {
      const handler = this._createRouteHandler(route);

      this._stack.push({
        isMatch: (req) => {
          const pathname = this.getPathName(req);
          return route.regexp.test(pathname);
        },
        handler
      });
    }

    const fileHandler = this._createFileHandler();
    this._stack.push({
      isMatch: () => true,
      handler: fileHandler,
    });

    if (options.dirListing == true) {
      const directoryHandler = this._createDirectoryHandler();
      this._stack.push({
        isMatch: () => true,
        handler: directoryHandler,
      });
    }
    
    const finalHandler = this._createFinalHandler();
    this._stack.push({
      isMatch: () => true,
      handler: finalHandler,
    });
  }

  /**
   * @private
   * @param {RouteMap} [route] 
   * @returns {RouteHandler}
   */
  _createRouteHandler(route) {
    const rootPath = this._rootPath;

    return async (req, res) => {
      try {
        const pathname = this._getPathName(req);
        if (pathname == null) {
          throw new HttpError(400);
        }

        let urlPath = pathname;

        if (!route.regexp.test(pathname)) return false;

        if (route.wildcard) {
          const idx = pathname.lastIndexOf(route.path);
          if (idx > -1) {
            urlPath = pathname.slice(idx);
          }

        } else {
          urlPath = pathname.replace(route.regexp, route.path);
        }

        const filePath = nodePath.normalize(nodePath.join(rootPath, urlPath));
        this._fileResponse.send(filePath, req, res);
        return true;

      } catch (err) {
        throw this._createHttpError(err);
      }
    };
  }

  /**
   * @private
   * @returns {RouteHandler}
   */
  _createFileHandler() {
    const rootPath = this._rootPath;
    const options = this._options;

    return async (req, res) => {
      try {
        const pathname = this._getPathName(req);
        if (pathname == null) {
          throw new HttpError(400);
        }

        const urlPath = nodePath.normalize(nodePath.join(rootPath, pathname));
        let filePath = null;

        const stat = await nodeFs.promises.stat(urlPath);
        if (stat.isFile()) {
          filePath = urlPath;

        } else if (stat.isDirectory()) {
          const files = await nodeFs.promises.readdir(urlPath);
          const defs = files.filter(f => !!~options.defaults.indexOf(f.toLocaleLowerCase()));

          if (defs && defs.length) {
            filePath = nodePath.normalize(nodePath.join(urlPath, defs[0]));
          }
        }

        if (!filePath) {
          throw new HttpError(404);
        }

        await this._fileResponse.send(filePath, req, res);
        return true;

      } catch (err) {
        throw this._createHttpError(err);
      }
    };
  }

  /**
   * @private
   * @returns {RouteHandler}
   */
  _createDirectoryHandler() {
    const rootPath = this._rootPath;

    return async (req, res) => {
      try {
        const pathname = this._getPathName(req);
        if (pathname == null) {
          throw new HttpError(400);
        }

        const dirPath = nodePath.normalize(nodePath.join(rootPath, pathname));

        await this._directoryListing.send(dirPath, res, pathname);
        return true;

      } catch (err) {
        throw this._createHttpError(err);
      }
    };
  }

  /**
   * @private
   * @returns {RouteHandler}
   */
  _createFinalHandler() {
    const err = new HttpError(404, 'File not found');

    return async (req, res) => {
      const handler = this.errorHandler.bind(this);
      await Promise.resolve(handler(err, res));
    };
  }

  /**
   * @private
   * @param {any} err 
   * @returns {HttpError}
   */
  _createHttpError(err) {
    if (err && ['ENOENT', 'ENOTDIR'].includes(err.code)) {
      return new HttpError(404, err);

    } else if (err && err.code === 'ENAMETOOLONG') {
      return new HttpError(414, err);

    } else if (err instanceof HttpError) {
      return err;
    }
    return new HttpError(500, err);;
  }

  /**
   * @param {HttpError|Error} err 
   * @param {nodeHttp.ServerResponse} res 
   */
  errorHandler(err, res) {
    let content = '';
    let statusCode = 500;

    if (typeof err === "object") {
      statusCode = (err.status || 500);
      const statusMsg = nodeHttp.STATUS_CODES[statusCode] || 'Unknown Error';
      content = `<h1 class=\"page-title\">${statusCode} ${statusMsg}</h1>`;
      content += `<h2>${err.message}</h2>`;
      content += `<pre>${err.stack}</pre>`;

    } else if (typeof err === "string") {
      const statusMsg = nodeHttp.STATUS_CODES[statusCode] || 'Unknown Error';
      content = `<h1 class=\"page-title\">${statusCode} ${statusMsg}</h1>`;
      content += `<h2>${err}</h2>`;

    } else if (typeof err === "number") {
      statusCode = err;
      const statusMsg = nodeHttp.STATUS_CODES[statusCode] || 'Unknown Error';
      content = `<h1 class=\"page-title\">${statusCode} ${statusMsg}</h1>`;
      content += `<h2>${statusMsg}.</h2>`;

    } else {
      const statusMsg = nodeHttp.STATUS_CODES[statusCode] || 'Unknown Error';
      content = `<h1 class=\"page-title\">${statusCode} ${statusMsg}</h1>`;
      content += `<h2>${statusMsg}.</h2>`;
    }

    const html = `<!DOCTYPE html>
      <html lang="en">
      <head>
      <meta charset=utf-8>
      <meta content=\"IE=edge\" http-equiv=X-UA-Compatible>
      <meta content=\"width=device-width,initial-scale=1\" name=\"viewport\">
      <link rel=\"icon\" type=\"image/png\" href=\"./icon/favicon.png\">
      <title>Serve - Error</title>
      <style type=\"text/css\">
      ${baseStyles}
      </style>
      </head>
      <body>
        <div class=\"container\">
          <div class=\"row\">
            ${content}
          </div>
        </div>
      </body>
      </html>`;

    res.writeHead(statusCode, {
      "Content-Type": "text/html; charset=utf-8"
    });
    res.write(html);
    res.end();
  }
}