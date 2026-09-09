import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import Serve from './serve.mjs';

const VERSION = '2.0.0';

const HELP_TEXT = `
Static file serving and directory listing.

node serve [folderpath] [-dir <folderpath>] [-p <port>] [-r <routes>]

  -help, --help     Shows this help message
  -ver, --version   Displays the current version of serve
  -dir, --dir       Set the root folder path
  -p, --port        Set the port
  -r, --routes      Set the routes mappings. Format: "<path_wildcard>=<filepath>|<path_regexp>=<filepath>"
`;

/**
 * @typedef {object} SchemaEntry
 * @property {string|number|boolean} default
 * @property {string[]} keys
 * @property {boolean} [defaultParam]
 * @property {RegExp} [match]
 * @property {boolean} [flag]
 */

/**
 * @param {Record<string, SchemaEntry>} schema 
 * @returns {Record<string, string|number|boolean>}
 */
function parseArgs(schema) {
  let argv = process.argv.slice(2);

  let defParam = null;
  const args = {};
  const keys = {};

  for (const k of Object.keys(schema)) {
    const schemaData = schema[k];
    if (typeof schemaData === 'object') {
      if (schemaData.defaultParam === true) {
        defParam = { key: k, match: schemaData.match };
      }

      args[k] = schemaData.default;
      for (const j in schemaData.keys) {
        keys[schemaData.keys[j]] = k;
      }
    }
  }

  const keysArr = Object.keys(keys);

  return argv.reduce((acc, val, idx) => {
    if (!keysArr.includes(val) && idx === 0 && defParam) {
      if (defParam.match && nodeUtil.types.isRegExp(defParam.match) && defParam.match.test(val)) {
        acc[defParam.key] = argv[idx];
        return acc;

      } else {
        acc[defParam.key] = argv[idx];
        return acc;
      }
    }

    if (keysArr.includes(val)) {
      const key = keys[val];

      if (schema[key].flag == true) {
        acc[key] = true;

      } else if (argv[idx + 1]) {
        acc[key] = argv[idx + 1];
      }
    }

    return acc;
  }, args);
}

/**
 * Parse dot env
 * @param {string} [root] 
 * @returns {Record<string, string>}
 */
function parseEnv(root) {
  if (!root) {
    root = process.cwd();
  }
  const dotenvPath = nodePath.resolve(root, '.env');

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
    dir: { 'defaultParam': true, 'default': env.PUBLIC_DIR || env.SERVE_DIR || '.', 'keys': ['-d', '--dir'] },
    port: { 'default': env.PORT || 3000, 'keys': ['-p', '--port'], 'match': /^[\d]+$/ },
    routes: { 'default': env.SERVE_ROUTES || '', 'keys': ['-r', '--routes'] },
    help: { 'default': false, 'keys': ['-help', '--help'], flag: true },
    version: { 'default': false, 'keys': ['-ver', '--version'], flag: true },
  };

  const parsedArgs = parseArgs(argsSchema);

  if (parsedArgs.help == true) {
    console.log(HELP_TEXT);

  } else if (parsedArgs.version == true) {
    console.log(VERSION);

  } else {
    const serve = new Serve({
      root: parsedArgs.dir,
      port: parsedArgs.port,
      routes: parsedArgs.routes,
    });
    serve.listen();
  }
})();