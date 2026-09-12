
import nodeHttp from 'node:http';

export default class HttpError {

  /**
   * @constructor
   * @param {number} status 
   * @param {string|Error} [message] 
   * @param {string} [code] 
   */
  constructor(status, message, code) {
    const err = new Error(this._getMessage(status, message));

    Error.captureStackTrace(err, HttpError);

    Object.setPrototypeOf(err, HttpError.prototype);

    const errStat = (status && typeof status === 'number' && status >= 400 && status <= 600) ? status : 500;
    let errCode = (!code && typeof message === 'object') ? message.name || message.code : code;
    if (!errCode) {
      errCode = (nodeHttp.STATUS_CODES[errStat] || 'Unknown').replace(/[\s]/g, '_').toUpperCase();
    }

    Object.defineProperty(err, 'code', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: errCode,
    });

    Object.defineProperty(err, 'status', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: errStat,
    });

    Object.defineProperty(err, 'expose', {
      enumerable: true,
      configurable: true,
      writable: true,
      value: errStat >= 400 && errStat < 500,
    });

    if (typeof message === 'object') {
      this._redefineProperty(message, err, 'name');
      this._redefineProperty(message, err, 'errno');
    }

    return err;
  }

  /**
   * @private
   * @param {number} status 
   * @param {string|Error} message 
   * @returns {string}
   */
  _getMessage(status, message) {
    if (typeof message === 'string') {
      return message;
    }

    const errStat = (status && typeof status === 'number' && status >= 400 && status <= 600) ? status : 500;
    const statusMsg = nodeHttp.STATUS_CODES[errStat] ?? 'Unknown Error';
    if (typeof message === 'object') {
      return message.message ?? `${errStat} ${statusMsg}`;
    }

    return `${errStat} ${statusMsg}`;
  }

  /**
   * @private
   * @param {object} src 
   * @param {object} dest 
   * @param {string} key 
   */
  _redefineProperty(src, dest, key) {
    const hasOwn = ('hasOwn' in Object && typeof Object.hasOwn === 'function') ? Object.hasOwn : Object.prototype.hasOwnProperty.call;

    if (hasOwn(src, key)) {
        const descriptor = Object.getOwnPropertyDescriptor(src, key);

        if (descriptor) {
          Object.defineProperty(dest, key, descriptor);

        } else {
          Object.defineProperty(dest, key, {
            enumerable: true,
            configurable: true,
            writable: true,
            value: src[key],
          });
        }
      }
  }
}