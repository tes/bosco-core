'use strict';

/**
 * Core bosco libraries
 */

var _ = require('lodash');
var AppDirectory = require('appdirectory');
var async = require('async');
var events = require('events');
var fs = require('fs-extra');
var knox = require('knoxy');
var osenv = require('osenv');
var path = require('path');
var Progress = require('progress');
var prompt = require('prompt');
var request = require('request');
var semver = require('semver');
var sf = require('sf');
var util = require('util');
var ip = require('ip');

prompt.message = 'Bosco'.green;

function Bosco() {}
util.inherits(Bosco, events.EventEmitter);
module.exports = Bosco;

Bosco.prototype.init = function (options) {
  var self = this;

  self._defaults = {
    _defaultConfig: [__dirname, 'config/bosco.json'].join('/')
  };

  self.options = _.defaults(_.clone(options), self._defaults);

  // Load base bosco config from home folder unless over ridden with path
  self.options.configPath = options.configPath ? path.resolve(options.configPath) : self.findConfigFolder();
  self.options.configFile = options.configFile ? path.resolve(options.configFile) : [self.options.configPath, 'bosco.json'].join('/');
  self.options.defaultsConfigFile = [self.options.configPath, 'defaults.json'].join('/');

  // NVM presets
  if (self.options['system-node']) {
    self.options.nvmSh = '';
    self.options.nvmUse = '';
    self.options.nvmUseDefault = '';
    self.options.nvmWhich = '';
    self.options.nvmInstall = '';
  } else {
    self.options.nvmSh = '. ${NVM_DIR:-$HOME/.nvm}/nvm.sh && ';
    self.options.nvmUse = self.options.nvmSh + 'nvm use;';
    self.options.nvmUseDefault = self.options.nvmSh + 'nvm use default;';
    self.options.nvmWhich = self.options.nvmSh + 'nvm which';
    self.options.nvmInstall = self.options.nvmSh + 'nvm install';
  }

  self.options.cpus = require('os').cpus().length;
  self.options.ip = ip.address();
  self.options.inService = false;
  self.options.fileTypesWhitelist = ['js', 'css', 'img', 'html', 'swf', 'fonts', 'pdf', 'json'];

  self.config = require('nconf');
  self.prompt = prompt;
  self.Progress = Progress;
  self.errorStack = [];

  self.concurrency = {
    network: self.options.cpus * 4, // network constrained
    cpu: (self.options.cpus - 1) || 1 // cpu constrained
  };

  events.EventEmitter.call(this);
};

Bosco.prototype.run = function (options) {
  var self = this;

  if (!self.options && !options) {
    return self.console.log('You must call init(options) first, or supply options to run()');
  }

  if (options) self.init(options);

  self._init(function (err) {
    self._checkVersion();

    if (err) return self.console.log(err);

    // Workspace found by reverse lookup in config - github team >> workspace.
    self.options.workspace = self.findWorkspace();
    self.options.workspaceConfigPath = [self.options.workspace, '.bosco'].join('/');

    // Environment config files are only ever part of workspace config
    self.options.envConfigFile = [self.options.workspaceConfigPath, self.options.environment + '.json'].join('/');

    // Now load the environment specific config
    self.config.add('env-override', { type: 'file', file: self.options.envConfigFile });

    var aws = self.config.get('aws');
    if (aws && aws.key) {
      self.knox = knox.createClient({
        key: aws.key,
        secret: aws.secret,
        bucket: aws.bucket,
        region: aws.region
      });
    }

    self.staticUtils = require('./src/StaticUtils')(self);

    self.checkInService();

    var teamDesc = self.getTeam();
    self.log(
      'Initialised using [' + self.options.configFile.magenta + '] '
      + 'in environment [' + self.options.environment.green + '] '
      + (teamDesc ? 'with team [' + teamDesc.cyan + ']' : 'without a team!'.red)
    );
    self._cmd();
  });
};

Bosco.prototype._init = function (next) {
  var self = this;

  function loadConfig() {
    self.config.env()
      .file({
        file: self.options.configFile
      })
      .file('defaults', {
        file: self.options.defaultsConfigFile
      });
  }

  self._checkConfig(function (err, initialise) {
    if (err) return;

    loadConfig();

    if (initialise) {
      self._initialiseConfig(function (err) {
        if (err) return;
        next();
      });
    } else if (!self.config.get('github:user')) {
      self.error('It looks like you are in a micro service folder or something is wrong with your config?\n');
      next('Exiting - no available github configuration.');
    } else {
      next();
    }
  });
};

Bosco.prototype._checkConfig = function (next) {
  var self = this;
  var defaultConfig = self.options._defaultConfig;
  var configPath = self.options.configPath;
  var configFile = self.options.configFile;

  function checkConfigPath(cb) {
    if (self.exists(configPath)) return cb();
    fs.mkdirp(configPath, cb);
  }

  function checkConfig(cb) {
    if (self.exists(configFile)) return cb();

    prompt.start();
    prompt.get({
      properties: {
        confirm: {
          description: 'This looks like the first time you are using Bosco, do you want to create a new configuration file in your home folder (y/N)?'.white
        }
      }
    }, function (err, result) {
      if (!result || (result.confirm !== 'Y' && result.confirm !== 'y')) {
        return cb({
          message: 'Did not confirm'
        });
      }

      var content = fs.readFileSync(defaultConfig);
      fs.writeFileSync(configFile, content);
      cb(null, true);
    });
  }

  async.series([checkConfigPath, checkConfig], function (err, result) {
    next(err, result[1]);
  });
};

Bosco.prototype._initialiseConfig = function (next) {
  var self = this;
  prompt.start();

  prompt.get({
    properties: {
      githubUser: {
        description: 'Enter your github user name'.white
      },
      authToken: {
        description: 'Enter the auth token (see: https://github.com/blog/1509-personal-api-tokens)'.white
      }
    }
  }, function (err, result) {
    if (err) {
      return self.error('There was an error during setup: ' + err.message.red);
    }
    self.config.set('github:user', result.githubUser);
    self.config.set('github:authToken', result.authToken);
    self.console.log('\r');
    self.config.save(next);
  });
};

Bosco.prototype._cmd = function () {
  var self = this;
  var args = self.options.args;
  var command = args.shift();
  self.command = command;
  var globalCommandModule = [self.getGlobalCommandFolder(), command, '.js'].join('');
  var localCommandModule = [self.getLocalCommandFolder(), command, '.js'].join('');
  var commandModule;
  var module;

  if (self.exists(localCommandModule)) {
    commandModule = localCommandModule;
  }

  if (self.exists(globalCommandModule)) {
    if (commandModule) {
      self.warn('global command ' + globalCommandModule + ' overriding local command ' + localCommandModule);
    }
    commandModule = globalCommandModule;
  }

  if (commandModule) {
    module = require(commandModule);
  }

  if (module) {
    if (module.requiresNvm && !self.hasNvm()) {
      self.error('You must have nvm >= 0.21.0 installed to use this command, https://github.com/creationix/nvm');
      return process.exit(1);
    }

    return module.cmd(self, args, function (err) {
      var code = 0;
      if (err) {
        code = 1;
        if (err.code > 0) code = err.code;
      }
      process.exit(code);
    });
  }

  if (self.options.shellCommands) return self._shellCommands();

  self.options.program.showHelp();
};

Bosco.prototype._shellCommands = function () {
  var self = this;
  var cmdPath = self.getGlobalCommandFolder();
  var localPath = self.getLocalCommandFolder();

  function showCommands(cPath, files, next) {
    var cmdString = '';
    files.forEach(function (file) {
      cmdString += file.replace('.js', '') + ' ';
    });
    next(null, cmdString.split(' '));
  }

  async.series([
    function (next) {
      fs.readdir(cmdPath, function (err, files) {
        showCommands(cmdPath, files, next);
      });
    },
    function (next) {
      fs.readdir(localPath, function (err, files) {
        if (!files || files.length === 0) return next();
        showCommands(localPath, files, next);
      });
    }
  ],
  function (err, files) {
    var flatFiles = _.uniq(_.flatten(files));
    self.console.log('Available commands: ' + flatFiles.join(' '));
    process.exit(0);
  });
};

Bosco.prototype._checkVersion = function () {
  // Check the version in the background
  var self = this;
  self._checkingVersion = true;
  var npmUrl = 'http://registry.npmjs.org/bosco';
  request({
    url: npmUrl,
    timeout: 1000
  }, function (error, response, body) {
    if (!error && response.statusCode === 200) {
      var jsonBody = JSON.parse(body);
      var version = jsonBody['dist-tags'].latest;
      if (semver.lt(self.options.version, version)) {
        self.error('There is a newer version (Local: ' + self.options.version.yellow + ' < Remote: ' + version.green + ') of Bosco available, you should upgrade!');
        if (self.config.get('ensureLatestVersion')) {
          self.error("Bosco is not up to date - exiting. Please upgrade Bosco or disable the 'ensureLatestVersion' option to continue.");
          process.exit(1);
        }
        self.console.log('\r');
      }
    }
    self._checkingVersion = false;
  });
};

Bosco.prototype.findHomeFolder = function () {
  return osenv.home();
};

Bosco.prototype.findConfigFolder = function () {
  var platform = process.platform;
  var oldConfig = [osenv.home(), '.bosco'].join('/');

  if (platform === 'darwin' || platform === 'win32') {
    var env = process.env;
    if (!env.XDG_CONFIG_HOME || !env.XDG_DATA_HOME || !env.XDG_CACHE_HOME) {
      return oldConfig;
    }
    platform = 'xdg';
  }

  var dirs = new AppDirectory({
    platform: platform,
    appName: 'bosco',
    appAuthor: 'tes'
  });
  var newConfig = dirs.userConfig();

  this._migrateConfig(oldConfig, newConfig);

  return newConfig;
};

// TODO(geophree): remove this after a while (added 2015-09-26)
Bosco.prototype._migrateConfig = function (oldConfig, newConfig) {
  var self = this;
  if (!self.exists(oldConfig)) return null;

  var oldConfigWarning = 'You still have an old config directory at ' + oldConfig.red + ' that you should remove.';

  if (self.exists(newConfig)) return self.warn(oldConfigWarning);

  fs.mkdirpSync(newConfig);
  fs.copySync(oldConfig, newConfig, { clobber: true });

  self.warn('Your configuration has been copied to ' + newConfig.red);
  self.warn(oldConfigWarning);
};

Bosco.prototype.findWorkspace = function () {
  for (var p = path.resolve('.'); ; p = path.resolve(p, '..')) {
    if (this.exists(path.join(p, '.bosco'))) return p;
    if (p === '/') break;
  }
  return path.resolve('.');
};

Bosco.prototype.getWorkspacePath = function () {
  var self = this;
  return self.options.workspace;
};

Bosco.prototype.getTeam = function () {
  var self = this;
  var teamConfig = self.config.get('teams');
  var currentTeam = null;
  _.keys(teamConfig).forEach(function (team) {
    if (self.options.workspace.indexOf(teamConfig[team].path) >= 0) {
      currentTeam = team;
    }
  });
  return currentTeam;
};

Bosco.prototype.getRepos = function () {
  var self = this;
  var team = self.getTeam();
  if (!team) {
    return [path.relative('..', '.')];
  }
  return self.config.get('teams:' + team).repos;
};

Bosco.prototype.getOrg = function () {
  var self = this;
  var teamConfig = self.config.get('teams');
  var currentOrg = '';
  _.keys(teamConfig).forEach(function (team) {
    if (self.options.workspace.indexOf(teamConfig[team].path) >= 0) {
      currentOrg = team.split('/')[0];
    }
  });
  return currentOrg;
};

Bosco.prototype.getOrgPath = function () {
  return path.resolve(this.getWorkspacePath());
};

Bosco.prototype.getRepoPath = function (repo) {
  var self = this;
  // Strip out / to support full github references
  var repoName;
  if (repo.indexOf('/') < 0) {
    repoName = repo;
  } else {
    repoName = repo.split('/')[1];
  }

  var isRepoCurrentService = (self.options.inService && repo === self.options.inServiceRepo);
  var repoPath = isRepoCurrentService
    ? path.resolve('.')
    : [path.resolve(this.getWorkspacePath()), repoName].join('/');
  return repoPath;
};

// Additional exports
Bosco.prototype.getGlobalCommandFolder = function () {
  return [__dirname, '/', 'commands', '/'].join('');
};

Bosco.prototype.getLocalCommandFolder = function () {
  var self = this;
  var workspace = self.options && self.options.workspace ? self.options.workspace : self.findWorkspace();
  return [workspace, '/', 'commands', '/'].join('');
};

Bosco.prototype.getRepoUrl = function (repo) {
  var org;
  var host = this.config.get('github:hostname') || 'github.com';
  var hostUser = this.config.get('github:hostUser') || 'git';
  host = hostUser + '@' + host + ':';

  if (repo.indexOf('/') < 0) {
    org = this.getOrg() + '/';
  }
  return [host, org || '', repo, '.git'].join('');
};

Bosco.prototype.isLocalCdn = function () {
  return !this.config.get('aws:cdn');
};

Bosco.prototype.getCdnUrl = function () {
  if (!this.isLocalCdn()) {
    return this.config.get('aws:cdn');
  }

  var cdnPort = this.config.get('cdn:port') || '7334';
  return this.config.get('cdn:url') || 'http://localhost:' + cdnPort;
};

Bosco.prototype.getBaseCdnUrl = function () {
  var baseUrl = this.getCdnUrl();

  if (baseUrl.substr(-1) === '/') {
    baseUrl = baseUrl.substr(0, baseUrl.length - 1);
  }

  if (!this.isLocalCdn()) {
    baseUrl += '/' + this.options.environment;
  }

  return baseUrl;
};

Bosco.prototype.getAssetCdnUrl = function (assetUrl) {
  var url = assetUrl;

  if (assetUrl.substr(0, 1) === '/') {
    url = assetUrl.substr(1);
  }

  return this.getBaseCdnUrl() + '/' + url;
};

Bosco.prototype.getRepoName = function () {
  var self = this;
  var repoName = path.relative('..', '.');
  var packagePath = path.resolve('package.json');
  if (self.exists(packagePath)) {
    var requiredPackage = require(packagePath);
    if (requiredPackage.name) {
      repoName = requiredPackage.name;
    }
  }
  var boscoServicePath = path.resolve('bosco-service.json');
  if (self.exists(boscoServicePath)) {
    var boscoService = require(boscoServicePath);
    if (boscoService.service && boscoService.service.name) {
      repoName = boscoService.service.name;
    }
  }
  return repoName;
};

Bosco.prototype.checkInService = function () {
  var self = this;
  var cwd = path.resolve('bosco-service.json');
  if (self.exists(cwd) && self.options.service) {
    self.options.inService = true;
    self.options.inServiceRepo = self.getRepoName();
    // Replace getRepos
    self.getRepos = function () {
      return [self.getRepoName()];
    };
  }
};

Bosco.prototype.warn = function (msg, args) {
  this._log('Bosco'.yellow, msg, args);
};

Bosco.prototype.log = function (msg, args) {
  this._log('Bosco'.cyan, msg, args);
};

Bosco.prototype.error = function (msg, args) {
  if (this.errorStack) { this.errorStack.push({ msg: msg, args: args }); }
  this._log('Bosco'.red, msg, args);
};

Bosco.prototype.logErrorStack = function () {
  if (this.errorStack.length === 0) return;
  this._log('Bosco'.red, 'These are all the errors that you may have missed:');
  var self = this;
  this.errorStack.forEach(function (err) {
    self._log('Bosco'.red, err.msg, err.args);
  });
};

Bosco.prototype._log = function (identifier, msg, args) {
  var parts = {
    identifier: identifier,
    time: new Date(),
    message: args ? sf(msg, args) : msg
  };
  if (this.options && !this.options.quiet) {
    this.console.log(sf('[{time:hh:mm:ss}] {identifier}: {message}', parts));
  }
};

Bosco.prototype.console = global.console;
Bosco.prototype.process = global.process;

Bosco.prototype.exists = function (checkPath) {
  return fs.existsSync(checkPath);
};

Bosco.prototype.hasNvm = function () {
  if (this.options['system-node']) {
    return true;
  }

  var nvmDir = process.env.NVM_DIR || '';
  var homeNvmDir = process.env.HOME ? path.join(process.env.HOME, '.nvm') : '';

  var hasNvm = (nvmDir && this.exists(path.join(nvmDir, 'nvm.sh')))
    || (homeNvmDir && this.exists(path.join(homeNvmDir, 'nvm.sh')));

  if (!hasNvm) {
    this.error('Could not find nvm');
  }

  return hasNvm;
};
