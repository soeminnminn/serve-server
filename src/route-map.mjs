
export class RouteMap {
  /**
   * @constructor
   * @param {string} pattern 
   * @param {RegExp} regex 
   * @param {string} path 
   */
  constructor(pattern, regex, path) {
    /**
     * @private
     * @type {string}
     */
    this._pattern = pattern;
    /**
     * @private
     * @type {RegExp}
     */
    this._regex = regex;
    /**
     * @private
     * @type {string}
     */
    this._path = path;
  }

  /**
   * @returns {string}
   */
  get pattern() {
    return this._pattern;
  }

  /**
   * @returns {RegExp}
   */
  get regex() {
    return this._regex;
  }

  /**
   * @returns {string}
   */
  get path() {
    return this._path;
  }

  /**
   * Returns a Boolean value that indicates whether or not a pattern exists in a searched string.
   * @param {string} input 
   * @returns {boolean} 
   */
  test(input) {
    return this._regex.test(input);
  }

  /**
   * Replaces text in a string, using a regular expression
   * @param {string} input 
   * @returns {string}
   */
  replace(input) {
    return input.replace(this._regex, this._path);
  }
}

class RouteMapIterator {
  /**
   * @constructor
   * @param {RouteMap[]} routes 
   */
  constructor(routes) {
    /**
     * @private
     * @type {RouteMap[]}
     */
    this._routes = routes;
    /**
     * @type {number}
     */
    this.index = 0;
  }

  /**
   * @returns {{ value: RouteMap|undefined, done: boolean }}
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
 * @implements {ArrayLike<RouteMap>}
 */
export default class RouteMaps {
  /**
   * @constructor
   * @param {Array<{ pattern: string|RegExp, path: string }>|string|string[]} [routesMap] 
   */
  constructor(routesMap) {
    /**
     * @private
     * @type {RouteMap[]}
     */
    this._maps = routesMap ? this._parse(routesMap) : [];
  }

  [Symbol.iterator]() {
    return new RouteMapIterator(this._maps);
  }

  /**
   * @returns {number}
   */
  get length() {
    return this._maps.length;
  }

  /**
   * @private
   * @param {Array<{ pattern: string|RegExp, path: string }>|string|string[]} [routesMap] 
   * @returns {Array<RouteMap>}
   */
  _parse(routesMap) {
    if (routesMap) {
      let maps = [];

      if (typeof routesMap === 'string') {
        maps = `|${routesMap}`.split(/=([^\|]+)/g).filter(Boolean)
          .reduce((ret, x, i, arr) => {
            if ((i % 2) == 0) {
              ret.push({ pattern: x.slice(1), path: arr[i + 1] });
            }

            return ret;
          }, []);

      } else if (Array.isArray(routesMap)) {
        maps = routesMap.slice();
      }

      return maps.map((x) => {
        let pattern = '';
        let path = '';

        if (typeof x === 'string') {
          const sp = x.split(/=([^\|]+)/).filter(Boolean);
          pattern = sp[0];
          path = sp[1];

        } else {
          pattern = x.pattern;
          path = x.path;
        }

        if (pattern instanceof RegExp) {
          return new RouteMap(pattern.source, pattern, path);

        } else if (typeof pattern === 'string') {
          const regexp = this._pathToRegExp(pattern);
          if (regexp) {
            return new RouteMap(pattern, regexp, path);
          }
        }

        return null;

      }).filter(Boolean);
    }

    return [];
  }

  /**
   * @private
   * @param {string} str 
   * @param {string} flags 
   * @returns {RegExp|null}
   */
  _tryCreateRegex(str, flags) {
    try {
      return new RegExp(str, flags);
    } catch (err) {
      console.warn(err);
    }
    return null;
  }

  /**
   * Create a regular expression source as directed by gitignore rule.
   * 
   * @private
   * @param {string} pattern 
   * @returns {string}
   */
  _transform(pattern) {
    const seperator = '/';
    let source = pattern;

    const isNegated = source.charAt(0) == '!';
    if (/^\\\\!|^!/.test(source)) {
      source = source.slice(1);
    }

    let startingClause = '';
    let endingClause = '';

    const isDirectoryOnly = /\/$/.test(source);
    const isFileOnly = /\.[^\/]+$/.test(source);

    if (isDirectoryOnly) {
      source = source.slice(0, -1);
      endingClause = `($|[\\${seperator}].*$)`;

    } else if (isFileOnly) {
      endingClause = '$';

    } else {
      endingClause = '.*$';
    }

    const isRooted = /^\/./.test(source);
    if (isRooted) {
      startingClause = `^`;
    }

    // leading \# and \! become just # and !
    source = source.replace(/\\([#!])/, '$!');

    // allow for *content&#47;...&#47;content** in path
    source = source.replace(/\/\*\*\//g, '\\/([^\\/]\\/)*');

    // ensure . doesn't become regexp instructions
    source = source.replace(/\./g, '\\.');

    // ensure / becomes the path delimiter
    source = source.replace(/\//g, `\\${seperator}`);

    // replace a trailing &#547;** with regexp any to end of string  noting that we have already turned / into \\/
    source = source.replace(/\/\/\*\*$/, '.*');

    /* we have nothing to do for the permitted [A-Za-z] etc */

    // a leading **&#47; means match in any directory and needs no regexp preamble
    source = source.replace(/^\*\*\//, '');

    // turn ?  into reg expr meaning one non slash char
    source = source.replace(/\?/g, '[^\/]');

    // turn * into zero or more non / chars
    source = source.replace(/\*+/g, '[^\\/]*');

    // escape out vertical bar that might be in a file name
    source = source.replace(/\|/g, '\\|');

    const result = startingClause + source + endingClause;
    return isNegated ? `(?=(^((?!(${result})).)*$))` : result;
  }

  /**
   * @private
   * @param {string} pattern 
   * @returns {RegExp|null}
   */
  _pathToRegExp(pattern) {
    if (!pattern || typeof pattern !== 'string') {
      return null;
    }

    let regex = null;
    let tempStr = pattern;

    if (tempStr.startsWith('/')) {
      tempStr = tempStr.slice(1);
    }

    tempStr = tempStr.replace(/\/([gimys]*)?$/, '');

    if (tempStr.startsWith('^') || tempStr.endsWith('$')) {
      regex = this._tryCreateRegex(tempStr, 'i');

    } else {
      const posibleEscaped = [
        '\\-', '\\^', '\\$', '\\+', '\\.', '\\(', '\\)', '\\|', '\\[', '\\]', '\\{', '\\}', '\\*', '\\?', '\\\\',
        '\\d', '\\D', '\\w', '\\W', '\\s', '\\S', '\\t', '\\r', '\\n', '\\v', '\\f', '\\b', '\\B', '\\0', '\\c'
      ];

      for (const escaped of posibleEscaped) {
        if (tempStr.indexOf(escaped) > -1) {
          regex = this._tryCreateRegex(tempStr, 'i');
          break;
        }
      }
    }

    if (!regex) {
      tempStr = this._transform(pattern);
      regex = this._tryCreateRegex(tempStr);
    }

    return regex;
  }
}