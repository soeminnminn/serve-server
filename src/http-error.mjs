
import nodeHttp from 'node:http';

export default class HttpError extends Error {

  /**
   * @constructor
   * @param {number} status 
   * @param {string|Error} [message] 
   * @param {string} [code] 
   */
  constructor(status, message, code) {
    super(HttpError.getMessage(status, message));

    const errStat = (status && typeof status === 'number' && status >= 400 && status <= 600) ? status : 500;
    let errCode = (!code && typeof message === 'object') ? message.name || message.code : code;
    if (!errCode) {
      errCode = (nodeHttp.STATUS_CODES[errStat] || 'Unknown').replace(/[\s]/g, '_').toUpperCase();
    }

    Object.defineProperty(this, 'code', {
      get: () => errCode,
    });

    Object.defineProperty(this, 'status', {
      get: () => errStat,
    });

    Object.defineProperty(this, 'expose', {
      get: () => errStat < 500,
    });

    if (typeof message === 'object') {
      for (const pKey of ['name', 'errno', 'stack']) {
        Object.defineProperty(this, pKey, {
          get: () => message[pKey],
        });
      }
    }
  }

  /**
   * @private
   * @param {number} status 
   * @param {string|Error} message 
   * @returns {string}
   */
  static getMessage(status, message) {
    if (typeof message === 'string') {
      return message;
    }

    const errStat = (status && typeof status === 'number' && status >= 400 && status <= 600) ? status : 500;
    const statusMsg = nodeHttp.STATUS_CODES[errStat] || 'Unknown Error';
    if (typeof message === 'object') {
      return message.message || `${errStat} ${statusMsg}`;
    }

    return `${errStat} ${statusMsg}`;
  }
}