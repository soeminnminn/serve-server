import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import Routes from './routes.mjs';

/**
 * @typedef {object} RouteMap
 * @property {string} pattern
 * @property {RegExp} regexp
 * @property {string} path
 * @property {boolean} wildcard
 */

/**
 * @typedef {object} ServeOptions
 * @property {string} [root]
 * @property {number} [port]
 * @property {boolean} [noCache]
 * @property {string[]} [defaults]
 * @property {Array<RouteMap>|string|string[]} [routes]
 */

export default class Serve {
  /**
   * @private
   * @type {ServeOptions}
   */
  static OPTIONS_DEFAULT = {
    root: '.',
    port: 3000,
    defaults: ['index.html', 'index.htm'],
    routes: []
  };

  /**
   * @constructor
   * @param {ServeOptions} options 
   */
  constructor(options) {
    const opts = Object.assign({}, Serve.OPTIONS_DEFAULT, options);

    const rootPath = nodePath.normalize(nodePath.join(process.cwd(), opts.root) + nodePath.sep);
    const stats = nodeFs.lstatSync(rootPath);
    if (!stats.isDirectory()) {
      throw new Error("'root' must be directory.");
    }

    /**
     * @private
     * @type {ServeOptions}
     */
    this._options = opts;

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
    if (!this._isResponseClosed(res)) {
      let lastError = null;

      for (const route of this._routes) {
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
        console.log(lastError);
        this._routes.errorHandler(lastError, res);
      }
    }
  }

  listen() {
    const server = this._server;

    try {
      server.listen(this._options.port);

      server.on('listening', () => {
        const addr = server.address();
        const bind = typeof addr === 'string' ? `pipe \x1B[32m${addr}\x1B[39m ` : `port \x1B[32m${addr.port}\x1B[39m`;
        console.log('Listening on %s\x1B[0m', bind);
      });

    } catch (err) {
      console.error(err);
    }
  }
}