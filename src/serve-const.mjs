
export const VERSION = 'development';

export const HELP_TEXT = `
Static file serving and directory listing.

node serve [root folder path or entry html file] [-dir <folderpath>] [-p <port>] [-r <routes>]

  -?, --help     Shows this help message
  -v, --version   Displays the current version of serve
  -d, --dir       Set the root folder path
  -p, --port        Set the port
  -r, --routes      Set the routes mappings. Format: "<path_matcher>=<rewrite_path>|<path_matcher>=<rewrite_path>"

routes mappings:

  You can set mutipile routes sperate with "|".

  "<path_matcher>"  must be regular expression string or .gitignore style wildcard rule.

  "<rewrite_path>"  must be a single relative path. If path is point to directory, automictically append last path of current url as file name.
`;