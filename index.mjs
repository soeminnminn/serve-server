import Serve from './src/serve.mjs';

(function() {
  let routes = [
    '/*/css/*.css=/assets/css/',
    '/*/js/*.js=/assets/js/',
    '/*/images/*=/assets/images/',
    '/*/fonts/*=/assets/fonts/',
    '/test=/index.html',
  ];

  routes = [
    '/^\/[^\/]+\/(css|js|images|fonts)\/([^\/]+)/=/assets/$1/$2',
    '/test=/index.html',
  ];

  const serve = new Serve({ entry: '.' });
  serve.listen();
})();
