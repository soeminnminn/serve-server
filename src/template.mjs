

export default class Template {
  /**
   * @constructor
   * @param {string} template 
   */
  constructor(template) {
    this.template = template;
  }

  /**
   * Compile template string into function
   * @param {Record<string, any>} data 
   * @returns {(data: Record<string, any>) => string}
   */
  compile(data) {
    let code = "var p = [], print = function() { p.push.apply(p, arguments); };";
    code += "with(obj) { p.push('";
    code += this.template.replace(/[\r\t\n]/g, " ")
      .replace(/[\']/g, "\"")
      .split("{{")
      .join("\t")
      .replace(/((^|\}\})[^\t]*)'/g, "$1\r")
      .replace(/\t:(.*?)\}\}/g, "' +$1+ '")
      .split("\t")
      .join("');")
      .split("}}")
      .join("p.push('")
      .split("\r").join("\\'");
    code += "'); }";
    code += "return p.join('');";
    const fn = new Function("obj", code);
    return data ? fn(data) : fn;
  }
}