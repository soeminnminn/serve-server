
/**
 * A tiny and extremely fast JavaScript library for compiling and matching basic glob patterns
 * 
 * @see {@link https://github.com/axtgr/wildcard-match}
 * @version 5.1.4
 */
export default class Wildcard {
  /**
   * Compiles one or more glob patterns into a RegExp and returns an isMatch function.
   * The isMatch function takes a sample string as its only argument and returns `true`
   * if the string matches the pattern(s).
   * 
   * @constructor
   * @param {string | string[]} pattern
   * @param {string | boolean | {separator?: string | boolean, flags?: string}} [options] 
   * @throws {TypeError}
   */
  constructor(pattern, options) {
    /** 
     * @private
     * @type {{separator?: string | boolean, flags?: string}}
     */
    this._options = {};

    if (typeof options === 'string' || typeof options === 'boolean') {
      this._options = { separator: options };
    } else {
      this._options = options || {};
    }

    if (this._options.separator === '\\') {
      throw new Error('\\ is not a valid separator because it is used for escaping. Try setting the separator to `true` instead');
    }

    if (typeof pattern !== 'string' && !Array.isArray(pattern)) {
      throw new TypeError(`The first argument must be a single pattern string or an array of patterns, but ${typeof pattern} given`);
    }

    /** 
     * @private
     * @type {string}
     */
    this._pattern = pattern;

    const regexpPattern = this._transform(this.pattern, this._options.separator);

    /** 
     * @private
     * @type {RegExp}
     */
    this._regexp = new RegExp(`^${regexpPattern}$`, this._options.flags);
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
  get regexp() {
    return this._regexp;
  }

  /**
   * Escapes a character if it has a special meaning in regular expressions
   * and returns the character as is if it doesn't
   * 
   * @private
   * @param {string} char 
   * @returns {string}
   */
  _escapeRegExpChar(char) {
    if (['-', '^', '$', '+', '.', '(', ')', '|', '[', ']', '{', '}', '*', '?', '\\'].includes(char)) {
      return `\\${char}`;
    }
    return char;
  }

  /**
   * Escapes all characters in a given string that have a special meaning in regular expressions
   * @private
   * @param {string} str 
   * @returns {string}
   */
  _escapeRegExpString(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      result += this._escapeRegExpChar(str[i]);
    }
    return result;
  }

  /**
   * Transforms one or more glob patterns into a RegExp pattern
   * 
   * @private
   * @param {string|string[]} pattern 
   * @param {string|boolean} separator 
   * @returns {string}
   */
  _transform(pattern, separator = true) {
    if (Array.isArray(pattern)) {
      const regExpPatterns = pattern.map((p) => `^${this._transform(p, separator)}$`);
      return `(?:${regExpPatterns.join('|')})`;
    }

    let separatorSplitter = '';
    let separatorMatcher = '';
    let wildcard = '.';

    if (separator === true) {
      // In this case forward slashes in patterns match both forward and backslashes in samples:
      //
      // `foo/bar` will match `foo/bar`
      //           will match `foo\bar`
      //
      separatorSplitter = '/';
      separatorMatcher = '[/\\\\]';
      wildcard = '[^/\\\\]';
    } else if (typeof separator === 'string') {
      separatorSplitter = separator;
      separatorMatcher = this._escapeRegExpString(separatorSplitter);

      if (separatorMatcher.length > 1) {
        separatorMatcher = `(?:${separatorMatcher})`;
        wildcard = `((?!${separatorMatcher}).)`;
      } else {
        wildcard = `[^${separatorMatcher}]`;
      }
    }

    // When a separator is explicitly specified in a pattern,
    // it MUST match ONE OR MORE separators in a sample:
    //
    // `foo/bar/` will match  `foo//bar///`
    //            won't match `foo/bar`
    //
    // When a pattern doesn't have a trailing separator,
    // a sample can still optionally have them:
    //
    // `foo/bar` will match `foo/bar//`
    //
    // So we use different quantifiers depending on the index of a segment.
    const requiredSeparator = separator ? `${separatorMatcher}+?` : '';
    const optionalSeparator = separator ? `${separatorMatcher}*?` : '';

    const segments = separator ? pattern.split(separatorSplitter) : [pattern];
    let result = '';

    for (let s = 0; s < segments.length; s++) {
      const segment = segments[s];
      const nextSegment = segments[s + 1];
      let currentSeparator = '';

      if (!segment && s > 0) {
        continue;
      }

      if (separator) {
        if (s === segments.length - 1) {
          currentSeparator = optionalSeparator;
        } else if (nextSegment !== '**') {
          currentSeparator = requiredSeparator;
        } else {
          currentSeparator = '';
        }
      }

      if (separator && segment === '**') {
        if (currentSeparator) {
          result +=
            s === 0
              ? ''
              : s === segments.length - 1
                ? `(?:${requiredSeparator}|$)`
                : requiredSeparator;
          result += `(?:${wildcard}*?${currentSeparator})*?`;
        }
        continue;
      }

      for (let c = 0; c < segment.length; c++) {
        const char = segment[c];

        if (char === '\\') {
          if (c < segment.length - 1) {
            result += this._escapeRegExpChar(segment[c + 1]);
            c++;
          }
        } else if (char === '?') {
          result += wildcard;
        } else if (char === '*') {
          result += `${wildcard}*?`;
        } else {
          result += this._escapeRegExpChar(char);
        }
      }

      result += currentSeparator;
    }

    return result;
  }

  /**
   * @param {string} sample 
   * @returns {boolean}
   * @throws {TypeError}
   */
  isMatch(sample) {
    if (typeof sample !== 'string') {
      throw new TypeError(`Sample must be a string, but ${typeof sample} given`);
    }

    return this._regexp.test(sample);
  }
}