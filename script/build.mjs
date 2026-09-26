import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import * as esBuild from 'esbuild';

import pkg from '../package.json' with { type: 'json' };

import { HELP_TEXT } from '../src/serve-const.mjs';

function escapeRegExp(src) {
  let result = '';
  for (let i = 0; i < src.length; i++) {
    const char = src.charAt(i);
    if (['-', '^', '$', '+', '.', '(', ')', '|', '[', ']', '{', '}', '*', '?', '\\'].includes(char)) {
      result += `\\${char}`;
    } else {
      result += char;
    }    
  }
  return result;
}

function replaceExponentialWithNumber(text) {
  // Regex to match scientific/exponential notation numbers
  const exponentialRegex = /[-+]?[0-9]*\.?[0-9]+[eE][-+]?[0-9]+/g;

  return text.replace(exponentialRegex, (match) => {
    // Convert the matched exponential string into a standard number
    const num = Number(match);

    // Return it as a full string decimal representation
    return num.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 20 });
  });
}

function removeInlineComments(code) {
  if (code.trim() == '//') return '';

  const commentLineRe = /^[\s]*\/\/[!#\s]+.*$/;
  if (commentLineRe.test(code)) {
    return code.replace(commentLineRe, '').trim();
  }

  return code
    .replace(/[\s]+(?<=[^:\\])\/\/([\s]+[\s\S]+)?$/, '')
    .replace(/\/\*(\*?)(!?)[\s]+[\s\S]*?[\s]+\*\//g, '');
}

async function loadStyles(name, cssFile, lines, asExport = false) {
  const filePath = nodePath.resolve(nodePath.join(process.cwd(), cssFile));
  try {
    await nodeFs.promises.access(filePath, nodeFs.constants.R_OK);

    const content = await nodeFs.promises.readFile(filePath, 'utf-8');

    let css = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    css = css.replace(/\n/, ' ');
    css = css.replace(/[\s]+/g, ' ');
    css = css.replace(/\}/g, '}\n');
    css = css.replace(/(@media[^\{]+)\{/g, '$1{\n');

    if (asExport) {
      lines.push(`export const ${name} = ` + '`');
    } else {
      lines.push(`const ${name} = ` + '`');
    }    

    const readlines = css.split('\n');
    for (const l of readlines) {
      const ltrim = l.trim();
      if (ltrim) lines.push(ltrim);
    }

    lines.push('`;');
  } catch (err) {
    console.error(err);
  }
}

async function transform(outText) {
  
  const version = pkg.version;

  const importRe = /^import[^;]+;$/;
  const importName = {
    regex: /(node[A-Z][a-z]+)[0-9]+\./g,
    replace: '$1.'
  };

  const classStart = {
    regex: /^var[\s]+([0-9a-zA-Z]+)[\s]+=[\s]+class(?:[\s]+_[0-9a-zA-Z]+)?([\s]+extends[\s]+[0-9a-zA-Z]+)?[\s]+\{$/,
    replace: '\nclass $1$2 {'
  };

  const commentLineRe = /^[\s]*\/\/[!#\s]+.*$/;
  const commentBlockRe = {
    start: /^[\s]*\/\*\*$/gm,
    end: /^[\s]*\*\/$/
  }

  const stylesFields = {
    regex: /^var[\s]+(baseStyles|listStyles)[\s]+=[\s]+`/,
    replace: 'const $1 = `',
  };

  const versionConstRe = /^var[\s]+VERSION[^;]+;$/;

  const helpTextRe = {
    start: /^var[\s]+HELP_TEXT[^`]+`$/,
    end: /^`;$/,
  };

  const code = outText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const readlines = code.split('\n');

  const lines = [
    "#!/usr/bin/env node",
    "",
    "/**",
    " * @author Soe Minn Minn",
    ` * @version ${version}`,
    " */",
    "",
    "import * as nodeFs from 'node:fs';",
    "import nodePath from 'node:path';",
    "import nodeHttp from 'node:http';",
    "import * as nodeUtil from 'node:util';",
    "import { createRequire } from 'node:module';",
    "",
    `const VERSION = "${version}";`,
    "",
    "const HELP_TEXT = `",
    ...(HELP_TEXT.replace(/\r\n|\r/g, '\n').trim().split('\n')),
    "`;",
  ];

  const classMap = {};
  let inCommentBlock = false;
  let inHelpText = false;

  for (const line of readlines) {
    let trimedLine = line.trimEnd();

    if (trimedLine) {
      if (importRe.test(trimedLine)) continue;

      const classMatch = classStart.regex.exec(trimedLine);
      if (classMatch) {
        const className = classMatch[1];
        classMap[className] = {
          regex: new RegExp(`_${escapeRegExp(className)}([\\.,\\)\\]\\}\\s])`, 'g'),
          replace: `${className}$1`
        };

        lines.push(trimedLine.replace(classStart.regex, classStart.replace));
        continue;
      }

      if (commentBlockRe.start.test(trimedLine)) {
        inCommentBlock = true;
        continue;

      } else if (inCommentBlock && commentBlockRe.end.test(trimedLine)) {
        inCommentBlock = false;
        continue;
      }
      if (inCommentBlock) {
        continue;
      }

      if (commentLineRe.test(trimedLine)) {
        continue;
      }
      //trimedLine = removeInlineComments(trimedLine);

      if (versionConstRe.test(trimedLine)) {
        continue;
      }

      if (helpTextRe.start.test(trimedLine)) {
        inHelpText = true;
        continue;
      } else if (inHelpText && helpTextRe.end.test(trimedLine)) {
        inHelpText = false;
        continue;
      }
      if (inHelpText) {
        continue;
      }

      const fullTrimedLine = trimedLine.trim();
      if (!fullTrimedLine) continue;

      if (stylesFields.regex.test(trimedLine)) {
        const l = trimedLine.replace(stylesFields.regex, stylesFields.replace);
        lines.push('');
        lines.push(l);

      } else {
        let l = trimedLine.replace(importName.regex, importName.replace);

        for (const cls of Object.keys(classMap)) {
          l = l.replace(classMap[cls].regex, classMap[cls].replace);
        }

        l = replaceExponentialWithNumber(l);
        lines.push(l);
      }
    }
  }

  return lines.join('\n');
}

(async function main() {
  
  const stylesPlugin = {
    name: 'styles',
    setup(build) {
      build.onResolve({ filter: /styles-loader\.mjs$/ }, (args) => {
        // return {
        //   path: nodePath.join(process.cwd(), 'script', 'styles.mjs')
        // };
        return {
          path: args.path,
          namespace: 'serve'
        };
      });

      build.onLoad({ filter: /styles-loader\.mjs$/, namespace: 'serve' }, async (args) => {
        const lines = [];

        await loadStyles('baseStyles', 'src/styles/base-styles.css', lines, true);
        await loadStyles('listStyles', 'src/styles/list-styles.css', lines, true);

        return { contents: lines.join('\n') };
      });
    }
  };

  const entryPoint = nodePath.resolve('./src/serve-cli.mjs');

  const result = await esBuild.build({
    entryPoints: [entryPoint],
    outbase: './src',
    outdir: './dist',
    platform: 'node',
    format: 'esm',
    target: ['node20'],
    bundle: true,
    write: false,
    plugins: [stylesPlugin],
  });


  try {
    const outfile = result.outputFiles[0];
    const outText = outfile.text;

    const code = await transform(outText);

    const outfilePath = nodePath.normalize(nodePath.join(process.cwd(), 'dist', 'serve'));
    await nodeFs.promises.writeFile(outfilePath, code, 'utf-8');

  } catch (err) {
    console.error(err);
  }
})();