import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';

import Routes from './routes.mjs';

/**
 * @typedef {object} ServeOptions
 * @property {string} [entry]
 * @property {number} [port]
 * @property {string[]} [defaults]
 * @property {Array<{ pattern: string|RegExp, path: string }>|string|string[]} [routes]
 * @property {boolean} [dirListing]
 * @property {string} [pluginPath]
 * @property {string[]} [plugins]
 */

export default class Serve {
  /**
   * @private
   * @type {ServeOptions}
   */
  static OPTIONS_DEFAULT = {
    port: 3000,
    defaults: ['index.html', 'index.htm'],
    routes: [],
    dirListing: true
  };

  /**
   * @constructor
   * @param {ServeOptions} options 
   */
  constructor(options) {
    const opts = Object.assign({}, Serve.OPTIONS_DEFAULT, options || {});

    let rootPath = process.cwd();

    if (opts.entry && typeof opts.entry === 'string') {
      const entryPath = nodePath.normalize(nodePath.join(process.cwd(), opts.entry));
      const entryStats = nodeFs.lstatSync(entryPath);

      if (entryStats.isDirectory()) {
        rootPath = entryPath;
        opts.entry = null;

      } else if (entryStats.isFile()) {
        const entryExt = nodePath.extname(entryPath).toLocaleLowerCase();

        if (['.html', '.htm'].includes(entryExt)) {
          rootPath = nodePath.dirname(entryPath);

        } else {
          throw new Error("'entry' must be folder or html file.");
        }
      }
    }

    /**
     * @private
     * @type {number}
     */
    this._port = opts.port || 3000;

    /**
     * @private
     * @type {string}
     */
    this._rootPath = rootPath;

    /**
     * @private
     * @type {Routes}
     */
    this._routes = new Routes(rootPath, opts);

    /**
     * @private
     * @type {nodeHttp.Server}
     */
    this._server = nodeHttp.createServer(this.handle.bind(this));
  }

  /**
   * @returns {string}
   */
  get root() {
    return this._rootPath;
  }

  /**
   * @type {nodeHttp.Server}
   */
  get server() {
    return this._server;
  }

  /**
   * @private
   * @param {nodeHttp.ServerResponse} res 
   * @returns {boolean}
   */
  _isResponseClosed(res) {
    return res.destroyed || res.writableEnded;
  }

  /**
   * @param {nodeHttp.IncomingMessage} req 
   * @param {nodeHttp.ServerResponse} res 
   * @returns {Promise<void>}
   */
  async handle(req, res) {
    const routes = this._routes;

    if (!routes.isReady) {
      console.error(new Error(`'Router' does not ready.`));
      return;
    }

    if (!this._isResponseClosed(res)) {
      let lastError = null;

      for (const route of routes) {
        if (route && route.isMatch(req)) {
          try {
            const handled = await route.handler(req, res);
            if (handled === true) {
              console.log('\x1B[90m%s\x1B[39m \x1B[32m%s\x1B[39m %s', 'SERVE', req.method, req.url);
              lastError = null;
              break;
            }

          } catch (err) {
            lastError = err;
          }
        }
      }

      if (lastError && !this._isResponseClosed(res)) {
        routes.errorHandler(lastError, res);
      }
    }
  }

  /**
   * @returns {Promise<nodeHttp.Server>}
   */
  async listen() {
    const server = this._server;
    const port = this._port;

    try {
      await this._routes.build();

      server.listen(port);

      server.on('listening', () => {
        const addr = server.address();
        const bind = typeof addr === 'string' ? `pipe \x1B[32m${addr}\x1B[39m ` : `port \x1B[32m${addr.port}\x1B[39m`;
        console.log('Listening on %s\x1B[0m', bind);
      });

      server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
          console.error('Address in use, retrying...');
          
          setTimeout(() => {
            server.close();
            server.listen(port);
          }, 1000);
        }
      });

    } catch (err) {
      console.error(err);
    }

    return server;
  }
}