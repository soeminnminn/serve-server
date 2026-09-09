import * as nodeFs from 'node:fs';
import nodePath from 'node:path';
import nodeHttp from 'node:http';
import HttpError from './http-error.mjs';
import { baseStyles, listStyles } from './styles-loader.mjs';

export default class DirectoryListing {
  /**
   * @constructor
   * @param {string} rootPath 
   */
  constructor(rootPath) {
    this._rootPath = rootPath;
  }

  /**
   * @param {File} a 
   * @param {File} b 
   * @returns {-1|0|1}
   */
  _fileSort(a, b) {
    // sort ".." to the top
    if (a.name === '..' || b.name === '..') {
      return a.name === b.name ? 0 : a.name === '..' ? -1 : 1;
    }
    return Number(b.stat && b.stat.isDirectory()) - Number(a.stat && a.stat.isDirectory()) ||
      String(a.name).toLocaleLowerCase().localeCompare(String(b.name).toLocaleLowerCase());
  }

  /**
   * @private
   * @param {number} bytes 
   * @returns {string}
   */
  _formatFileSize(bytes) {
    const s = ['bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB'];
    let pos = 0;
    for (pos = 0; bytes >= 1000; pos++, bytes /= 1024);
    const d = Math.round(bytes * 10);
    return pos ? [parseInt(d / 10), ".", d % 10, " ", s[pos]].join('') : `${bytes} bytes`;
  }

  /**
   * @private
   * @param {Date} d 
   * @returns {string}
   */
  _formatDate(d) {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return [m[d.getMonth()], ' ', d.getDate(), ', ', d.getFullYear(), " ",
    (d.getHours() % 12 || 12), ":", (d.getMinutes() < 10 ? '0' : '') + d.getMinutes(),
      " ", d.getHours() >= 12 ? 'PM' : 'AM'].join('');
  }

  /**
   * @private
   * @param {Array<{ name: string, stat: nodeFs.Stats }>} fileList 
   * @param {string} pathname 
   * @returns {string}
   */
  _buildListContent(fileList, pathname) {
    let content = `<div class=\"page-title\">Index of - <strong>${pathname}</strong></div>`;
    content += '<ul class="list">';
    content += '<li class="header"><span>Name</span><span>Size</span><span>Modified</span></li>';

    for (const i in fileList) {
      const file = fileList[i];

      const date = file.stat && file.name !== '..' ? `${this._formatDate(file.stat.mtime)}` : '&nbsp;';
      const size = this._formatFileSize(file.stat && !file.stat.isDirectory() ? file.stat.size : 0);
      const pathUrl = nodePath.join(pathname, file.name);

      if (file.name == '..' || file.stat.isDirectory()) {
        content += `<li class='directory'>`;
        content += `<a href='${pathUrl}'>${file.name}</a>`;
        content += `<span>&nbsp;</span>`;
        content += `<span class="date">${date}</span>`;
        content += '</li>';
      } else {
        content += `<li class='file'>`;
        content += `<a href='${pathUrl}'>${file.name}</a>`;
        content += `<span class="size">${size}</span>`;
        content += `<span class="date">${date}</span>`;
        content += '</li>';
      }
    }
    content += '</ul>';

    return content;
  }

  /**
   * @param {nodeHttp.ServerResponse} res 
   * @param {string} dirPath 
   * @param {string} pathname 
   * @returns {Promise<void>}
   */
  async send(dirPath, res, pathname) {
    try {
      if (res.destroyed || res.writableEnded) {
        return;
      }

      await nodeFs.promises.access(dirPath);

      const showUp = nodePath.normalize(nodePath.resolve(dirPath) + nodePath.sep) !== this._rootPath;
      const dirStat = await nodeFs.promises.stat(dirPath);

      if (!dirStat.isDirectory()) {
        throw new HttpError(400, '"path" is not directory.');
      }

      const files = await nodeFs.promises.readdir(dirPath);

      const fileList = [];
      for (const file of files) {
        try {
          const stat = await nodeFs.promises.stat(nodePath.join(dirPath, file));
          fileList.push({ name: file, stat });
        } catch (err) {
          console.log(err);
        }
      }

      if (showUp) {
        fileList.push({ name: '..' });
      }

      fileList.sort(this._fileSort);

      const content = this._buildListContent(fileList, pathname || '/');

      const html = `<!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset=utf-8>
        <meta content=\"IE=edge\" http-equiv=X-UA-Compatible>
        <meta content=\"width=device-width,initial-scale=1\" name=\"viewport\">
        <link rel=\"icon\" type=\"image/png\" href=\"./icon/favicon.png\">
        <title>Serve - ${pathname || '/'}</title>
        <style type=\"text/css\">
        ${baseStyles}
        ${listStyles}
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

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.write(html);
      res.end();

    } catch (err) {
      if (err instanceof HttpError) {
        throw err;
      } else {
        throw new HttpError(500, err);
      }
    }
  }
}