var assert = require('assert')
  , resolve = require('path').resolve
  , Haproxy = require('haproxy')
  , Data = require('./lib/Data')
  , HaproxyManager = require('./lib/HaproxyManager')
  , HaproxyStats = require('./lib/HaproxyStats')
  , Api = require('./lib/Api')
  , pkg = require('./package.json')
  , MuxDemux = require('mux-demux')
  , split = require('split')
  , through = require('through')
  , crdt = require('crdt')
  , extend = require('extend')
  ;

module.exports = function Aqueduct (opts) {
  if (typeof opts !== 'object') opts = {};
  var self = this;
  var noop = function (){};
  var log = this.log = opts.log || noop;
  if (!opts.haproxySocketPath) opts.haproxySocketPath = '/tmp/haproxy.status.sock';

  // opt.persistence - file location or leveldb
  var data = new Data( {
    persistence: opts.persistence,
    log: log
  });

  assert(opts.haproxySocketPath, 'opts.haproxySocketPath required');

  var haproxy = new Haproxy(opts.haproxySocketPath, {
    config:  resolve(opts.haproxyCfgPath),
    pidFile: resolve(opts.haproxyPidPath),
    prefix: (opts.sudo) ? 'sudo' : undefined
  });

  var haproxyManager = new HaproxyManager({
    haproxy: haproxy,
    data: data,
    haproxyCfgPath: opts.haproxyCfgPath,
    templateFile: opts.templateFile,
    sudo: opts.sudo,
    log: log
  });

  var haproxyStats = new HaproxyStats({
    haproxy: haproxy,
    data: data,
    log: log
  });

  var api = new Api({
    data: data,
    haproxyManager: haproxyManager,
    log: log
  });

  var me = {
    "name": "aqueduct",
    "version": "1.0.0",
    "host": "172.17.42.1",
    "port": 10000,
    "id": "/aqueduct/1.0.0/172.17.42.1/10000"
  };


  // Wire up stats to write to stats db
  haproxyStats.on('stat', function (statObj) {
    if (statObj.type === 'frontend') {
      data.setFrontendStat(statObj);
    }
    else if (statObj.type === 'backend') {
      data.setBackendStat(statObj);
    }
    else if (statObj.type === 'backendMember') {
      data.setBackendMemberStat(statObj);
    }
  });

  // Wire up haproxy changes to write to activity db
  haproxyManager.on('configChanged', function (statObj) {
    var activityObj = { type: 'activity',  time: Date.now(), verb: 'haproxyConfigChanged', object: me.id };
    log('debug', 'activity', activityObj);
  });

  haproxyManager.on('reloaded', function (statObj) {
    var activityObj = { type: 'activity',  time: Date.now(), verb: 'haproxyRestarted', object: me.id };
    log('debug', 'activity', activityObj);
  });

  this.service = me;
  this.data = data;
  this.haproxy = haproxy;
  this.haproxyManager = haproxyManager;
  this.haproxyStats = haproxyStats;
  this.apiRoutes = api.routes.bind(api);
  this.createStream = data.createStream.bind(data);
  this.createReadableStream = data.createReadableStream.bind(data);

  // Create a new MuxDemux stream for each browser client.
  this.createMuxStream = function () {
    var self = this;

    //wire up the pool server stream
    var aqueductStream = mx.createStream({ type: 'aqueduct', id: mx.id, service: self.service });
    aqueductStream.pipe(self.data.createReadableStream()).pipe(aqueductStream);

    // Used to keep track of this clients stats subscriptions
    var statSubscriptions = {};

    // wire up a control stream to receive messages from the client
    var controlStream = mx.createStream({ type: 'control' });
    controlStream.pipe(split()).on('data', function (line) {
      try {
        var msg = JSON.parse(line);
        if (msg[0] === 'statSubscribe') {
          statSubscriptions[msg[1]] = true;
          sendStatsForHostId(msg[1]);
        }
        else if (msg[0] === 'statUnsubscribe') {
          delete statSubscriptions[msg[1]];
        }
        else if (msg[0] === 'updateAqueductBackendVersion') {
          var p = msg[1].split('/');
          var host = p[3], port = p[4], key = msg[2], version = msg[3];

          var id = self.data.backendId(key);
          var row = self.data.backends.get(id);
          if (!row){
            self.log('debug', 'client requested version change for backend ' + key + ', but backend does not exist');
            return;
          }

          var backend = extend(true, {}, row.toJSON());
          backend.version = version;

          self.data.setBackend(backend);
        }
      } catch(err) {
        self.log('error', 'error parsing controlStream message ' + line, String(err));
      }
    });

    // wire up a stats stream to send realtime aqueduct stats to the client
    var statStream = mx.createWriteStream({ type: 'stat' });
    var statWriteListener = function (stat) {
      //we used to keep track of multiple haproxy servers which required
      //host id, keeping it here to not break clients
      stat.hostId = self.service.id;
      if (statSubscriptions[stat.hostId]) {
        statStream.write(stat);
      }
    };
    self.haproxyStats.on('stat', statWriteListener);

    function writeStatStream (data) {
      if (!statStream.destroyed) statStream.write(data);
    }

    // wire up an activity stream
    var activityStream = mx.createWriteStream({ type: 'activity' });
    var activityWriteListenery = function (activityObj) {
      activityStream.write(activityObj);
    };

    self.haproxyManager.on('configChanged', activityWriteListenery);
    self.haproxyManager.on('reloaded', activityWriteListenery);

    mx.on('end', function () {
      self.haproxyStats.removeListener('stat', statWriteListener);
      self.haproxyManager.removeListener('configChanged', activityWriteListenery);
      self.haproxyManager.removeListener('reloaded', activityWriteListenery);
      aqueductStream.destroy();
      statStream.destroy();
      activityStream.destroy();
      controlStream.destroy();
    });

    return mx;
  };
};
