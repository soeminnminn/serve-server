
import * as nodeFs from 'node:fs';
import nodePath from 'node:path';

function loadStyles(fileName) {
  const filePath = nodePath.resolve(nodePath.join(process.cwd(), 'src', 'styles', fileName));
  return nodeFs.readFileSync(filePath, 'utf-8');
}

export const baseStyles = loadStyles('base-styles.css');
export const listStyles = loadStyles('list-styles.css');