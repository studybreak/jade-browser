var fs = require('fs')
  , path = require('path')
  , jade = require('jade')
  , async = require('async')
  , glob = require('glob')
  , parser = require('uglify-js').parser
  , compiler = require('uglify-js').uglify
  , Expose = require('./lib/expose')
  , render = require('./lib/render').render
  , utils = require('./lib/utils');


var defaultOptions = exports.defaultOptions = 
  function(exportPath, patterns, options) {
    var options = options || {};
    options.ext = options.ext || 'jade';
    options.namespace = options.namespace || 'jade';
    options.built = false;
    options.minified = false;
    options.debug = options.debug || false;
    options.minify = options.minify || false;
    options.maxAge = options.maxAge || 86400;
    options.exportPath = exportPath.replace(/\/$/,'');
    options.root = path.normalize(options.root ? options.root.replace(/\/$/,'') : __dirname);
    options.regexp = utils.toRegExp(exportPath, true);
    options.headers = {
        'Cache-Control': 'public, max-age=' + options.maxAge
      , 'Content-Type': 'text/javascript' 
    };

    if (typeof patterns == 'string') {
      patterns = [patterns];
    }
    options.patterns = patterns;
    options.files = [];
    return options;
};

var middleware = exports.middleware = function(exportPath, patterns, options) {
  options = options || {};
  options = defaultOptions(exportPath, patterns, options);
  
  return function(req, res, next){
    if (!req.url.match(options.regexp)) {
       return next();
    };

    function render() {
      res.writeHead(200, options.headers);
      res.end(options.built);
    };

    if (options.built) return render();
    process(options, render);
  }
};

var watch = exports.watch = function(exportPath, patterns, options, callback) {
  options = options || {};
  options = defaultOptions(exportPath, patterns, options);

  process(options, function() {
    console.log('Watching jade namespace:', options.namespace);
    options.files.forEach(function(fd) {
      // console.log('Watching:', fd);
      fs.watchFile(fd, {persistent: true, interval: 500}, function(curr, prev) {
        // make sure we don't fire twice...
        if (curr.mtime.getTime() === prev.mtime.getTime()) return;
        console.log("File changed:", fd);

        options.built = false;
        options.minified = false;
        recache(options, callback)

      })
    });
  });
};

var cache = exports.cache = function(exportPath, patterns, options, callback) {
  options = options || {};
  options = defaultOptions(exportPath, patterns, options);
  recache(options, callback);
}

var recache = function(options, callback) {
  process(options, function() {
    write(options);
    if (callback) callback();
    
  });
};

var write = function(options) {
  console.log('Caching jade namespace:', options.namespace);
  var filename = options.cacheRoot + options.exportPath;
  
  // cache development version
  fs.writeFileSync(filename, options.built, 'utf8');
  
  // cache minified version
  if (options.minify) {
    fs.writeFileSync(filename.replace('.js', '-min.js'), options.minified, 'utf8');
  }
  // do we have an event listener?
  if (options.onWrite && typeof(options.onWrite) === 'function') {
    options.onWrite();
  };
  
}


var process = exports.process = function(options, callback) {
  var files = [];
  
  options.patterns.forEach(function(pattern) {
    pattern = path.join(options.root, pattern);

    try {
      var matches = glob.sync(pattern);
      matches = matches.filter(function(match) {
        return match.match(options.ext + '$');
      });
      files = files.concat(matches);
    } catch(e) {}
  });
  options.files = files;
  
  var getFile = function(filename, callback) {
    fs.readFile(filename, 'utf8', function(err, content){
      if (err) return callback(err);

      var tmpl = jade.compile(content, {
          filename: filename
        , inline: false
        , compileDebug: false
        , client: true
      });

      if (typeof tmpl == 'function') {
        var fn = 'var jade=window.' + options.namespace + '; return anonymous(locals);'+ tmpl.toString();
        fn = new Function('locals', fn);

        callback(null, {
            filename: filename
          , fn: fn
        });
      } else {
        callback(new Error('Failed to compile'));
      }

    });    
  };
  
  async.map(options.files, getFile, function(err, files) {
    build(options, files, callback);
  })
}

var build = exports.build = function(options, files, callback) {

  var templates = {}, filename;
  files.forEach(function(template) {
    filename = template.filename.replace(options.root + '/', '')
    templates[filename] = template.fn;
  });
  
  var code = jade.runtime.escape.toString() +';'
  code += jade.runtime.attrs.toString().replace(/exports\./g, '') + ';'
  code += ' return attrs(obj);'

  var payload = new Expose();
  payload.expose({
      attrs: new Function('obj', code)
    , escape: jade.runtime.escape
    , dirname: utils.dirname
    , normalize: utils.normalize
    , render: render(options.namespace)
    , templates: templates
  }, options.namespace, 'output');
  
  // cache
  options.built = payload.exposed('output');
  
  if (options.minify) {
    var code = parser.parse(options.built);
    code = compiler.ast_mangle(code);
    code = compiler.ast_squeeze(code);
    options.minified = compiler.gen_code(code);
  }
  
  callback();
}
