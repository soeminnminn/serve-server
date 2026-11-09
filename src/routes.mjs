import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import { createRequire } from 'node:module';

import HttpError from './http-error.mjs';
import DirectoryListing from './directory-listing.mjs';
import SendFile from './send-file.mjs';
import RouteMaps, { RouteMap } from './route-map.mjs';
import { baseStyles } from './styles-loader.mjs';

/**
 * @typedef {(req: nodeHttp.IncomingMessage, res: nodeHttp.ServerResponse) => Promise<boolean>} RouteHandler
 */

/**
 * @typedef {(req?: nodeHttp.IncomingMessage) => boolean} IsMatchFunction
 */

/**
 * @typedef {object} PluginEntry
 * @property {string} [name]
 * @property {IsMatchFunction} [isMatch]
 * @property {RouteHandler} [handler]
 */

/**
 * @typedef {object} RouteEntry
 * @property {IsMatchFunction} isMatch
 * @property {RouteHandler} handler
 */

/**
 * @typedef {object} RoutesOptions
 * @property {string} [entry]
 * @property {Array<{ pattern: string|RegExp, path: string }>|string|string[]} [routes]
 * @property {string[]} [defaults]
 * @property {boolean} [dirListing]
 * @property {string} [pluginPath]
 * @property {string[]} [plugins]
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
    }

    return {
      value: undefined,
      done: true,
    };
  }
}

/**
 * @implements {ArrayLike<RouteEntry>}
 */
export default class Routes {
  /**
   * @constructor
   * @param {string} rootPath 
   * @param {RoutesOptions} [options] 
   */
  constructor(rootPath, options) {
    const opts = Object.assign({}, {
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
     * @type {RoutesOptions}
     */
    this._options = opts;

    /**
     * @private
     * @type {RouteMaps}
     */
    this._routes = new RouteMaps(opts.routes);

    /**
     * @private
     * @type {DirectoryListing}
     */
    this._directoryListing = new DirectoryListing(rootPath, opts);

    /**
     * @private
     * @type {SendFile}
     */
    this._fileResponse = new SendFile(opts);

    /**
     * @private
     * @type {RouteEntry[]}
     */
    this._stack = [];

    /**
     * @private
     * @type {boolean}
     */
    this._isReady = false;
  }

  [Symbol.iterator]() {
    return new RoutesIterator(this._stack);
  }

  /**
   * Length of routes
   * 
   * @returns {number}
   */
  get length() {
    return this._stack.length;
  }

  /**
   * Router is ready or not
   * 
   * @returns {boolean}
   */
  get isReady() {
    return this._isReady;
  }

  /**
   * @returns {Promise<void>}
   */
  async build() {
    const dirListing = this._options.dirListing === true;

    for (const route of this._routes) {
      const handler = this._createRouteHandler(route);

      this._stack.push({
        isMatch: (req) => {
          const pathname = this._getPathName(req);
          return route.test(pathname);
        },
        handler
      });
    }

    const plugins = await this._loadPlugins();
    for (const plugin of plugins) {
      if (typeof plugin.handler === 'function') {
        this._stack.push({
          isMatch: plugin.isMatch,
          handler: plugin.handler
        });
      }
    }

    const fileHandler = this._createFileHandler();
    this._stack.push({
      isMatch: () => true,
      handler: fileHandler,
    });

    if (dirListing) {
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

    this._isReady = true;
  }

  /**
   * @private
   * @param {nodeHttp.IncomingMessage|string} req 
   * @returns {string|null}
   */
  _getPathName(req) {
    let pathname = '/';
    const url = typeof req === 'string' ? req : req.url || '/';

    try {
      const urlObj = new URL(url, 'http://localhost');
      pathname = urlObj.pathname;
      if (pathname) {
        pathname = decodeURIComponent(pathname);
      }
    } catch (e) { }

    return pathname;
  }

  /**
   * @private
   * @param {string} path 
   * @returns {Promise<nodeFs.Stats|false>}
   */
  async _getReadStats(path) {
    try {
      await nodeFs.promises.access(path, nodeFs.constants.R_OK);
      const stat = await nodeFs.promises.stat(path);
      return stat;

    } catch (err) {
      return false;
    }
  }

  /**
   * @private
   * @returns {Promise<PluginEntry[]>} 
   */
  async _loadPlugins() {
    const { pluginPath, plugins } = this._options;
    if (!pluginPath || !plugins) {
      return [];
    }

    const pluginFiles = [];
    const pluginFileFormat = /^serve-([^\.]+)\.(js|cjs|mjs)$/;
    const require = createRequire(import.meta.url);

    if (pluginPath) {
      try {
        const dirPath = nodePath.resolve(pluginPath);
        await nodeFs.promises.access(dirPath, nodeFs.constants.R_OK);
        const files = await nodeFs.promises.readdir(dirPath);

        for (const file of files) {
          const match = pluginFileFormat.exec(file.toLocaleLowerCase());
          if (match) {
            const filePath = nodePath.join(dirPath, file);
            pluginFiles.push({
              path: filePath,
              name: match[1],
              module: match[2] === 'mjs',
            });
          }
        }

      } catch (err) {
        console.warn(err);
      }
    }

    const result = [];

    if (Array.isArray(plugins)) {
      for (const plugin of plugins) {
        if (typeof plugin === 'string') {
          const fileName = nodePath.basename(plugin);
          const ext = String.prototype.toLocaleLowerCase.call(nodePath.extname(plugin));

          pluginFiles.push({
            path: nodePath.resolve(plugin),
            name: fileName.slice(0, -ext.length),
            module: ext === '.mjs',
          });

        } else if (typeof plugin === 'object' && (typeof plugin.handle === 'function' || typeof plugin.handler === 'function')) {
          const isMatch = typeof plugin.isMatch === 'function' ? plugin.isMatch.bind(plugin) : () => true;
          let handler = null;

          if (typeof plugin.handle === 'function') {
            handler = plugin.handle.bind(plugin);
          } else if (typeof plugin.handler === 'function') {
            handler = plugin.handler.bind(plugin);
          }

          if (handler) {
            result.push({ isMatch, handler });
          }

        } else if (typeof plugin === 'function') {
          result.push({
            isMatch: () => true,
            handler: plugin
          });
        }
      }
    }

    for (const file of pluginFiles) {
      try {
        await nodeFs.promises.access(file.path, nodeFs.constants.R_OK);

        let plugin = null;
        if (file.module) {
          plugin = await import(file.path);
        } else {
          plugin = require(file.path);
        }

        if (!plugin) continue;

        let isMatch = () => true;
        let handler = null;

        if (typeof plugin === 'function') {
          handler = plugin;

        } else {
          if (typeof plugin.isMatch === 'function') {
            isMatch = plugin.isMatch.bind(plugin);
          }

          if (typeof plugin.handle === 'function') {
            handler = plugin.handle.bind(plugin);

          } else if (typeof plugin.handler === 'function') {
            handler = plugin.handler.bind(plugin);
          }
        }

        if (handler) {
          result.push({ name: file.name, isMatch, handler });
        }

      } catch (err) {
        console.warn(err);
      }
    }

    return result;
  }

  /**
   * @private
   * @param {RouteMap} route 
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

        let filePath = '';

        if (!route.test(pathname)) return false;
        const routePath = route.replace(pathname);

        if (routePath.endsWith('/')) {
          const parts = pathname.split('/').filter(Boolean);
          if (parts.length == 0) return false;
          filePath = nodePath.normalize(nodePath.join(rootPath, routePath, parts[parts.length - 1]));

        } else {
          filePath = nodePath.normalize(nodePath.join(rootPath, routePath));
        }

        if (filePath) {
          const fileStats = await this._getReadStats(filePath);
          if (fileStats && fileStats.isFile()) {
            const result = await this._fileResponse.send(filePath, req, res);
            if (typeof result === 'number') {
              throw new HttpError(result);
            }

            return result === true;
          }
        }

        return false;

      } catch (err) {
        throw this._createHttpError(err);
      }
    };
  }

  /**
   * @private
   * @returns {Promise<RouteHandler>}
   */
  _createFileHandler() {
    const rootPath = this._rootPath;
    const options = this._options;

    let entryFile = null;
    if (options.entry && typeof options.entry === 'string') {
      entryFile = nodePath.normalize(nodePath.join(rootPath, options.entry));
    }

    return async (req, res) => {
      try {
        const pathname = this._getPathName(req);
        if (pathname == null) {
          throw new HttpError(400);
        }

        let filePath = null;

        const urlPath = nodePath.normalize(nodePath.join(rootPath, pathname));
        const pathStats = await this._getReadStats(urlPath);

        if (pathStats) {
          if (pathStats.isFile()) {
            filePath = urlPath;

          } else if (pathStats.isDirectory()) {
            const files = await nodeFs.promises.readdir(urlPath);
            const defs = files.filter(f => !!~options.defaults.indexOf(f.toLocaleLowerCase()));

            if (defs && defs.length) {
              filePath = nodePath.normalize(nodePath.join(urlPath, defs[0]));
            }
          }
        }

        if (!filePath && entryFile) {
          const referrer = req.headers['referer'];

          if (referrer) {
            const referrerPath = this._getPathName(referrer || '/').replace(/[^/]+$/, '');
            if (referrerPath.length > 1 && pathname.startsWith(referrerPath)) {
              const noReferrer = pathname.slice(referrerPath.length - 1);
              filePath = nodePath.normalize(nodePath.join(rootPath, noReferrer));
            }

          } else {
            filePath = entryFile;
          }
        }

        if (filePath) {
          const fileStats = await this._getReadStats(filePath);
          if (fileStats && fileStats.isFile()) {
            const result = await this._fileResponse.send(filePath, req, res);
            if (typeof result === 'number') {
              throw new HttpError(result);
            }

            return result === true;
          }
        }

        return false;

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

        const result = await this._directoryListing.send(dirPath, res, pathname);
        if (typeof result === 'number') {
          throw new HttpError(result);
        }

        return result === true;

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
    if (res.destroyed || res.writableEnded) return;

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
      <title>Serve - Error ${statusCode}</title>
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